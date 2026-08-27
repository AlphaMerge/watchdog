import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CheckContext } from '../src/contract.js';
import {
  POWERSHELL_ENV,
  RESULT_MARKER,
  WindowsError,
  asRows,
  buildScript,
  numberFrom,
  readEnvelope,
  runPowerShell,
  windowsOptions,
  type PowerShellRun,
} from '../src/support/windows/index.js';
import { installFakePowerShell } from './support/fake-powershell.js';

/**
 * The Windows transport (`T-09`).
 *
 * **What this can and cannot prove, stated up front.** The pure half — the wrapper, the envelope,
 * the single-object trap — is proved outright. The process half is proved against a fake
 * PowerShell, which is honest about exactly the things a mock could not be: that the script goes
 * to stdin, that the password goes to the environment and to neither argv nor the script text,
 * that a hang is killed, and that the marker survives a noisy stream. What no test here can
 * prove is that `Get-CimInstance` returns what this expects, because that needs a Windows
 * machine — so the sensors in `T-10` are written against *recorded* real output, and the first
 * live run against Windows is a documented gap rather than an implied pass.
 */

const FAKE = installFakePowerShell();
let previous: string | undefined;

before(() => {
  previous = process.env[POWERSHELL_ENV];
  process.env[POWERSHELL_ENV] = FAKE;
  process.env['MS_SECRET_FROM_PARENT'] = 'the-core-database-password';
});

after(() => {
  process.env[POWERSHELL_ENV] = previous ?? '';
  delete process.env['MS_SECRET_FROM_PARENT'];
  rmSync(dirname(FAKE), { recursive: true, force: true });
});

const run = (snippet: string, over: Partial<Parameters<typeof runPowerShell>[1]> = {}) =>
  runPowerShell(snippet, { host: '', timeoutMs: 10_000, ...over });

