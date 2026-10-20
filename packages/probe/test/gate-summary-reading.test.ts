import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { ResolvedAddress } from '@ms/sensors';
import { createLogger } from '@ms/shared';
import { buildNameResolution, olderCoreWarning } from '../src/resolver/name-resolution.js';
import { GATE_SUMMARY_MS, GATE_TICK_MS } from '../src/resolver/name-resolver.js';
import type { SystemFiles } from '../src/resolver/system-names.js';
import { pollWithin, within } from './support/within.js';

/**
 * The field test's reading of the gate's hourly summary (`P-467`'s review, fix round 1): the
 * runbook's step 4 and drill, and the administration guide, held to the lines a gate probe
 * writes. The probe is built as `main.ts` builds it, with the production logger and the real
 * lookup helper on the scripted child, through four hours: its start, a crash, a child that stops
 * answering and answers again, and a hang.
 *
 * - **What the summaries' `changes` list** in each, as chains of states, which step 4's criterion
 *   names as a pass (the start, and each loss's moves) or a finding (a quiet spell with no loss).
 *   The first summary lists the helper's own start, which the criterion once left out.
 * - **Step 4's commands, run as written** on the lines: the collection keeps every summary and
 *   every warning of the gate's components, the older core's warning among them, and each
 *   reading command prints one match a line that is that hour's value, not a running total.
 *   The guide's table of the log's lines has a row for every warning logged.
 * - **When the summary comes**: an hour after the start under `"gate"`, and never under
 *   `"system"`, as the drill says.
 */

const CHILD = join(import.meta.dirname, 'support', 'scripted-helper-child.js');
const WAIT = 30_000;
/** A shell command the runbook gives, run with its own bound. */
const RUN_MS = 10_000;
const SUMMARY = 'the probe’s resolver in gate mode, this hour';
const PROBE_LANES: readonly ResolvedAddress[] = [{ address: '192.0.2.99', family: 4 }];
const REPO = join(import.meta.dirname, '..', '..', '..', '..');

const dir = mkdtempSync(join(tmpdir(), 'ms-gate-summary-'));
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

type Line = Record<string, unknown>;

interface Change {
  readonly from: string;
  readonly to: string;
  readonly loss?: string;
}

/** The production logger, its lines kept as written. */
function productionLog(): { logger: ReturnType<typeof createLogger>; raw: string[] } {
  const raw: string[] = [];
  const logger = createLogger({
    name: 'ms-probe',
    level: 'info',
    destination: {
      write: (line: string) => {
        raw.push(line);
      },
    },
  });
  return { logger, raw };
}

function systemFiles(base: string): SystemFiles {
  const files: SystemFiles = {
    hosts: join(base, 'hosts'),
    resolvConf: join(base, 'resolv.conf'),
    nsswitchConf: join(base, 'nsswitch.conf'),
    gaiConf: join(base, 'gai.conf'),
    ldSoPreload: join(base, 'ld.so.preload'),
    nscdSocket: join(base, 'nscd.socket'),
  };
  writeFileSync(files.hosts, '127.0.0.1 localhost\n');
  writeFileSync(files.resolvConf, 'nameserver 192.0.2.53\n');
  writeFileSync(files.nsswitchConf, 'hosts: files dns\n');
  return files;
}

/** A document, its whitespace run together, as a reader reads a paragraph. */
function flat(file: string): string {
  return readFileSync(join(REPO, 'docs', file), 'utf8').replace(/\s+/g, ' ');
}

/** The runbook's fenced bash blocks, each without its list indentation. */
function bashBlocks(): string[] {
  const text = readFileSync(join(REPO, 'docs', 'runbook-field-test.md'), 'utf8');
  return [...text.matchAll(/^( *)```bash\n([\s\S]*?)^\1```/gm)].map(([, indent, body]) =>
    (body ?? '')
      .split('\n')
      .map((line) => line.slice((indent ?? '').length))
      .join('\n'),
  );
}

