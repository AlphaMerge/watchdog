/**
 * The PowerShell wrapper and what comes back from it (`T-09`).
 *
 * **Pure, and separate from spawning anything**, because every hard decision in the Windows
 * transport lives here and none of them needs a process to test. PowerShell is a shell that was
 * designed for people, and a check is not a person: it prints banners, it writes warnings to the
 * stream a reading is on, it exits `0` after an error, and it reshapes a one-element list into a
 * bare object. Each of those turns into a wrong number rather than a failed check, which is the
 * failure this file exists to make impossible.
 */

export class WindowsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WindowsError';
  }
}

/**
 * What the wrapper prints its answer behind.
 *
 * The same argument as `P-03`'s result marker, for a stronger reason: a PowerShell profile is
 * allowed to print, a module prints a loading banner, `Write-Host` goes to the host rather than
 * the pipeline, and an operator's own snippet may `echo` on the way past. Anything before the
 * marker is somebody talking; the answer is the last line that starts with it.
 */
export const RESULT_MARKER = '<<<ms-result>>>';

/** The environment variables the wrapper reads a credential out of. Never argv — see below. */
export const ENV_HOST = 'MS_WIN_HOST';
export const ENV_USER = 'MS_WIN_USER';
export const ENV_PASSWORD = 'MS_WIN_PASSWORD';
export const ENV_AUTH = 'MS_WIN_AUTH';

export interface ScriptOptions {
  /**
   * The machine to run against, or empty for this one.
   *
   * Empty is the probe's own box and matters more than it looks: a Windows probe monitoring
   * itself needs no session, no credential and no WinRM configuration at all, which is the
   * arrangement most installations start with.
   */
  readonly host: string;
  /** How deep `ConvertTo-Json` walks. See the note on `-Depth` below. */
  readonly depth?: number;
}

/** Deep enough for a CIM instance with nested settings, shallow enough to stay a reading. */
const DEFAULT_DEPTH = 6;

/**
 * Wraps a snippet so that whatever happens, one parseable line comes back.
 *
 * Every line of the preamble is load-bearing:
 *
 * - **`$ErrorActionPreference = 'Stop'`.** PowerShell's default is `Continue`: a failed
 *   `Get-CimInstance` writes to the error stream, the script carries on, and the process exits
 *   `0`. A transport that trusted the exit code would report the *previous* shape of the data,
 *   or an empty one, as a successful reading.
 * - **`$ProgressPreference = 'SilentlyContinue'`.** Progress records are written to the host and
 *   land in stdout when it is a pipe, in the middle of the JSON.
 * - **The output encoding.** Windows PowerShell 5.1 writes in the console code page, so a volume
 *   label or a service display name with a non-ASCII character arrives as mojibake — and, worse,
 *   silently: the JSON still parses.
 * - **`try`/`catch` into a fixed envelope.** The error's message *and* its category, because
 *   "Access is denied" and "The WinRM client cannot process the request" send an operator to
 *   completely different places, and the category is what distinguishes an authentication
 *   failure from a machine that is not listening.
 * - **`-Depth`.** `ConvertTo-Json` defaults to 2 and does not fail when it runs out: it replaces
 *   the rest of the object with its type name. A path that reached a field yesterday returns the
 *   string `System.Object[]` today, which parses, which is the whole problem.
 * - **`-Compress`.** One line, so the marker is enough to find it.
 */
export function buildScript(body: string, options: ScriptOptions): string {
  const depth = options.depth ?? DEFAULT_DEPTH;
  const session = options.host.trim() === '' ? '' : SESSION;
  return `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }
$MsSession = $null
try {
${session}
  $MsData = & {
${indent(body)}
  }
  $MsOut = [ordered]@{ ok = $true; data = $MsData }
} catch {
  $MsOut = [ordered]@{
    ok = $false
    error = $_.Exception.Message
    category = [string]$_.CategoryInfo.Category
    type = $_.Exception.GetType().FullName
  }
} finally {
  if ($MsSession) { Remove-CimSession -CimSession $MsSession -ErrorAction SilentlyContinue }
}
Write-Output ('${RESULT_MARKER}' + ($MsOut | ConvertTo-Json -Compress -Depth ${String(depth)}))
`;
}

