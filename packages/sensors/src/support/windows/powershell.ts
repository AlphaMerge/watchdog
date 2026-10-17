import { platform } from 'node:os';
import { abortReason, endedHow } from '../program-ended.js';
import {
  ENV_AUTH,
  ENV_HOST,
  ENV_MATCH,
  ENV_PASSWORD,
  ENV_USER,
  WindowsError,
  buildScript,
  readEnvelope,
  type Envelope,
  type WindowsPhase,
} from './envelope.js';

/**
 * Running PowerShell, bounded (`T-09`).
 *
 * **`-EncodedCommand`, and that was a correction.** The obvious way to hand a script to
 * PowerShell without putting it in argv is `-Command -`, which reads stdin — and it is what this
 * transport did until a real `pwsh` was pointed at it. On PowerShell 7 `-Command -` reads stdin
 * as *interactive input*: the multi-line `try`/`catch` this wrapper is built around produced
 * **no output at all and exit code 0**, which the transport would have reported as "the script
 * did not finish" for ever. `-File -` is worse: it opens a REPL and echoes `>>` prompts.
 * `-EncodedCommand` takes base64 of UTF-16LE and behaves identically on 5.1 and 7.
 *
 * Putting the script in argv is fine and the earlier reasoning against it was misapplied: **the
 * script is not the secret**. It contains `$env:MS_WIN_PASSWORD`, not a password — the credential
 * still travels in the environment, where a process listing cannot reach it. What a command line
 * exposes here is which CIM class this sensor asks about, which is not worth protecting.
 *
 * **A shell-out rather than a WinRM client written here, and `ADR-001` left that open.** Its
 * question 3 asks whether v1 needs an in-house WinRM client or whether a PowerShell shell-out
 * from a Windows-hosted probe is enough. It is enough, and the reason is what a client would
 * cost: WS-Management is SOAP over HTTP whose only widely-permitted authentication is NTLMv2 or
 * Kerberos — Basic requires an operator to turn on `AllowUnencrypted` or put a certificate on
 * every machine, which most estates forbid outright. Writing NTLMv2 with message signing and
 * sealing is a cryptographic implementation, in v1, to reach machines a Windows probe already
 * reaches with a supported client. `CAPABILITIES.MD §3.5` says the same thing in one line.
 *
 * **A Windows probe is a real constraint and it is stated rather than worked around.** One
 * Windows probe monitors many Windows machines — `Get-CimInstance -CimSession` is WinRM, so the
 * probe does not have to be on the box it measures — but a Linux-only installation cannot
 * monitor Windows at all. That is a deployment fact an operator should meet as a clear message,
 * not as `spawn powershell ENOENT`, which is why this refuses early and says so.
 *
 * **No pool, and that is why `P-24` should not wait for this ticket.** `P-24` is written as
 * "extract the pool at the third transport, when the shape is known", with `T-09` named as the
 * third. It is not: a shell-out has no session to keep. The two pools are still two.
 */

/** Set by the probe from `probe.powerShellPath`; empty means "work it out". */
export const POWERSHELL_ENV = 'MS_POWERSHELL';

/** How much of PowerShell's chatter is worth keeping when something goes wrong. */
const MAX_OUTPUT_BYTES = 512 * 1024;

/**
 * Windows caps a command line at 32,767 characters, and this leaves room for the rest of argv.
 *
 * The wrapper plus a sensor's query is under two kilobytes, so this is a bound rather than a
 * constraint — but a bound with a message, because a snippet that grows past it would otherwise
 * fail as whatever the operating system says about an over-long command line.
 */
const MAX_ENCODED_LENGTH = 32_000;

/**
 * Authentication schemes `New-CimSession` accepts, and what they mean here.
 *
 * `Default` is negotiate — Kerberos where a domain answers, NTLM where it does not — and is what
 * a domain-joined estate wants. `Negotiate` says the same thing explicitly. `Kerberos` refuses
 * to fall back, which is what a hardened estate wants and what turns a silent downgrade into a
 * failed check. `Basic` is here because a workgroup machine with a certificate is a real
 * arrangement, and `CredSSP` is not: it delegates the credential to the far end, so a
 * compromised monitored machine gets the account that reaches every other one.
 */
export const AUTHENTICATIONS = ['Default', 'Negotiate', 'Kerberos', 'Basic'] as const;
export type Authentication = (typeof AUTHENTICATIONS)[number];