describe('the wrapper script', () => {
  it('sets every preference a check depends on', () => {
    const script = buildScript('Get-CimInstance Win32_OperatingSystem', { host: '' });
    // Each of these is a separate way for PowerShell to report a wrong number rather than a
    // failure, so each is asserted rather than the block being eyeballed.
    assert.match(script, /\$ErrorActionPreference = 'Stop'/, 'or a failure exits 0');
    assert.match(
      script,
      /\$ProgressPreference = 'SilentlyContinue'/,
      'or progress lands in stdout',
    );
    assert.match(script, /UTF8Encoding/, 'or 5.1 writes the console code page');
    assert.match(script, /-Depth 6/, 'or ConvertTo-Json truncates to a type name at depth 2');
    assert.match(script, /-Compress/);
    assert.match(script, /catch \{/);
    assert.ok(script.includes('Get-CimInstance Win32_OperatingSystem'));
  });

  it('opens a session only when there is a machine to open one to', () => {
    // A Windows probe measuring itself needs no session, no credential and no WinRM at all,
    // which is the arrangement most installations start with.
    assert.ok(!buildScript('x', { host: '' }).includes('New-CimSession'));
    assert.ok(buildScript('x', { host: 'server01' }).includes('New-CimSession'));
  });

  it('never puts a credential in the script text', () => {
    // A script is echoed by a transcript and written to disk by Start-Transcript, both of which
    // a group policy can turn on for reasons that have nothing to do with us.
    const script = buildScript('x', { host: 'server01' });
    assert.ok(script.includes('$env:MS_WIN_PASSWORD'), 'it reads the variable');
    assert.ok(!/hunter2/.test(script));
  });

  it('takes the depth a caller asks for, since one shape needs more than another', () => {
    assert.match(buildScript('x', { host: '', depth: 3 }), /-Depth 3/);
  });
});

describe('reading the envelope', () => {
  it('reads a success', () => {
    const envelope = readEnvelope(`${RESULT_MARKER}{"ok":true,"data":{"n":1}}`);
    assert.deepEqual(envelope, { ok: true, data: { n: 1 } });
  });

  it('takes the last marked line, not the first', () => {
    // A snippet is allowed to print, and so is a module. Taking the first would let anything
    // that printed a plausible line ahead of the answer decide what the sensor reports.
    const envelope = readEnvelope(
      `noise\n${RESULT_MARKER}{"ok":true,"data":1}\nmore\n${RESULT_MARKER}{"ok":true,"data":2}\n`,
    );
    assert.deepEqual(envelope, { ok: true, data: 2 });
  });

  it('reads the error the wrapper caught, with its category', () => {
    const envelope = readEnvelope(
      `${RESULT_MARKER}{"ok":false,"error":"Access is denied.","category":"AuthenticationError",` +
        '"type":"System.UnauthorizedAccessException"}',
    );
    // `assert.equal` is `strictEqual`, which narrows — so the union is down to the failure
    // branch here and the category is reachable without a cast.
    assert.equal(envelope.ok, false);
    assert.equal(envelope.category, 'AuthenticationError');
    assert.equal(envelope.error, 'Access is denied.');
  });

  it('says what it saw when there is no result line at all', () => {
    assert.throws(
      () => readEnvelope('Windows PowerShell\nCopyright (C)\n'),
      /printed no result line.*Windows PowerShell/s,
    );
  });

  it('refuses a result line that is not JSON, or is not an object', () => {
    assert.throws(() => readEnvelope(`${RESULT_MARKER}{oops`), WindowsError);
    assert.throws(() => readEnvelope(`${RESULT_MARKER}"a string"`), /not an object/);
  });
});

describe('asRows — the single-object trap', () => {
  it('makes one row and many rows the same shape', () => {
    // ConvertTo-Json serialises one object as an object and two as an array, `@()` does not
    // help, and `-AsArray` is PowerShell 7 only while 5.1 is what is installed. So a volume
    // sensor works on a machine with two disks and breaks on a machine with one.
    assert.equal(asRows({ Name: 'C:' }).length, 1);
    assert.equal(asRows([{ Name: 'C:' }, { Name: 'D:' }]).length, 2);
  });

  it('makes nothing an empty list, and leaves the meaning to the caller', () => {
    assert.deepEqual(asRows(null), []);
    assert.deepEqual(asRows(undefined), []);
    assert.deepEqual(asRows([]), []);
  });

  it('drops what is not a row rather than reporting it as one', () => {
    assert.deepEqual(asRows([{ a: 1 }, 'string', 7, null]), [{ a: 1 }]);
  });
});

describe('numberFrom', () => {
  it('reads what PowerShell actually sends', () => {
    // A 64-bit integer arrives as a string from 5.1's serialiser more often than anybody expects.
    assert.equal(numberFrom(12), 12);
    assert.equal(numberFrom('107374182400'), 107374182400);
    assert.equal(numberFrom(true), 1);
    assert.equal(numberFrom(false), 0);
  });

  it('gaps rather than zeroing', () => {
    assert.equal(numberFrom(null), null);
    assert.equal(numberFrom(''), null);
    assert.equal(numberFrom('Unknown'), null);
    assert.equal(numberFrom(Number.NaN), null);
  });
});

describe('running it', () => {
  it('returns what the script produced', async () => {
    const outcome = await run('#FAKE:ok {"FreeSpace":100}');
    assert.deepEqual(outcome.data, { FreeSpace: 100 });
    assert.ok(outcome.durationMs >= 0);
  });

  it('sends the script as an encoded command and the credential in the environment', async () => {
    // The security argument, asserted rather than described. On Windows any user can read
    // another process's command line through Win32_Process.CommandLine, and a monitoring service
    // holds the credential for every machine in the estate — so the *credential* must not be
    // there. The script may: it names a CIM class and reads `$env:MS_WIN_PASSWORD`, and a real
    // pwsh proved that stdin (`-Command -`) silently runs nothing at all.
    const outcome = await run('#FAKE:env', {
      host: 'server01',
      credential: {
        username: 'CORP\\svc-monitor',
        password: 'hunter2',
        authentication: 'Kerberos',
      },
    });
    const data = outcome.data as Record<string, unknown>;
    assert.equal(data['user'], 'CORP\\svc-monitor');
    assert.equal(data['password'], 'hunter2');
    assert.equal(data['auth'], 'Kerberos');
    assert.equal(data['host'], 'server01');
    assert.ok(String(data['script']).includes('#FAKE:env'), 'the script decoded');
    assert.deepEqual(data['argv'], ['-NoProfile', '-NonInteractive', '-NoLogo']);
    assert.ok(!String(data['script']).includes('hunter2'), 'the password is not in the script');
  });

  it('hands the child a stated environment, not this process’s', async () => {
    // `runProgram` is explicit that the environment is stated rather than patched, and this is
    // the reason: a probe's own environment holds the core's database password.
    const outcome = await run('#FAKE:env');
    assert.equal((outcome.data as Record<string, unknown>)['leaked'], null);
  });

  it('sends no credential variables when there is no credential', async () => {
    const outcome = await run('#FAKE:env');
    const data = outcome.data as Record<string, unknown>;
    assert.equal(data['user'], null);
    assert.equal(data['password'], null);
  });

  it('finds the answer in a stream that has a banner and a decoy in it', async () => {
    const outcome = await run('#FAKE:noise {"real":true}');
    assert.deepEqual(outcome.data, { real: true });
  });

  it('turns the wrapper’s caught error into a failed check', async () => {
    await assert.rejects(
      () => run('#FAKE:error Access is denied.'),
      (error: unknown) => error instanceof WindowsError && /Access is denied/.test(error.message),
    );
  });

  it('names the likely cause for the categories that have one', async () => {
    // "The WinRM client cannot process the request" is the same string whether the machine is
    // off, the firewall is closed, or WinRM was never enabled. The category separates them, and
    // saying which is the difference between a ticket somebody acts on and one that gets
    // forwarded.
    await assert.rejects(
      () => run('#FAKE:error AuthenticationError|Access is denied.', { host: 'server01' }),
      /server01.*Remote Management Users.*Access is denied/s,
    );
    await assert.rejects(
      () =>
        run('#FAKE:error ConnectionError|The WinRM client cannot process the request.', {
          host: 'server01',
        }),
      /winrm quickconfig.*5985/s,
    );
    await assert.rejects(
      () => run('#FAKE:error NotSpecified|Something else entirely.', { host: 'server01' }),
      /^WindowsError: Something else entirely\. \[NotSpecified\]$/m,
      'a category with nothing useful to add adds nothing',
    );
  });

  it('kills a script that will not finish', async () => {
    const startedAt = Date.now();
    await assert.rejects(() => run('#FAKE:hang', { timeoutMs: 700 }), /still running after 700 ms/);
    assert.ok(Date.now() - startedAt < 15_000, 'and did not wait for the grace period twice');
  });

  it('reports the interpreter’s own failure with its stderr', async () => {
    await assert.rejects(
      () => run('#FAKE:crash The term is not recognized.'),
      /exited with code 1.*not recognized/s,
    );
  });

  it('says the script did not finish when it exits cleanly having printed nothing', async () => {
    await assert.rejects(() => run('#FAKE:silent'), /printed no result line/);
  });

  it('refuses a truncated stream rather than parsing what arrived', async () => {
    await assert.rejects(() => run('#FAKE:flood'), /more than 524288 bytes/);
  });

  it('refuses a result line that is not JSON', async () => {
    await assert.rejects(() => run('#FAKE:badjson'), /is not JSON/);
  });

  it('says what to do when there is no PowerShell to run', async () => {
    // The message an operator meets who has put a Windows sensor on a Linux probe, and the one
    // thing worse than that failing is it failing as `spawn ENOENT`.
    const saved = process.env[POWERSHELL_ENV];
    process.env[POWERSHELL_ENV] = '/nonexistent/powershell';
    try {
      await assert.rejects(() => run('#FAKE:ok'), /could not be started.*running on Windows/s);
    } finally {
      process.env[POWERSHELL_ENV] = saved ?? FAKE;
    }
  });
});

describe('which machine, and as whom', () => {
  const context = (
    params: Record<string, unknown>,
    credentials: Record<string, Record<string, unknown>> = {},
  ): CheckContext => ({
    sensorId: 1,
    target: { host: 'server01', ipVersion: 'v4' },
    params,
    credentials,
    signal: new AbortController().signal,
  });

  it('queries the device’s machine, with or without a credential', () => {
    // **The defect a mutation found.** An earlier version blanked the host when no Windows
    // credential was configured, so a sensor pointed at server01 quietly measured the probe's
    // own box and filed the numbers under server01 — a wrong reading that looks entirely
    // healthy, which is the worst kind this system can produce.
    assert.equal(windowsOptions(context({})).host, 'server01');
    assert.equal(
      windowsOptions(context({}, { windows: { username: 'svc', password: 'x' } })).host,
      'server01',
    );
  });

  it('sends no credential when there is none, because the probe’s own token is one', () => {
    // A domain service account already has a token the far end accepts, and `New-CimSession`
    // with no `-Credential` uses it. Absent credentials mean "use who I am".
    assert.equal(windowsOptions(context({})).credential, undefined);
  });

  it('reads the probe’s own machine only when the host says so', () => {
    for (const host of ['.', 'localhost', '127.0.0.1', '::1', 'LOCALHOST']) {
      assert.equal(windowsOptions(context({ host })).host, '', host);
    }
    assert.equal(windowsOptions(context({ host: 'server02' })).host, 'server02');
  });

  it('joins the domain to the username the way New-CimSession wants it', () => {
    const withDomain = windowsOptions(
      context({}, { windows: { username: 'svc', password: 'x', domain: 'CORP' } }),
    );
    assert.equal(withDomain.credential?.username, 'CORP\\svc');

    // Already qualified, so the domain field is not applied twice.
    const qualified = windowsOptions(
      context({}, { windows: { username: 'OTHER\\svc', password: 'x', domain: 'CORP' } }),
    );
    assert.equal(qualified.credential?.username, 'OTHER\\svc');
  });

  it('falls back to Default for an authentication it does not know', () => {
    // CredSSP is deliberately absent from the list: it hands the credential to the monitored
    // machine, so one compromised server would hold the account that reaches every other one.
    const credentials = { windows: { username: 'svc', password: 'x' } };
    assert.equal(
      windowsOptions(context({ authentication: 'CredSSP' }, credentials)).credential
        ?.authentication,
      'Default',
    );
    assert.equal(
      windowsOptions(context({ authentication: 'Kerberos' }, credentials)).credential
        ?.authentication,
      'Kerberos',
    );
  });
});

/**
 * The same wrapper, through a PowerShell that is one.
 *
 * **Skipped where there is no `pwsh`, and that is the point rather than a compromise.** Every
 * other test here proves the transport against a fake, which cannot tell whether the script is
 * *valid PowerShell* — and the first time a real one saw it, it turned out the transport's way of
 * handing it over ran nothing at all and exited 0. `docs/findings/2026-08-27-powershell-transport.md`
 * has the measurement. This runs wherever a `pwsh` exists so that never happens again silently;
 * on Windows it also exercises 5.1's serialiser, which is the one that ships.
 */
const pwsh = ((): string => {
  for (const candidate of [process.env['MS_TEST_PWSH'] ?? '', 'pwsh', 'powershell.exe']) {
    if (candidate === '') continue;
    try {
      execFileSync(candidate, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable'], {
        stdio: 'ignore',
        timeout: 20_000,
      });
      return candidate;
    } catch {
      // Not this one.
    }
  }
  return '';
})();