/**
 * Opening the session, and why the credential arrives in the environment.
 *
 * **Not on the command line.** On Windows any user can read another process's command line
 * through WMI's `Win32_Process.CommandLine`; on POSIX it is `/proc/<pid>/cmdline` and world
 * readable. A monitoring service holds the credentials for every Windows machine in the estate,
 * so a password in argv is that whole set readable by anybody with a session on the probe. The
 * environment is per-process and readable only by the same user or by something already
 * privileged enough not to need it — the same reasoning as `T-19`'s "request on stdin, never
 * argv", one rung further along.
 *
 * **Not in the script text either**, which would be the obvious alternative given the script
 * already arrives on stdin. A script is echoed by a transcript, logged by module logging, and
 * written to disk by `Start-Transcript` if a group policy turned it on — all three of which an
 * operator may have enabled for reasons that have nothing to do with us.
 */
const SESSION = `  if ($env:${ENV_USER}) {
    $MsSecret = ConvertTo-SecureString $env:${ENV_PASSWORD} -AsPlainText -Force
    $MsCred = New-Object System.Management.Automation.PSCredential($env:${ENV_USER}, $MsSecret)
    $MsOption = New-CimSessionOption -Protocol Wsman
    $MsSession = New-CimSession -ComputerName $env:${ENV_HOST} -Credential $MsCred \`
      -Authentication $env:${ENV_AUTH} -SessionOption $MsOption
  } else {
    $MsSession = New-CimSession -ComputerName $env:${ENV_HOST}
  }`;

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => (line.trim() === '' ? line : `    ${line}`))
    .join('\n');
}

/** What the wrapper reports back, once the envelope is off. */
export type Envelope =
  | { readonly ok: true; readonly data: unknown }
  | {
      readonly ok: false;
      readonly error: string;
      readonly category: string;
      readonly type: string;
    };

/**
 * Finds the answer in whatever the interpreter printed.
 *
 * **The last marked line, not the first.** A snippet is allowed to print — an operator debugging
 * one will — and so is a module. Taking the first would let anything that printed a plausible
 * line ahead of the real answer decide what this sensor reports.
 */
export function readEnvelope(stdout: string): Envelope {
  let found: string | null = null;
  for (const line of stdout.split('\n')) {
    const at = line.indexOf(RESULT_MARKER);
    if (at >= 0) found = line.slice(at + RESULT_MARKER.length).trim();
  }
  if (found === null) {
    throw new WindowsError(
      'PowerShell printed no result line — the interpreter started and the script did not ' +
        `finish${quote(stdout)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(found) as unknown;
  } catch (error) {
    throw new WindowsError(
      `PowerShell's result line is not JSON: ${error instanceof Error ? error.message : 'unknown'}` +
        quote(found),
    );
  }
  if (!isRecord(parsed)) {
    throw new WindowsError(`PowerShell's result line is not an object${quote(found)}`);
  }

  if (parsed['ok'] === true) return { ok: true, data: parsed['data'] };
  return {
    ok: false,
    error: asText(parsed['error']) || 'PowerShell reported an error and gave no message',
    category: asText(parsed['category']),
    type: asText(parsed['type']),
  };
}

/**
 * A list, whatever `ConvertTo-Json` decided to make of it.
 *
 * **The single-object trap, and it is the sharpest edge in this transport.** `ConvertTo-Json`
 * serialises one object as an object and two as an array — `@(...)` does not help, and
 * `-AsArray` exists only in PowerShell 7, while 5.1 is what is actually installed on a Windows
 * Server. So a volume sensor written against a machine with two disks works, and the same sensor
 * on a machine with one disk reads a bare object where it expected a list. Every caller goes
 * through here rather than each of them meeting it once.
 *
 * `null` becomes an empty list, because a query that matched nothing is a result of none — the
 * caller decides whether that is a gap or a failure, which is not a decision this function has
 * the context to make.
 */
export function asRows(data: unknown): Record<string, unknown>[] {
  if (data === null || data === undefined) return [];
  const list = Array.isArray(data) ? (data as unknown[]) : [data];
  return list.filter(isRecord);
}

/** A PowerShell number that arrived as a string, a `null`, or already a number. */
export function numberFrom(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function quote(text: string): string {
  const trimmed = text.trim();
  return trimmed === '' ? '' : ` — it printed "${trimmed.slice(0, 300).replace(/\n/g, '\\n')}"`;
}