/**
 * How long PowerShell is given to end on `SIGTERM` before `SIGKILL` (`P-262`).
 *
 * **Under the pool's abort grace.** A Windows check runs in a pool worker. At its timeout the
 * pool aborts it and, `probe.checkAbortGraceMs` later (2 s by default), terminates the worker if
 * it has not answered — and `runProgram`'s `SIGKILL` timer lives in that worker, so with its
 * default 5 s a PowerShell that ignored `SIGTERM` was left running in a process group nobody
 * would end. One second is half the default, as `SCRIPT_GRACE_MS` is of the process runner's
 * margin. Not read from the setting: the worker is not told it. The setting is held above it
 * instead — the probe refuses a `checkAbortGraceMs` under `CHECK_ABORT_GRACE_MIN_MS`, which is
 * `WORKER_PROGRAM_GRACE_MAX_MS` and half a second (`P-267`), and a test holds this to that.
 */
export const POWERSHELL_GRACE_MS = 1_000;

export interface PowerShellOptions {
  /** Empty runs on this machine — a Windows probe measuring itself. */
  readonly host: string;
  readonly timeoutMs: number;
  readonly credential?: {
    readonly username: string;
    readonly password: string;
    readonly authentication?: Authentication;
  };
  readonly depth?: number;
  /** A value the snippet reads as `$env:MS_WIN_MATCH` rather than finding in its text (`S-21`). */
  readonly match?: string;
  /** The check's scrub, applied to what PowerShell printed before it is cut (`S-21`). */
  readonly scrub?: (text: string) => string;
  /**
   * The check's `ctx.signal` (`P-262`). PowerShell is ended on it as on `timeoutMs`, whichever
   * comes first: a pool worker's abort would otherwise leave it running to its own timeout, and a
   * terminated worker would leave it running in a process group of its own.
   */
  readonly signal?: AbortSignal;
}

export interface PowerShellRun {
  readonly data: unknown;
  readonly durationMs: number;
}

/**
 * Runs one snippet and returns what it produced, or throws with enough to act on.
 *
 * The snippet is written against `$MsSession`, which is a CIM session to `host` when there is
 * one and `$null` when the target is this machine — so a sensor is one query and does not repeat
 * the session dance.
 */
export async function runPowerShell(
  snippet: string,
  options: PowerShellOptions,
): Promise<PowerShellRun> {
  const { runProgram } = await import('@ms/shared');
  const file = interpreter();

  const environment: Record<string, string> = {
    // The whole environment, not a patch: `runProgram` is explicit about this, and a monitoring
    // service's environment holds a database URL and whatever else arrived through `MS_*`.
    // PowerShell needs almost nothing, and what it does need is spelt out.
    SystemRoot: process.env['SystemRoot'] ?? '',
    windir: process.env['windir'] ?? '',
    PATHEXT: process.env['PATHEXT'] ?? '',
    PATH: process.env['PATH'] ?? '',
    [ENV_HOST]: options.host,
  };
  if (options.credential !== undefined && options.credential.username !== '') {
    environment[ENV_USER] = options.credential.username;
    environment[ENV_PASSWORD] = options.credential.password;
    environment[ENV_AUTH] = options.credential.authentication ?? 'Default';
  }
  if (options.match !== undefined) environment[ENV_MATCH] = options.match;

  const script = buildScript(snippet, {
    host: options.host,
    ...(options.depth === undefined ? {} : { depth: options.depth }),
  });
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  // Where each failure was (`P-406`). PowerShell that could not be run is this probe's own
  // failure, so it names no machine; once it ran, it was running for `host`.
  const local = { phase: 'exec' } as const;
  const ran = { phase: 'exec', host: options.host } as const;
  if (encoded.length > MAX_ENCODED_LENGTH) {
    throw new WindowsError(
      `this check's script encodes to ${String(encoded.length)} characters and Windows caps a ` +
        `command line at ${String(MAX_ENCODED_LENGTH)}`,
      local,
    );
  }

  const scrub = options.scrub ?? ((text: string): string => text);
  const run = await runProgram({
    file,
    args: ['-NoProfile', '-NonInteractive', '-NoLogo', '-EncodedCommand', encoded],
    cwd: process.cwd(),
    env: environment,
    timeoutMs: options.timeoutMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    graceMs: POWERSHELL_GRACE_MS,
    maxOutputBytes: MAX_OUTPUT_BYTES,
  });

  if (run.outcome === 'failed') {
    throw new WindowsError(
      `${file} could not be started: ${run.message} (${run.code}) — a Windows check needs ` +
        'PowerShell on the probe, so this probe must be running on Windows, or have ' +
        `PowerShell 7 installed and \`probe.powerShellPath\` pointing at it`,
      local,
    );
  }
  if (run.outcome === 'timeout') {
    const how = endedHow(run.hardKilled, POWERSHELL_GRACE_MS);
    throw new WindowsError(
      run.endedBy === 'signal' && options.signal !== undefined
        ? `PowerShell was still running after ${String(run.endedAfterMs)} ms when the check was ` +
            `ended (${abortReason(options.signal)}), and was ${how}${tail(scrub(run.stderr))}`
        : `PowerShell was still running after ${String(options.timeoutMs)} ms and was ` +
            `${how}${tail(scrub(run.stderr))}`,
      ran,
    );
  }
  if (run.outcome === 'signalled') {
    throw new WindowsError(`PowerShell was killed by ${run.signal}${tail(scrub(run.stderr))}`, ran);
  }
  if (run.truncated) {
    throw new WindowsError(
      `PowerShell printed more than ${String(MAX_OUTPUT_BYTES)} bytes — a reading parsed out of ` +
        'a truncated stream is worse than no reading',
      ran,
    );
  }

  // The envelope before the exit code, deliberately. A script that caught its own error exits 0
  // with `ok: false` and a diagnosis in it; a non-zero exit with no envelope is the interpreter
  // itself failing, and its stderr is all there is to say why.
  let envelope: Envelope;
  try {
    envelope = readEnvelope(run.stdout, scrub);
  } catch (error) {
    if (run.code !== 0) {
      throw new WindowsError(
        `PowerShell exited with code ${String(run.code)}${tail(scrub(run.stderr)) || tail(scrub(run.stdout))}`,
        ran,
      );
    }
    // The envelope's words, and the machine they were about.
    throw error instanceof WindowsError ? new WindowsError(error.message, ran, error) : error;
  }

  if (!envelope.ok) {
    throw new WindowsError(
      describe(envelope.category, options) + envelope.error + ` [${envelope.category}]`,
      { phase: phaseOf(envelope.category), host: options.host },
    );
  }
  return { data: envelope.data, durationMs: run.durationMs };
}

