import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exeScript } from '../src/types/exe-script.js';
import { exeScriptAdvanced } from '../src/types/exe-script-advanced.js';
import { keyOf, parseAdvanced, parseSimple } from '../src/support/script/parse.js';
import { resolveProgram, SCRIPT_DIR_ENV } from '../src/support/script/resolve.js';
import type { CheckContext, CheckExecution } from '../src/contract.js';

/**
 * The sensors that run programs, and the boundary that decides which.
 *
 * Most of this file is about `resolveProgram`, which is the whole security argument of `T-19`:
 * everything else here is ordinary — spawn a program, read its output, parse it — and what makes
 * this type different is that the thing being run is named by somebody typing into a form.
 */

let dir = '';
let outside = '';

/** Writes a shell script into the script directory and makes it executable. */
function script(name: string, body: string): void {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`, 'utf8');
  chmodSync(path, 0o755);
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'ms-scripts-'));
  outside = mkdtempSync(join(tmpdir(), 'ms-outside-'));
  process.env[SCRIPT_DIR_ENV] = dir;

  script('ok.sh', 'echo "0:42:all good"');
  script('number.sh', 'echo 17.5');
  script('json.sh', 'echo \'{"value":8,"message":"from json"}\'');
  script('warn.sh', 'echo "1:0:disk is filling up"');
  script('fail.sh', 'echo "something broke" >&2; exit 3');
  script('silent.sh', 'exit 0');
  script('slow.sh', 'sleep 30');
  script('args.sh', 'echo "0:${#}:$1 $2"');
  script('env.sh', 'echo "0:1:$MS_HOST|$MS_SECRET|$CUSTOM|${SHOULD_NOT_LEAK:-absent}"');
  script(
    'advanced.sh',
    'echo \'{"channels":[{"key":"value","value":3,"unit":"jobs"},{"key":"lag","name":"Replica lag","value":12.5,"unit":"s"}],"message":"two channels"}\'',
  );
  script(
    'prtg-advanced.sh',
    'echo \'{"prtg":{"result":[{"channel":"Free Space","value":"91.5","unit":"%"},{"channel":"Inodes","value":4000}],"text":"looks fine"}}\'',
  );
  script('prtg-error.sh', 'echo \'{"prtg":{"error":1,"text":"the API said no"}}\'');
  script('noisy.sh', 'head -c 1000000 /dev/zero | tr "\\0" "x"');

  mkdirSync(join(dir, 'sub'), { recursive: true });
  script('sub/nested.sh', 'echo "0:5:from a subdirectory"');

  writeFileSync(join(outside, 'evil.sh'), '#!/bin/sh\necho "0:666:owned"\n', 'utf8');
  chmodSync(join(outside, 'evil.sh'), 0o755);
  symlinkSync(join(outside, 'evil.sh'), join(dir, 'link-out.sh'));

  writeFileSync(join(dir, 'notexec.sh'), '#!/bin/sh\necho hi\n', 'utf8');
  chmodSync(join(dir, 'notexec.sh'), 0o644);
});

after(() => {
  process.env[SCRIPT_DIR_ENV] = '';
  for (const path of [dir, outside])
    if (path !== '') rmSync(path, { recursive: true, force: true });
});

function run(
  type: typeof exeScript,
  params: Record<string, unknown>,
  over: Partial<CheckContext> = {},
): Promise<CheckExecution> {
  return type.execute({
    sensorId: 3,
    target: { host: 'device.example.invalid', ipVersion: 'auto' },
    params: { timeoutMs: 10_000, ...params },
    credentials: {},
    signal: new AbortController().signal,
    ...over,
  });
}

const valueOf = (execution: CheckExecution, key: string): number | undefined =>
  execution.channels.find((channel) => channel.key === key)?.value;

describe('resolveProgram', () => {
  it('finds a program in the script directory', async () => {
    // Compared against the *resolved* directory, because macOS puts a temp dir under a symlink
    // and the resolver returns the real path — which is exactly the behaviour being relied on.
    const resolved = await resolveProgram('ok.sh');
    assert.equal(resolved.file, join(await realpath(dir), 'ok.sh'));
    assert.equal(resolved.directory, await realpath(dir));
  });

  it('allows a subdirectory', async () => {
    assert.ok((await resolveProgram('sub/nested.sh')).file.endsWith('nested.sh'));
  });

  it('refuses an absolute path', async () => {
    // The whole point. Without this, anyone who may add a sensor may run any command as the
    // account this probe holds its credentials in.
    await assert.rejects(() => resolveProgram('/bin/sh'), /absolute path/);
  });

  it('refuses to climb out', async () => {
    await assert.rejects(() => resolveProgram('../evil.sh'), /climbs out/);
    await assert.rejects(() => resolveProgram('sub/../../evil.sh'), /climbs out/);
  });

  it('refuses a symbolic link pointing outside, which a name check would miss', async () => {
    // Resolve first, compare second. A link inside the directory is the obvious way around a
    // comparison made on the name.
    await assert.rejects(() => resolveProgram('link-out.sh'), /outside this probe’s script/);
  });

  it('refuses a name with anything a shell would care about in it', async () => {
    // Nothing is run through a shell, so a name needing these characters is a name pointing
    // somewhere it should not.
    for (const name of ['ok.sh; rm -rf /', 'ok.sh && id', '$(id)', 'ok sh', 'ok.sh|cat']) {
      await assert.rejects(() => resolveProgram(name), /not a program name/, name);
    }
  });

  it('refuses a file that is not executable, and says how to fix it', async () => {
    await assert.rejects(() => resolveProgram('notexec.sh'), /not executable/);
  });

  it('says the program is missing rather than failing to spawn later', async () => {
    await assert.rejects(() => resolveProgram('nothing-here.sh'), /there is no program called/);
  });

  it('refuses to run anything at all when no directory is configured', async () => {
    // The right default for a probe nobody has deliberately given scripts to.
    const saved = process.env[SCRIPT_DIR_ENV] ?? '';
    process.env[SCRIPT_DIR_ENV] = '';
    try {
      await assert.rejects(() => resolveProgram('ok.sh'), /no script directory configured/);
    } finally {
      process.env[SCRIPT_DIR_ENV] = saved;
    }
  });
});

describe('output formats', () => {
  it('reads PRTG’s returncode:value:message, colons in the message and all', () => {
    const parsed = parseSimple('0:42:it said 10:30 and meant it', 'prtg', 'value');
    assert.equal(parsed.channels[0]?.value, 42);
    assert.equal(parsed.message, 'it said 10:30 and meant it');
  });

  it('fails a non-zero return code and names what the script meant by it', () => {
    // Warning is not an outcome a check can report here: it comes from a limit on a channel,
    // which is visible and editable, where a Warning baked into a script is a threshold nobody
    // can change without editing the script on every probe.
    assert.throws(
      () => parseSimple('1:0:filling up', 'prtg', 'value'),
      /1 \(Warning\): filling up/,
    );
    assert.throws(() => parseSimple('2:0:broken', 'prtg', 'value'), /2 \(System Error\)/);
    assert.throws(() => parseSimple('9:0:eh', 'prtg', 'value'), /unrecognised status/);
  });

  it('reads a plain number, and refuses text pretending to be one', () => {
    assert.equal(parseSimple(' 17.5 \n', 'number', 'value').channels[0]?.value, 17.5);
    assert.throws(() => parseSimple('seventeen', 'number', 'value'), /expects a plain number/);
  });

  it('refuses silence, because a check needs a reading', () => {
    assert.throws(() => parseSimple('   ', 'number', 'value'), /printed nothing on stdout/);
  });

  it('reads PRTG’s own advanced JSON, so an existing script works unchanged', () => {
    const parsed = parseAdvanced(
      '{"prtg":{"result":[{"channel":"Free Space","value":"91.5","unit":"%"}],"text":"fine"}}',
      'free_space',
    );
    assert.deepEqual(parsed.channels, [
      { key: 'free_space', value: 91.5, name: 'Free Space', unit: '%' },
    ]);
    assert.equal(parsed.message, 'fine');
  });

  it('reads a comma decimal separator, which a script written on a German machine prints', () => {
    const parsed = parseAdvanced('{"prtg":{"result":[{"channel":"Load","value":"1,5"}]}}', 'load');
    assert.equal(parsed.channels[0]?.value, 1.5);
  });

  it('fails when PRTG’s error flag is set', () => {
    assert.throws(
      () => parseAdvanced('{"prtg":{"error":1,"text":"the API said no"}}', 'value'),
      /reported an error: the API said no/,
    );
  });

  it('fails when the primary channel is missing, rather than reporting the rest', () => {
    // A silently absent primary is a sensor that looks healthy while reporting nothing anybody
    // is watching.
    assert.throws(
      () => parseAdvanced('{"channels":[{"key":"other","value":1}]}', 'value'),
      /no channel called "value".*it returned other/s,
    );
  });

  it('fails on an empty channel list', () => {
    assert.throws(() => parseAdvanced('{"channels":[]}', 'value'), /returned no channels/);
  });

  it('says what the program printed when it is not JSON', () => {
    assert.throws(
      () => parseAdvanced('<xml>no</xml>', 'value'),
      /did not print JSON.*it printed "<xml>no<\/xml>"/s,
    );
  });

  it('makes a stable key out of a display name', () => {
    // A key is what history is stored under: "Free Space" and "free space" must not become two
    // channels because a script author changed the capitalisation.
    assert.equal(keyOf('Free Space'), 'free_space');
    assert.equal(keyOf('free space'), 'free_space');
    assert.equal(keyOf('  CPU (total) %  '), 'cpu_total');
  });
});

describe('exe.script', () => {
  it('runs a program and reports its value and its run time', async () => {
    const execution = await run(exeScript, { program: 'ok.sh' });
    assert.equal(valueOf(execution, 'value'), 42);
    assert.ok((valueOf(execution, 'runtime') ?? -1) >= 0);
    assert.equal(execution.message, 'all good');
  });

  it('reads the other two formats', async () => {
    assert.equal(
      valueOf(await run(exeScript, { program: 'number.sh', format: 'number' }), 'value'),
      17.5,
    );
    const json = await run(exeScript, { program: 'json.sh', format: 'json' });
    assert.equal(valueOf(json, 'value'), 8);
    assert.equal(json.message, 'from json');
  });

  it('fails a script that asked for Warning, naming what it meant', async () => {
    await assert.rejects(() => run(exeScript, { program: 'warn.sh' }), /1 \(Warning\)/);
  });

  it('reports a non-zero exit with what the program said on stderr', async () => {
    // "exit 3" alone is not a diagnosis (CLAUDE.md).
    await assert.rejects(
      () => run(exeScript, { program: 'fail.sh' }),
      /exited with code 3: something broke/,
    );
  });

  it('passes arguments one at a time, never through a shell', async () => {
    // A space or a quote in an argument is a character, not a syntax.
    const execution = await run(exeScript, {
      program: 'args.sh',
      args: ['two words', '%host'],
    });
    assert.equal(valueOf(execution, 'value'), 2, 'the shell did not split the first argument');
    assert.equal(execution.message, 'two words device.example.invalid');
  });

  it('gives the program only the environment it was told to', async () => {
    // Built, never inherited: this probe's environment holds whatever arrived through MS_*
    // overrides, and handing that to a script is how a credential leaves the machine.
    process.env['SHOULD_NOT_LEAK'] = 'a database url';
    try {
      const execution = await run(exeScript, {
        program: 'env.sh',
        env: [{ name: 'CUSTOM', value: 'set-here' }],
        secret: 'api-key-1234',
      });
      assert.equal(
        execution.message,
        'device.example.invalid|api-key-1234|set-here|absent',
        'the probe’s own environment reached the script',
      );
    } finally {
      delete process.env['SHOULD_NOT_LEAK'];
    }
  });

  it('kills a program that runs past its timeout', async () => {
    await assert.rejects(
      () => run(exeScript, { program: 'slow.sh', timeoutMs: 1_000 }),
      /still running after 1000 ms and was (killed|stopped)/,
    );
  });

  it('refuses a program that printed more than it reads', async () => {
    await assert.rejects(
      () => run(exeScript, { program: 'noisy.sh', format: 'number' }),
      /printed more than \d+ bytes/,
    );
  });

  it('fails a program that succeeded silently', async () => {
    await assert.rejects(() => run(exeScript, { program: 'silent.sh' }), /printed nothing/);
  });

  it('declares the channel name the operator chose', () => {
    const defs = exeScript.channels({ valueName: 'Licences in use', unit: 'seats' });
    assert.deepEqual(defs[0], {
      key: 'value',
      name: 'Licences in use',
      unit: 'seats',
      isPrimary: true,
    });
  });

  it('runs in a process of its own, which is why P-03 came first', () => {
    assert.equal(exeScript.isolation, 'process');
    assert.equal(exeScriptAdvanced.isolation, 'process');
  });
});

describe('exe.script.advanced', () => {
  it('reports every channel the program returned', async () => {
    const execution = await run(exeScriptAdvanced, { program: 'advanced.sh' });
    assert.equal(valueOf(execution, 'value'), 3);
    assert.equal(valueOf(execution, 'lag'), 12.5);
    assert.ok((valueOf(execution, 'runtime') ?? -1) >= 0);
    assert.equal(execution.message, 'two channels');
    // The names and units ride with the reading, which is what lets the core create the channel
    // on first sight (`S-07`) with something readable on it.
    assert.deepEqual(
      execution.channels.find((channel) => channel.key === 'lag'),
      { key: 'lag', value: 12.5, name: 'Replica lag', unit: 's' },
    );
  });

  it('reads a PRTG advanced script unchanged, keys derived from the channel names', async () => {
    const execution = await run(exeScriptAdvanced, {
      program: 'prtg-advanced.sh',
      primaryChannel: 'free_space',
    });
    assert.equal(valueOf(execution, 'free_space'), 91.5);
    assert.equal(valueOf(execution, 'inodes'), 4000);
    assert.equal(execution.message, 'looks fine');
  });

  it('fails when the program says it failed', async () => {
    await assert.rejects(
      () => run(exeScriptAdvanced, { program: 'prtg-error.sh' }),
      /the API said no/,
    );
  });

  it('fails when the primary channel is absent', async () => {
    await assert.rejects(
      () => run(exeScriptAdvanced, { program: 'advanced.sh', primaryChannel: 'missing' }),
      /no channel called "missing"/,
    );
  });

  it('declares the primary the operator named', () => {
    const defs = exeScriptAdvanced.channels({
      primaryChannel: 'free_space',
      primaryName: 'Free space',
      primaryUnit: '%',
    });
    assert.deepEqual(
      defs.filter((def) => def.isPrimary === true).map((def) => def.key),
      ['free_space'],
    );
    assert.equal(defs[defs.length - 1]?.key, 'runtime');
  });
});
