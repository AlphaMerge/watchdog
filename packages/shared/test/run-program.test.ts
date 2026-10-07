import { strict as assert } from 'node:assert';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { after, before, describe, it } from 'node:test';
import { PROGRAM_GROUP_CHANNEL, type ProgramGroupEvent } from '../src/process/group-channel.js';
import { runProgram } from '../src/process/run.js';
import { within } from './support/within.js';

/**
 * The runner drives real programs, and on POSIX those are shell scripts. Windows would need its
 * own set; the CI toolchain is Linux, and skipping loudly is better than a suite that quietly
 * tests nothing.
 */
const posix = process.platform !== 'win32';

describe('running a program', { skip: posix ? false : 'POSIX only' }, () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ms-run-'));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Writes an executable shell script and returns its path. */
  async function script(name: string, body: string): Promise<string> {
    const file = join(dir, name);
    await writeFile(file, `#!/bin/sh\n${body}\n`, 'utf8');
    await chmod(file, 0o755);
    return file;
  }

  function run(file: string, overrides: Partial<Parameters<typeof runProgram>[0]> = {}) {
    return runProgram({
      file,
      args: [],
      cwd: dir,
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' },
      timeoutMs: 5_000,
      maxOutputBytes: 4096,
      ...overrides,
    });
  }

  it('reports what the program said and how it ended', async () => {
    const file = await script('hello.sh', 'echo out; echo err >&2; exit 0');
    const result = await run(file);
    assert.ok(result.outcome === 'exited' && result.code === 0, `outcome was ${result.outcome}`);
    assert.equal(result.stdout.trim(), 'out');
    assert.equal(result.stderr.trim(), 'err');
    assert.equal(result.truncated, false);
  });

  it('keeps the exit code, because it is the program’s own answer', async () => {
    const file = await script('fail.sh', 'echo why >&2; exit 3');
    const result = await run(file);
    assert.ok(result.outcome === 'exited');
    assert.equal(result.code, 3);
    assert.equal(result.stderr.trim(), 'why');
  });

  it('passes arguments as arguments, never through a shell', async () => {
    // The injection this prevents: an argument carrying `%lastmessage`, and a device whose SNMP
    // description is `; rm -rf /`. Through a shell that is a command; as argv it is a string.
    const file = await script('args.sh', 'for a in "$@"; do echo "[$a]"; done');
    const result = await run(file, { args: ['; rm -rf /', '$(whoami)', 'two words'] });
    assert.ok(result.outcome === 'exited' && result.code === 0);
    assert.equal(result.stdout, '[; rm -rf /]\n[$(whoami)]\n[two words]\n');
  });

  it('gives the program its stdin and closes it', async () => {
    const file = await script('cat.sh', 'cat');
    const result = await run(file, { stdin: 'the body\nsecond line\n' });
    assert.ok(result.outcome === 'exited');
    assert.equal(result.stdout, 'the body\nsecond line\n');
  });

  it('is not upset by a program that never reads stdin', async () => {
    // Writing to a closed pipe raises EPIPE, which is the program's prerogative rather than a
    // failure of the run.
    const file = await script('ignores.sh', 'exit 0');
    const result = await run(file, { stdin: 'x'.repeat(200_000) });
    assert.ok(result.outcome === 'exited' && result.code === 0);
  });

  it('hands over only the environment it was given', async () => {
    // Inheriting would give a script every secret the service holds — the SMTP password and the
    // database URL arrive through MS_* overrides.
    process.env['MS_TEST_SECRET_LEAK'] = 'do-not-pass-this-on';
    const file = await script('env.sh', 'echo "leak=[${MS_TEST_SECRET_LEAK}] mine=[${MS_MINE}]"');
    const result = await run(file, { env: { PATH: process.env['PATH'] ?? '', MS_MINE: 'yes' } });
    delete process.env['MS_TEST_SECRET_LEAK'];
    assert.ok(result.outcome === 'exited');
    assert.equal(result.stdout.trim(), 'leak=[] mine=[yes]');
  });

  it('bounds what it keeps without blocking the program that writes it', async () => {
    // A program writing a gigabyte must not be buffered, and must not be left stuck on a full
    // pipe either — that would turn a chatty program into a hang.
    const file = await script(
      'loud.sh',
      'i=0; while [ $i -lt 4000 ]; do echo 0123456789; i=$((i+1)); done; exit 0',
    );
    const result = await run(file, { maxOutputBytes: 1024 });
    assert.ok(result.outcome === 'exited', `outcome was ${result.outcome}`);
    assert.equal(result.code, 0, 'the program ran to completion');
    assert.equal(result.stdout.length, 1024);
    assert.equal(result.truncated, true);
  });

  it('hands stdout over as it arrives, past what it keeps (`P-260`)', async () => {
    // The probe acts on a line its check process writes before the process ends, and the line may
    // follow more output than is kept: the bound is on keeping, not on reading.
    const file = await script('ready.sh', 'echo 0123456789; echo ready; sleep 30');
    const seen: string[] = [];
    const ready = new AbortController();
    const result = await run(file, {
      maxOutputBytes: 4,
      // A minute, so that only the caller's abort can have ended it in the time asserted below.
      timeoutMs: 60_000,
      signal: ready.signal,
      onStdout: (chunk) => {
        seen.push(chunk.toString('latin1'));
        if (seen.join('').includes('ready\n')) ready.abort();
      },
    });
    // Ended by the caller on what it read, long before the script's sleep or the deadline.
    assert.equal(ready.signal.aborted, true, 'the caller aborted on the line it read');
    assert.equal(result.outcome, 'timeout');
    assert.ok(result.durationMs < 20_000, `ran for ${String(result.durationMs)} ms`);
    assert.equal(seen.join(''), '0123456789\nready\n');
    assert.equal(result.stdout, '0123');
  });

  it('stops a program that runs too long, and says so', async () => {
    const file = await script('slow.sh', 'sleep 30');
    const result = await run(file, { timeoutMs: 300 });
    assert.equal(result.outcome, 'timeout');
    assert.equal(result.endedBy, 'deadline');
    assert.ok(result.durationMs < 5_000);
  });

  it('says which ended it, the deadline or the caller, and only the first (`P-262`)', async () => {
    const file = await script('stubborn-p262.sh', "trap '' TERM; sleep 30");

    const caller = new AbortController();
    const calledAt = performance.now();
    let abortedAfterMs = Infinity;
    const early = setTimeout(() => {
      abortedAfterMs = performance.now() - calledAt;
      caller.abort();
    }, 200);
    const aborted = await run(file, { timeoutMs: 60_000, signal: caller.signal, graceMs: 200 });
    clearTimeout(early);
    assert.ok(aborted.outcome === 'timeout');
    assert.equal(aborted.endedBy, 'signal');
    // When the limit came, not when the program was finally gone: it ignored SIGTERM for the
    // grace, which `durationMs` holds and `endedAfterMs` does not. The program started after the
    // call and the abort ends it in the same turn, so no load puts the number past the abort.
    assert.equal(aborted.hardKilled, true);
    assert.ok(
      aborted.endedAfterMs <= abortedAfterMs + 50,
      `ended after ${String(aborted.endedAfterMs)} ms for an abort at ${String(abortedAfterMs)}`,
    );
    assert.ok(aborted.durationMs >= aborted.endedAfterMs + 200 - 5, 'and then the grace');

    // The caller's abort arriving while the deadline's SIGTERM is being ignored changes nothing:
    // the program ran into the deadline first.
    const late = new AbortController();
    const during = setTimeout(() => {
      late.abort();
    }, 400);
    const timed = await run(file, { timeoutMs: 200, signal: late.signal, graceMs: 600 });
    clearTimeout(during);
    assert.equal(late.signal.aborted, true, 'the caller aborted during the grace');
    assert.ok(timed.outcome === 'timeout');
    assert.equal(timed.endedBy, 'deadline');
    assert.equal(timed.hardKilled, true);
    assert.ok(timed.endedAfterMs >= 195, `the deadline at ${String(timed.endedAfterMs)} ms`);
    assert.ok(timed.endedAfterMs < timed.durationMs, 'before the program was gone');

    // And a signal aborted before the start is the caller's too.
    const before = new AbortController();
    before.abort();
    const never = await run(file, { signal: before.signal, graceMs: 200 });
    assert.ok(never.outcome === 'timeout');
    assert.equal(never.endedBy, 'signal');
  });

  it('kills a program that ignores being asked to stop', async () => {
    const file = await script('stubborn.sh', "trap '' TERM; sleep 30");
    const result = await run(file, { timeoutMs: 200, graceMs: 300 });
    assert.ok(result.outcome === 'timeout');
    assert.equal(result.hardKilled, true, 'SIGTERM was ignored, so SIGKILL followed');
  });

  it('takes down what the program started, not only the program', async () => {
    // A script that backgrounds curl and exits would otherwise leave it running for ever. The
    // child writes to a file after the parent is gone; if the group was killed, it never does.
    const witness = join(dir, 'survivor.txt');
    const file = await script(
      'forks.sh',
      `(sleep 1; echo survived > ${witness}) &\ntrap '' TERM\nsleep 30`,
    );
    const result = await run(file, { timeoutMs: 200, graceMs: 200 });
    assert.ok(result.outcome === 'timeout');
    await new Promise((done) => setTimeout(done, 1_500));
    await assert.rejects(readFile(witness, 'utf8'), 'the backgrounded child was killed too');
  });

  it('reports a program that is not there rather than throwing', async () => {
    const result = await run(join(dir, 'absent.sh'));
    assert.ok(result.outcome === 'failed');
    assert.equal(result.code, 'ENOENT');
  });

  it('reports a file that is not executable', async () => {
    const file = join(dir, 'plain.sh');
    await writeFile(file, '#!/bin/sh\necho hi\n', 'utf8');
    await chmod(file, 0o644);
    const result = await run(file);
    assert.ok(result.outcome === 'failed');
    assert.equal(result.code, 'EACCES');
  });

  describe('naming the group it starts (`P-266`)', () => {
    const heard: ProgramGroupEvent[] = [];
    const listener = (message: unknown): void => {
      heard.push(message as ProgramGroupEvent);
    };
    before(() => {
      subscribe(PROGRAM_GROUP_CHANNEL, listener);
    });
    after(() => {
      unsubscribe(PROGRAM_GROUP_CHANNEL, listener);
    });

    it('says the group started, with the program’s pid, and that it ended', async () => {
      heard.length = 0;
      const file = await script('pid.sh', 'echo $$');
      const result = await run(file);
      assert.ok(result.outcome === 'exited');
      const pid = Number(result.stdout.trim());
      assert.deepEqual(heard, [
        { event: 'started', pgid: pid },
        { event: 'ended', pgid: pid },
      ]);
    });

    it('says it ended when it was ended, too', async () => {
      heard.length = 0;
      const file = await script('lingers.sh', 'echo $$\nsleep 30');
      const result = await run(file, { timeoutMs: 200, graceMs: 200 });
      assert.ok(result.outcome === 'timeout');
      const pid = Number(result.stdout.trim());
      assert.deepEqual(
        heard.map((one) => one.event),
        ['started', 'ended'],
      );
      assert.ok(heard.every((one) => one.pgid === pid));
    });

    // `setsid`, the util-linux program, is how a script lets something leave its group and keep
    // its pipes; the toolchain is Linux.
    const linux = process.platform === 'linux' ? false : 'needs setsid(1), Linux';

    it(
      'says it ended when the group empties, not when something outside it lets go of the pipes',
      { skip: linux },
      async () => {
        heard.length = 0;
        // The program goes at once; a helper in its group goes after a second; something that
        // left the group holds stdout for five.
        const file = await script(
          'escapes.sh',
          'sleep 1 >/dev/null 2>&1 </dev/null &\nsetsid sleep 5 &\necho $$',
        );
        let settled = false;
        const running = run(file, { timeoutMs: 20_000 }).finally(() => {
          settled = true;
        });
        const ended = new Promise<void>((done) => {
          const look = (): void => {
            if (heard.some((one) => one.event === 'ended') || settled) done();
            else setTimeout(look, 20);
          };
          look();
        });
        await within(10_000, 'the group to be said to have ended', ended);
        assert.equal(settled, false, 'said before the run ended, at the group and not the pipes');
        assert.deepEqual(
          heard.map((one) => one.event),
          ['started', 'ended'],
        );
        const result = await within(20_000, 'the run to end', running);
        assert.ok(result.outcome === 'exited');
        assert.equal(heard.length, 2, 'and said once');
      },
    );

    it(
      'never signals a group that has gone, since its id may be another’s',
      { skip: linux },
      async () => {
        heard.length = 0;
        const file = await script('gone.sh', 'setsid sleep 3 &\necho $$');
        const signalled: [number, string | number | undefined][] = [];
        const real = process.kill.bind(process);
        process.kill = (pid: number, signal?: string | number) => {
          signalled.push([pid, signal]);
          return real(pid, signal);
        };
        try {
          const result = await within(
            20_000,
            'the run to end',
            run(file, { timeoutMs: 1_000, graceMs: 200 }),
          );
          assert.ok(result.outcome === 'timeout', 'its deadline came while the pipes were held');
          const pid = Number(result.stdout.trim());
          assert.ok(pid > 1);
          assert.deepEqual(
            signalled.filter(([to, signal]) => to === -pid && signal !== 0),
            [],
            'no SIGTERM or SIGKILL to a group already empty',
          );
          assert.ok(
            signalled.some(([to, signal]) => to === -pid && signal === 0),
            'it looked, and found it gone',
          );
        } finally {
          process.kill = real;
        }
      },
    );

    it('names nothing for a program that never started', async () => {
      heard.length = 0;
      const result = await run(join(dir, 'absent-too.sh'));
      assert.ok(result.outcome === 'failed');
      assert.deepEqual(heard, []);
    });
  });
});
