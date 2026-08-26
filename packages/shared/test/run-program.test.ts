import { strict as assert } from 'node:assert';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { runProgram } from '../src/process/run.js';

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

  it('stops a program that runs too long, and says so', async () => {
    const file = await script('slow.sh', 'sleep 30');
    const result = await run(file, { timeoutMs: 300 });
    assert.equal(result.outcome, 'timeout');
    assert.ok(result.durationMs < 5_000);
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
});