/** A chain of states, as the documents write one: `up` → `backoff`. */
const chainOf = (changes: readonly Change[]): string =>
  [changes[0]?.from ?? '', ...changes.map((change) => change.to)]
    .map((state) => `\`${state}\``)
    .join(' → ');

/** The value at `path`, or undefined. */
function at(value: unknown, path: readonly string[]): unknown {
  let here = value;
  for (const key of path) {
    if (typeof here !== 'object' || here === null) return undefined;
    here = (here as Record<string, unknown>)[key];
  }
  return here;
}

/**
 * What one command printed for one hour, read as JSON: the whole line, or the fragment
 * `"key":value` a `grep -o` prints, whose object a pattern may stop short of closing.
 */
function readOutput(output: string): Line | undefined {
  for (const text of [output, `{${output}}`, `{${output}}}`]) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === 'object' && parsed !== null) return parsed as Line;
    } catch {
      // Not this shape.
    }
  }
  return undefined;
}

/**
 * Whether `read` holds the summary's value at `path`: a whole line at the path itself, a
 * fragment at the part of it that starts with the fragment's key.
 */
function holds(read: Line, summary: Line, path: readonly string[]): boolean {
  const want = at(summary, path);
  if (read['msg'] === SUMMARY) return JSON.stringify(at(read, path)) === JSON.stringify(want);
  const [key] = Object.keys(read);
  const from = path.indexOf(key ?? '');
  if (from < 0) return false;
  return JSON.stringify(at(read, path.slice(from))) === JSON.stringify(want);
}