/**
 * Where PowerShell is.
 *
 * `probe.powerShellPath` wins, because an operator with PowerShell 7 somewhere unusual should
 * not have to argue with a default. Otherwise the platform decides: `powershell.exe` on Windows,
 * which is 5.1 and present on every Windows Server since 2012 R2, and `pwsh` elsewhere — which
 * will start, and will then fail on the first CIM cmdlet, because `CimCmdlets` is Windows-only.
 * That failure is a clear message from PowerShell itself rather than a missing binary, which is
 * the better of the two things to show an operator who has put a Windows sensor on a Linux
 * probe.
 */
function interpreter(): string {
  const declared = (process.env[POWERSHELL_ENV] ?? '').trim();
  if (declared !== '') return declared;
  return platform() === 'win32' ? 'powershell.exe' : 'pwsh';
}

/**
 * A sentence in front of PowerShell's own message, where the category earns one.
 *
 * PowerShell's WinRM errors are accurate and unreadable — "The WinRM client cannot process the
 * request" is the same string whether the machine is off, the firewall is closed, or WinRM was
 * never enabled. The category is what separates them, and naming the likely cause is the
 * difference between a ticket somebody can act on and one that gets forwarded.
 */
function describe(category: string, options: PowerShellOptions): string {
  const where = options.host === '' ? 'this probe' : options.host;
  if (category === 'AuthenticationError' || category === 'PermissionDenied') {
    return (
      `the Windows credential was refused by ${where} — the account must be in Administrators ` +
      'or in the Remote Management Users group, and a local account on a workgroup machine ' +
      'also needs LocalAccountTokenFilterPolicy: '
    );
  }
  if (category === 'ConnectionError' || category === 'ResourceUnavailable') {
    return (
      `${where} did not answer on WinRM — \`winrm quickconfig\` on that machine, and port ` +
      '5985 (or 5986 for HTTPS) open to this probe: '
    );
  }
  if (category === 'ObjectNotFound') {
    return `${where} answered, and what this sensor asked for is not there: `;
  }
  return '';
}

/**
 * Where PowerShell's own error says the check failed, from its category: the ones `describe`
 * gives a sentence to, and the query for the rest, since the snippet is one query.
 */
function phaseOf(category: string): WindowsPhase {
  if (category === 'AuthenticationError' || category === 'PermissionDenied') return 'authenticate';
  if (category === 'ConnectionError' || category === 'ResourceUnavailable') return 'connect';
  return 'query';
}

function tail(text: string): string {
  const trimmed = text.trim();
  return trimmed === '' ? '' : `: ${trimmed.slice(0, 400)}`;
}
