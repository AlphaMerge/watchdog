import { strict as assert } from 'node:assert';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { pino } from 'pino';
import type { Logger, ProgramConfig } from '@ms/shared';
import { ProgramTransport } from '../src/notifications/delivery/program.js';
import type { OutgoingMessage } from '../src/notifications/delivery/transport.js';
import { messageContext } from './support/messages.js';
import { silent } from './support/tree.js';

const posix = process.platform !== 'win32';

function message(overrides: Partial<OutgoingMessage> = {}): OutgoingMessage {
  return {
    requestId: 7,
    sensorId: 42,
    subject: 'Ping on edge-router is down',
    body: 'no ICMP reply from 192.0.2.7',
    recipients: [],
    priority: 2,
    settings: { path: 'notify.sh', args: [], secretArgs: [], timeoutMs: 5_000 },
    context: messageContext(),
    ...overrides,
  };
}

describe('execute-program delivery', { skip: posix ? false : 'POSIX only' }, () => {
  let dir: string;
  let outside: string;

  before(async () => {
    const root = await mkdtemp(join(tmpdir(), 'ms-prog-'));
    dir = join(root, 'programs');
    outside = join(root, 'elsewhere');
    await mkdir(dir);
    await mkdir(outside);
  });

  after(async () => {
    await rm(join(dir, '..'), { recursive: true, force: true });
  });

  beforeEach(async () => {
    await rm(join(dir, 'record.txt'), { force: true });
  });

  function config(overrides: Partial<ProgramConfig> = {}): ProgramConfig {
    return { directory: dir, maxOutputBytes: 4096, killGraceMs: 500, uid: -1, gid: -1, ...overrides };
  }

  function transport(overrides: Partial<ProgramConfig> = {}): ProgramTransport {
    return new ProgramTransport({ config: config(overrides), logger: silent });
  }

  async function script(name: string, body: string, where = dir): Promise<string> {
    const file = join(where, name);
    await writeFile(file, `#!/bin/sh\n${body}\n`, 'utf8');
    await chmod(file, 0o755);
    return file;
  }

  // -----------------------------------------------------------------------------------------
  // Containment. This is the whole security model, so it is most of the tests.
  // -----------------------------------------------------------------------------------------

  describe('what a template is allowed to run', () => {
    it('runs nothing at all until an operator configures a directory', async () => {
      // Off by default, deliberately: an installation that has not set this up cannot be talked
      // into running a program by anybody who can edit a template.
      const result = await transport({ directory: '' }).send(message());
      assert.ok(!result.ok);
      assert.equal(result.retryable, false);
      assert.match(result.error, /no notification program directory is configured/);
    });

    it('refuses an absolute path', async () => {
      const result = await transport().send(message({ settings: { path: '/bin/sh' } }));
      assert.ok(!result.ok && !result.retryable);
      assert.match(result.error, /absolute path/);
    });

    it('refuses a walk out of the directory', async () => {
      await script('escape.sh', 'exit 0', outside);
      const result = await transport().send(
        message({ settings: { path: '../elsewhere/escape.sh' } }),
      );
      assert.ok(!result.ok && !result.retryable);
      assert.match(result.error, /outside the programs directory/);
    });

    it('refuses a symlink that leads out of the directory', async () => {
      // A symlink is a path too. Checking the name and not the real path is how a link named
      // `notify.sh` pointing at /bin/sh gets run.
      const target = await script('target.sh', 'exit 0', outside);
      await rm(join(dir, 'linked.sh'), { force: true });
      await symlink(target, join(dir, 'linked.sh'));
      const result = await transport().send(message({ settings: { path: 'linked.sh' } }));
      assert.ok(!result.ok && !result.retryable);
      assert.match(result.error, /outside the programs directory/);
    });

    it('allows a subdirectory, which is inside it', async () => {
      await mkdir(join(dir, 'team'), { recursive: true });
      await script('ok.sh', 'exit 0', join(dir, 'team'));
      const result = await transport().send(message({ settings: { path: 'team/ok.sh' } }));
      assert.ok(result.ok, result.ok ? '' : result.error);
    });

    it('says plainly when the named program is not there', async () => {
      const result = await transport().send(message({ settings: { path: 'missing.sh' } }));
      assert.ok(!result.ok && !result.retryable);
      assert.match(result.error, /missing\.sh/);
    });
  });

  // -----------------------------------------------------------------------------------------
  // What the program is told.
  // -----------------------------------------------------------------------------------------

  describe('what the program is given', () => {
    it('substitutes placeholders into the arguments', async () => {
      await script('args.sh', `for a in "$@"; do echo "[$a]" >> ${join(dir, 'record.txt')}; done`);
      const result = await transport().send(
        message({ settings: { path: 'args.sh', args: ['%sensor', '%status', '%device'] } }),
      );
      assert.ok(result.ok, result.ok ? '' : result.error);
      assert.equal(await readFile(join(dir, 'record.txt'), 'utf8'), '[Ping]\n[down]\n[edge-router]\n');
    });

    it('puts the secret arguments after the visible ones, as the schema promises', async () => {
      await script('args.sh', `printf '%s|' "$@" > ${join(dir, 'record.txt')}`);
      await transport().send(
        message({
          settings: { path: 'args.sh', args: ['--to', 'ops'], secretArgs: ['--token', 's3cret'] },
        }),
      );
      assert.equal(await readFile(join(dir, 'record.txt'), 'utf8'), '--to|ops|--token|s3cret|');
    });

    it('hands the message body over on stdin', async () => {
      // Rather than only as an argument: a check message can be longer than the platform's argv
      // limit, and a body that vanished at 128 KiB would do so only for the worst outages.
      await script('stdin.sh', `cat > ${join(dir, 'record.txt')}`);
      const result = await transport().send(
        message({ settings: { path: 'stdin.sh' }, body: 'a long message\nwith lines' }),
      );
      assert.ok(result.ok, result.ok ? '' : result.error);
      assert.equal(await readFile(join(dir, 'record.txt'), 'utf8'), 'a long message\nwith lines');
    });

    it('describes the alarm in the environment, so a script needs no arguments at all', async () => {
      await script(
        'env.sh',
        `printf '%s\\n' "$MS_SENSOR" "$MS_DEVICE" "$MS_STATUS" "$MS_LAST_STATUS" "$MS_SITE" > ${join(dir, 'record.txt')}`,
      );
      const result = await transport().send(message({ settings: { path: 'env.sh' } }));
      assert.ok(result.ok, result.ok ? '' : result.error);
      assert.equal(
        await readFile(join(dir, 'record.txt'), 'utf8'),
        'Ping\nedge-router\ndown\nup\nMonitoringSystem\n',
      );
    });

    it('tells a script that nothing was measured, rather than that it measured zero', async () => {
      // No-data is not zero (`CLAUDE.md`). A script doing arithmetic on MS_LAST_VALUE has to be
      // able to tell the two apart.
      await script('value.sh', `printf '[%s]' "$MS_LAST_VALUE" > ${join(dir, 'record.txt')}`);
      const none = await transport().send(
        message({ settings: { path: 'value.sh' }, context: messageContext({ lastValue: null }) }),
      );
      assert.ok(none.ok, none.ok ? '' : none.error);
      assert.equal(await readFile(join(dir, 'record.txt'), 'utf8'), '[]');
      await transport().send(
        message({ settings: { path: 'value.sh' }, context: messageContext({ lastValue: 0 }) }),
      );
      assert.equal(await readFile(join(dir, 'record.txt'), 'utf8'), '[0]');
    });

    it('does not hand the service’s own secrets to the script', async () => {
      // The failure this prevents: MS_NOTIFICATIONS__SMTP__PRIMARY__PASSWORD is a supported
      // override (N-07), so an inherited environment would let any script in the directory read
      // the relay password.
      process.env['MS_NOTIFICATIONS__SMTP__PRIMARY__PASSWORD'] = 'relay-secret';
      await script('leak.sh', `env | grep -c relay-secret > ${join(dir, 'record.txt')}; exit 0`);
      await transport().send(message({ settings: { path: 'leak.sh' } }));
      delete process.env['MS_NOTIFICATIONS__SMTP__PRIMARY__PASSWORD'];
      assert.equal((await readFile(join(dir, 'record.txt'), 'utf8')).trim(), '0');
    });

    it('never runs a shell, so an argument stays an argument', async () => {
      // A device whose SNMP description is `; rm -rf /` reaches an argument through
      // %lastmessage. As argv it is a string; through a shell it is a command.
      await script('inject.sh', `printf '[%s]' "$1" > ${join(dir, 'record.txt')}`);
      await transport().send(
        message({
          settings: { path: 'inject.sh', args: ['%lastmessage'] },
          context: messageContext({ message: '; rm -rf / && echo pwned' }),
        }),
      );
      assert.equal(await readFile(join(dir, 'record.txt'), 'utf8'), '[; rm -rf / && echo pwned]');
    });
  });

  // -----------------------------------------------------------------------------------------
  // What one run means for the delivery.
  // -----------------------------------------------------------------------------------------

  describe('reading the result', () => {
    it('takes exit 0 as delivered', async () => {
      await script('ok.sh', 'echo done; exit 0');
      const result = await transport().send(message({ settings: { path: 'ok.sh' } }));
      assert.ok(result.ok);
      assert.match(result.detail, /ok\.sh exited 0/);
    });

    it('does not run a program again because it said no', async () => {
      // The program is a side effect — it opens a ticket, it sends an SMS, it pulls a lever.
      // Running it five more times because it reported a problem is how one alarm becomes five
      // tickets. A non-zero exit is an answer, not a hiccup.
      await script('no.sh', 'echo "the gateway rejected it" >&2; exit 4');
      const result = await transport().send(message({ settings: { path: 'no.sh' } }));
      assert.ok(!result.ok);
      assert.equal(result.retryable, false);
      assert.match(result.error, /exited 4 — the gateway rejected it/);
    });

    it('will try again after a timeout, because the program never answered', async () => {
      await script('slow.sh', 'sleep 30');
      const result = await transport().send(
        message({ settings: { path: 'slow.sh', timeoutMs: 300 } }),
      );
      assert.ok(!result.ok);
      assert.equal(result.retryable, true);
      assert.match(result.error, /did not finish/);
    });

    it('keeps only what it was told to keep of a chatty program', async () => {
      await script('loud.sh', 'i=0; while [ $i -lt 2000 ]; do echo 0123456789; i=$((i+1)); done; exit 0');
      const result = await transport({ maxOutputBytes: 512 }).send(
        message({ settings: { path: 'loud.sh' } }),
      );
      assert.ok(result.ok, result.ok ? '' : result.error);
    });
  });

  // -----------------------------------------------------------------------------------------
  // The log, which is where the output goes.
  // -----------------------------------------------------------------------------------------

  describe('the journal', () => {
    /** A real logger writing to an array, so the assertions are about what is actually emitted. */
    function capturing(): { logger: Logger; lines: Record<string, unknown>[] } {
      const lines: Record<string, unknown>[] = [];
      const logger = pino({ level: 'trace' }, {
        write: (chunk: string) => {
          lines.push(JSON.parse(chunk) as Record<string, unknown>);
        },
      });
      return { logger, lines };
    }

    it('records what the program said, and never what it was told', async () => {
      // `secretArgs` is a credential. The program's name is worth logging; its arguments are not,
      // and asserting against the serialised line is what proves nothing reached the journal.
      const { logger, lines } = capturing();
      await script('chatty.sh', 'echo "opened ticket 91"; echo "slow" >&2; exit 0');
      await new ProgramTransport({ config: config(), logger }).send(
        message({
          settings: { path: 'chatty.sh', args: ['--user', 'ops'], secretArgs: ['hunter2'] },
        }),
      );

      const [line] = lines;
      assert.ok(line !== undefined, 'nothing was logged');
      assert.equal(line['msg'], 'notification program finished');
      assert.equal(line['stdout'], 'opened ticket 91\n');
      assert.equal(line['stderr'], 'slow\n');
      assert.equal(line['program'], 'chatty.sh');
      assert.ok(!JSON.stringify(line).includes('hunter2'), 'the secret argument was logged');
    });

    it('logs a program that did not succeed at a level that says so', async () => {
      const { logger, lines } = capturing();
      await script('no.sh', 'exit 2');
      await new ProgramTransport({ config: config(), logger }).send(
        message({ settings: { path: 'no.sh' } }),
      );
      const [line] = lines;
      assert.ok(line !== undefined);
      assert.equal(line['level'], 40, 'warn');
      assert.equal(line['msg'], 'notification program did not succeed');
    });
  });

  it('asks for no escaping, because there is no syntax to escape for', () => {
    assert.equal(transport().bodyEscaping(), 'none');
  });
});