describe('the field test’s reading of the gate’s hourly summary (P-467)', () => {
  it('lists the helper’s start and each loss’s moves as the runbook says a pass does, and step 4’s commands read each hour’s own values', async () => {
    const { logger, raw } = productionLog();
    const lines = (): Line[] => raw.map((line) => JSON.parse(line) as Line);
    const summaries = (): Line[] => lines().filter((line) => line['msg'] === SUMMARY);
    const base = mkdtempSync(join(dir, 'gate-'));
    const files = systemFiles(base);
    const clock = { now: 1_000_000 };
    const names = buildNameResolution({
      mode: 'gate',
      logger,
      lanes: 6,
      spoolDir: base,
      helper: { childModule: CHILD, limits: { beatMs: 25, tickMs: 100 } },
      // The check not built: every name not the hosts file's goes to the helper, and the
      // summary's `check` is off, with its reason.
      policy: { files, platform: 'linux', env: {}, checkBuilt: false },
      resolver: {
        now: () => clock.now,
        lookup: () => Promise.resolve(PROBE_LANES),
        watch: {
          files: [files.hosts, files.resolvConf, files.nsswitchConf, files.gaiConf],
          everyMs: 60_000,
        },
      },
    });
    const gate = names.gate;
    assert.ok(gate !== undefined);
    /** The hour's summary: the resolver's clock an hour on, and the line its tick then logs. */
    const nextSummary = async (seen: number, advance = GATE_SUMMARY_MS): Promise<Line> => {
      clock.now += advance;
      await pollWithin(WAIT, `summary ${String(seen + 1)}`, () => summaries().length > seen, 20);
      const line = summaries()[seen];
      assert.ok(line !== undefined);
      return line;
    };
    try {
      await within(WAIT, 'the start', names.start());
      assert.equal(gate.helper.state, 'up');
      // A core below protocol 38 meets it: the warning step 4 keeps with the gate's others.
      olderCoreWarning(logger, names.mode).heartbeat(37);

      // Hour 1: the start, and a name asked in the helper. Nothing is summed before the hour.
      await within(WAIT, 'a name', names.resolver.resolve('delay-5.ok.test', 4, {}));
      clock.now += GATE_SUMMARY_MS - 1;
      await new Promise((resolve) => setTimeout(resolve, GATE_TICK_MS * 1.5));
      assert.equal(summaries().length, 0, 'no summary before an hour since the start');
      const first = await nextSummary(0, 1);

      // Hour 2: another name asked, and a lookup crashes the child once, a loss of reason `exit`
      // (asked of the helper alone, so nothing asks it again: the helper only says it may be).
      await within(WAIT, 'a name', names.resolver.resolve('delay-6.ok.test', 4, {}));
      const once = `crash-unless:${join(base, 'crashed-once')}`;
      const crashed = gate.helper.ask({ host: once, family: 4, max: 64 }).then(
        () => 'answered',
        (error: unknown) => (error as { reason?: unknown }).reason,
      );
      assert.equal(await within(WAIT, 'the crash', crashed), 'exit');
      await pollWithin(
        WAIT,
        () => `a new child up after the crash: ${JSON.stringify(gate.helper.stats())}`,
        () => gate.helper.stats().losses === 1 && gate.helper.state === 'up',
        10,
      );
      const second = await nextSummary(1);

      // Hour 3: the child stops answering, and answers again with no loss.
      const pid = gate.helper.pid();
      assert.ok(pid !== undefined);
      await within(WAIT, 'muted', gate.helper.ask({ host: 'test-mute', family: 4, max: 64 }));
      await pollWithin(WAIT, 'not answering', () => gate.helper.state === 'unresponsive', 10);
      process.kill(pid, 'SIGUSR2');
      await pollWithin(WAIT, 'answering again', () => gate.helper.state === 'up', 10);
      assert.equal(gate.helper.stats().losses, 1, 'no loss');
      const third = await nextSummary(2);

      // Hour 4: it stops answering for good, is killed as hung, and is started again.
      await within(WAIT, 'muted', gate.helper.ask({ host: 'test-mute', family: 4, max: 64 }));
      await pollWithin(
        WAIT,
        'a new child up after the hang',
        () => gate.helper.stats().losses === 2 && gate.helper.state === 'up',
        10,
      );
      const fourth = await nextSummary(3);
      const hours = [first, second, third, fourth];

      // What the summaries list, as chains of states.
      const changes = hours.map((hour) =>
        (at(hour, ['helper', 'changes']) as Change[]).map(({ from, to, loss }) => ({
          from,
          to,
          ...(loss === undefined ? {} : { loss }),
        })),
      );
      assert.deepEqual(changes, [
        [
          { from: 'idle', to: 'starting' },
          { from: 'starting', to: 'up' },
        ],
        [
          { from: 'up', to: 'backoff', loss: 'exit' },
          { from: 'backoff', to: 'starting' },
          { from: 'starting', to: 'up' },
        ],
        [
          { from: 'up', to: 'unresponsive' },
          { from: 'unresponsive', to: 'up' },
        ],
        [
          { from: 'up', to: 'unresponsive' },
          { from: 'unresponsive', to: 'backoff', loss: 'hung' },
          { from: 'backoff', to: 'starting' },
          { from: 'starting', to: 'up' },
        ],
      ]);
      const lost = hours.map((hour) =>
        (at(hour, ['helper', 'lost']) as Line[]).map((loss) => loss['reason']),
      );
      assert.deepEqual(lost, [[], ['exit'], [], ['hung']]);
      const [start, crash, quiet, hang] = changes.map(chainOf);

      // Step 4 names the start and each loss's moves as a pass, and the quiet spell a finding.
      const runbook = flat('runbook-field-test.md');
      const from = runbook.indexOf('- **No loss and no rest.**');
      const to = runbook.indexOf(' - ', from + 1);
      assert.ok(from >= 0 && to > from, 'step 4 has no criterion for losses and rests');
      const criterion = runbook.slice(from, to);
      const split = criterion.indexOf('Anything else in `changes` is a finding');
      assert.ok(split >= 0, 'the criterion does not say what else in `changes` is a finding');
      const pass = criterion.slice(0, split);
      for (const chain of [start, crash, hang]) {
        assert.ok(pass.includes(chain ?? ''), `step 4 does not name ${chain ?? ''} as a pass`);
      }
      assert.ok(
        criterion.slice(split).includes(`${quiet ?? ''} with no loss`),
        `step 4 does not name ${quiet ?? ''} with no loss as a finding`,
      );
      // The administration guide says the same of the start and a loss's way back.
      const guide = flat('administration.md');
      assert.ok(guide.includes(start ?? ''), `the guide does not name ${start ?? ''}`);
      assert.ok(
        guide.includes(chainOf(changes[1]?.slice(1) ?? [])),
        'the guide does not name a loss’s way back',
      );

      // Step 4's collection, run on the probe's log as `journalctl -o cat` prints it.
      const run = mkdtempSync(join(dir, 'run-'));
      writeFileSync(join(run, 'ms-probe.log'), raw.join(''));
      const blocks = bashBlocks();
      const collect = blocks.find((block) => block.includes('> gate-hours.jsonl'));
      assert.ok(collect !== undefined, 'step 4 has no command that keeps the summaries');
      const journal = 'sudo journalctl -u ms-probe --since "$SINCE" --no-pager -o cat';
      assert.equal(collect.split(journal).length - 1, 2, 'both commands read the journal');
      const collected = spawnSync('bash', ['-c', collect.replaceAll(journal, 'cat ms-probe.log')], {
        cwd: run,
        encoding: 'utf8',
        timeout: RUN_MS,
      });
      assert.equal(collected.stderr, '', 'the collection writes no error');
      const kept = (name: string): string[] =>
        readFileSync(join(run, name), 'utf8')
          .split('\n')
          .filter((line) => line !== '');
      assert.deepEqual(
        kept('gate-hours.jsonl'),
        raw.filter((line) => line.includes(SUMMARY)).map((line) => line.trimEnd()),
        'one line an hour',
      );
      const warnings = raw
        .map((line) => line.trimEnd())
        .filter((line) => {
          const level = (JSON.parse(line) as Line)['level'];
          return level === 'warn' || level === 'error';
        });
      assert.ok(
        warnings.some((line) => line.includes('this core is older than protocol 38')),
        'the older core was warned of',
      );
      assert.ok(warnings.length >= 3, `the hours’ warnings: ${String(warnings.length)}`);
      assert.deepEqual(kept('gate-events.jsonl'), warnings, 'every warning of the gate is kept');
      // The guide's table of the log's lines has a row for each of them, by how its `msg` starts.
      const guideFrom = guide.indexOf("**What the probe's log says of it**");
      const guideTo = guide.indexOf('**The hourly summary**', guideFrom);
      assert.ok(guideFrom >= 0 && guideTo > guideFrom, 'the guide has no table of the log’s lines');
      const rows = [...guide.slice(guideFrom, guideTo).matchAll(/`([^`]+)`/g)].map((match) =>
        (match[1] ?? '').replace(/ ?…$/u, ''),
      );
      for (const line of warnings) {
        const msg = String((JSON.parse(line) as Line)['msg']);
        assert.ok(
          rows.some((row) => row.length > 10 && msg.startsWith(row)),
          `the guide’s table has no row for ${msg}`,
        );
      }
      // The start line is found by the component the drill greps for.
      const started = lines().find((line) =>
        String(line['msg']).startsWith('probe.nameResolver is gate'),
      );
      assert.equal(started?.['component'], 'name-resolver');

      // Step 4's reading commands, each run on each hour's line alone.
      const reading = blocks.find((block) => block.includes('grep -o'));
      assert.ok(reading !== undefined, 'step 4 has no commands that read a field');
      const commands = reading
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.startsWith('#'));
      assert.ok(commands.length >= 6, `${String(commands.length)} reading commands`);
      const outputs = hours.map((_, index) => {
        const file = `hour-${String(index + 1)}.jsonl`;
        writeFileSync(join(run, file), `${kept('gate-hours.jsonl')[index] ?? ''}\n`);
        return commands.map((command) => {
          assert.ok(command.includes('gate-hours.jsonl'), `${command} reads the hours’ file`);
          const done = spawnSync('bash', ['-c', command.replaceAll('gate-hours.jsonl', file)], {
            cwd: run,
            encoding: 'utf8',
            timeout: RUN_MS,
          });
          assert.equal(done.stderr, '', `${command} writes no warning or error`);
          assert.ok(done.status === 0 || done.status === 1, `${command} ran`);
          const printed = done.stdout.split('\n').filter((line) => line !== '');
          assert.ok(
            printed.length <= 1,
            `${command} printed ${String(printed.length)} for an hour`,
          );
          return printed[0];
        });
      });
      // Every field a criterion reads, read as that hour's value by one of them.
      const fields: readonly (readonly string[])[] = [
        ['hour', 'lookupsHeard'],
        ['hour', 'lookupsToHelper'],
        ['hour', 'misses'],
        ['hour', 'walksDeferred'],
        ['hour', 'passedStuck'],
        ['hour', 'helperStuck'],
        ['check', 'state'],
        ['check', 'off'],
        ['helper', 'rss'],
        ['helper', 'losses'],
        ['helper', 'changes'],
      ];
      // The hour's count and the running total differ from the second hour on.
      assert.equal(at(second, ['hour', 'lookupsToHelper']), 1);
      assert.equal(second['lookupsToHelper'], 2);
      assert.equal(at(second, ['check', 'state']), 2, 'the check off, as built');
      hours.forEach((hour, index) => {
        const read = (outputs[index] ?? [])
          .filter((output): output is string => output !== undefined)
          .map(readOutput)
          .filter((output): output is Line => output !== undefined);
        for (const path of fields) {
          assert.ok(
            read.some((output) => holds(output, hour, path)),
            `hour ${String(index + 1)}: no command reads ${path.join('.')} as ${JSON.stringify(at(hour, path))}`,
          );
        }
        // The hours that list a loss, and only those, printed whole.
        const losses = (at(hour, ['helper', 'lost']) as unknown[]).length;
        assert.equal(
          read.some((output) => output['msg'] === SUMMARY),
          losses > 0,
          `hour ${String(index + 1)} lists ${String(losses)} losses`,
        );
      });
      rmSync(run, { recursive: true, force: true });
    } finally {
      await within(WAIT, 'the stop', names.stop());
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('under "system" logs no hourly summary, as the drill says, and under "gate" the first an hour after the start', async () => {
    const { logger, raw } = productionLog();
    const clock = { now: 1_000_000 };
    const names = buildNameResolution({
      mode: 'system',
      logger,
      lanes: 6,
      spoolDir: mkdtempSync(join(dir, 'system-')),
      resolver: {
        now: () => clock.now,
        lookup: () => Promise.resolve(PROBE_LANES),
        watch: { files: [], everyMs: 60_000 },
      },
    });
    try {
      await names.start();
      clock.now += 2 * GATE_SUMMARY_MS;
      await new Promise((resolve) => setTimeout(resolve, GATE_TICK_MS * 2.5));
      assert.equal(raw.filter((line) => line.includes(SUMMARY)).length, 0);
    } finally {
      await names.stop();
    }
    // The drill: none under "system", and under "gate" the first an hour after step 2's restart.
    assert.equal(GATE_SUMMARY_MS, 3_600_000, 'an hour');
    const runbook = flat('runbook-field-test.md');
    const from = runbook.indexOf('### After the end reading: the gate drill');
    const to = runbook.indexOf('## 5.', from);
    assert.ok(from >= 0 && to > from, 'the runbook has no gate drill');
    const drill = runbook.slice(from, to);
    assert.ok(
      drill.includes('Under `"system"` there is none.'),
      'the drill expects a summary under system',
    );
    assert.ok(
      drill.includes("is logged an hour after step 2's restart"),
      'the drill does not say when the first summary is logged',
    );
  });
});