describe(
  'against a real PowerShell',
  { skip: pwsh === '' ? 'no pwsh on this machine' : false },
  () => {
    const real = (snippet: string, host = ''): Promise<PowerShellRun> => {
      process.env[POWERSHELL_ENV] = pwsh;
      return runPowerShell(snippet, { host, timeoutMs: 60_000 }).finally(() => {
        process.env[POWERSHELL_ENV] = FAKE;
      });
    };

    it('runs the wrapper and returns a parseable envelope', async () => {
      const outcome = await real('[ordered]@{ n = 7; text = "café" }');
      assert.deepEqual(outcome.data, { n: 7, text: 'café' }, 'and in UTF-8, not the code page');
    });

    it('serialises deeper than ConvertTo-Json would by default', async () => {
      // At the default depth of 2 the innermost object becomes the *string*
      // "System.Collections.Hashtable", which parses — so a path that reached a number yesterday
      // reaches a type name today.
      const outcome = await real('@{ a = @{ b = @{ c = @{ d = @{ e = 5 } } } } }');
      assert.deepEqual(outcome.data, { a: { b: { c: { d: { e: 5 } } } } });
    });

    it('turns a throw into the failure envelope, with its category', async () => {
      await assert.rejects(
        () => real('throw "Access is denied."'),
        /Access is denied\..*\[OperationStopped\]/s,
      );
    });

    it('catches a failure in the session setup, not only in the query', async () => {
      // On a machine without CimCmdlets — every Linux one — opening the session is what fails, and
      // it has to come back as an envelope rather than as a crash the transport must guess at.
      // On Windows this reaches a machine that does not exist and fails at the connection instead;
      // either way it is a diagnosis rather than an empty stream.
      await assert.rejects(
        () =>
          real(
            'Get-CimInstance -ClassName Win32_OperatingSystem -CimSession $MsSession',
            'no-such-host.invalid',
          ),
        (error: unknown) => error instanceof WindowsError && error.message.length > 20,
      );
    });
  },
);
