import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { pino } from 'pino';
import type { Logger } from '@ms/shared';
import { DnsSimulator, replies } from '@ms/simulators';
import { buildNameResolution, type NameResolution } from '../../src/resolver/name-resolution.js';
import { RESOLVER_LANES } from '../../src/resolver/name-resolver.js';
import { pollWithin, within } from '../support/within.js';
import { BuildWatch } from './names-build.js';
import {
  ANSWER_A,
  ANSWER_WORLD,
  NAMESERVER,
  SKEW_CASES,
  SKEW_WORLD,
  type SkewCase,
  type SkewRun,
} from './names-differential.js';

/**
 * A file edited under a running ms-probe, then its lookup helper's child SIGKILLed from outside
 * (`P-462`, §7.5's "mid-run edits of gai.conf and nsswitch.conf, then a helper SIGKILL", D28),
 * in a box of its own: `names-skew --case <case> --image <image>`.
 *
 * The box writes a world the check is on for (`SKEW_WORLD`) and puts the S5 simulator at its one
 * server, answering every name, then runs itself again (`--in-situ`) in a process started after
 * that, so that its glibc reads the world afresh: ms-probe's name resolution in gate mode, built as
 * `main.ts` builds it (`buildNameResolution`), with every default, its log read back. In it:
 *
 * 1. the check on and proven and the helper up, and a name answered;
 * 2. the case's file edited (`SKEW_CASES`), and the watch's next look waited for to its end: the
 *    check off, and what the policy and the helper said of it;
 * 3. the helper's child SIGKILLed, the helper waited on to rest or to be up in a new child, and
 *    held there `HOLD_MS`, past every backoff a loss not resting takes; then a second name asked.
 *
 * Prints the case's `SkewRun` as JSON, with the build it loaded (`names-build.ts`).
 */

const SELF = fileURLToPath(import.meta.url);
const PATH = '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
const SERVER = '10.0.0.53';
const BEFORE = 'sw1.example.test';
const AFTER = 'sw2.example.test';
/** Past the watch's look (`WATCH_EVERY_MS`, 5 s), twice over and more. */
const LOOK_MS = 20_000;
/** What the watch logs as the last thing a look that saw a change does (`checkFiles`). */
const LOOK_ENDED = 'the name policy after the change: what the gate routes by';
/** Past the backoffs a loss not resting takes (`HELPER_BACKOFF_MS`, at most 1 s) and a start. */
const SETTLE_MS = 15_000;
/** Held after the helper settled: a rest until restart starts no child in it. */
const HOLD_MS = 5_000;
const IN_SITU_MS = 120_000;
/**
 * A lookup's own bound. Its wait is on the far end of the helper's child, and the helper never
 * keeps a process alive (its child, channel and timers are unref'd): in ms-probe its other handles
 * do, and here this bound's timer does, or the loop drains with the lookup out and the process
 * exits 13 on an unsettled top-level await.
 */
const LOOKUP_MS = 10_000;
const run = promisify(execFile);

/** `answer:<addresses>`, or `error:<code>`. */
async function said(
  lookup: () => Promise<readonly { readonly address: string }[]>,
): Promise<string> {
  try {
    return `answer:${(await lookup()).map((one) => one.address).join(',')}`;
  } catch (error: unknown) {
    const code = (error as { code?: unknown }).code;
    return `error:${typeof code === 'string' ? code : String(error)}`;
  }
}

/** The log as ms-probe's would be, kept as its lines' messages and fields. */
function capturedLogger(): {
  readonly logger: Logger;
  readonly lines: Record<string, unknown>[];
} {
  const lines: Record<string, unknown>[] = [];
  const logger: Logger = pino(
    { level: 'info' },
    {
      write(line: string) {
        try {
          lines.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          // Not a line of ours.
        }
      },
    },
  );
  return { logger, lines };
}

const toHelper = (names: NameResolution): number =>
  names.resolver.gateHealth()?.lookupsToHelper ?? 0;

async function inSitu(which: SkewCase, image: string): Promise<Omit<SkewRun, 'buildDigest'>> {
  const claim = SKEW_CASES[which];
  const setup: string[] = [];
  const { logger, lines } = capturedLogger();
  const spoolDir = mkdtempSync(join(tmpdir(), 'ms-skew-'));
  const names = buildNameResolution({ mode: 'gate', logger, lanes: RESOLVER_LANES, spoolDir });
  const gate = names.gate;
  if (gate === undefined) throw new Error('gate mode built no gate');
  let before: SkewRun['before'];
  let edited: SkewRun['edited'];
  let killed: SkewRun['killed'];
  try {
    await within(30_000, 'ms-probe’s name resolution to start', names.start());
    try {
      await pollWithin(
        10_000,
        'the check on and proven, and the helper up',
        () => names.resolver.gateHealth()?.checkState === 1 && gate.helper.routeState() === 'up',
      );
    } catch (error: unknown) {
      setup.push(String(error));
    }
    before = {
      check: gate.policy.describe().check,
      checkState: names.resolver.gateHealth()?.checkState,
      helper: gate.helper.stats().state,
      answered: await said(() =>
        within(LOOKUP_MS, `${BEFORE} looked up`, names.resolver.resolve(BEFORE, 4, {})),
      ),
    };
    // The edit, as an operator makes it.
    writeFileSync(claim.file, claim.edit);
    try {
      await pollWithin(LOOK_MS, 'the watch to see the edit', () => !gate.policy.checkOn(), 100);
      // The check goes off within the look, before the helper is told of a read-once file (D28):
      // the look's last word is what the gate routes by, said after both were told.
      await pollWithin(LOOK_MS, 'the watch’s look to end', () =>
        lines.some((line) => line['msg'] === LOOK_ENDED),
      );
    } catch (error: unknown) {
      setup.push(String(error));
    }
    const described = gate.policy.describe();
    edited = {
      check: described.check,
      ...(described.shapeOff === undefined
        ? {}
        : { off: { code: described.shapeOff.code, why: described.shapeOff.why } }),
      readOnce: described.readOnce,
      skewed: described.skewed,
      restartSaid: lines
        .filter((line) => String(line['msg']).endsWith('changed: restart ms-probe to apply it'))
        .map((line) => String(line['file'])),
    };
    // The SIGKILL, from outside the helper.
    const killedPid = gate.helper.pid();
    if (killedPid === undefined) setup.push('the helper had no child to kill');
    else process.kill(killedPid, 'SIGKILL');
    try {
      await pollWithin(SETTLE_MS, 'the helper to settle after its loss', () => {
        const now = gate.helper.stats();
        return now.state === 'resting' || (now.state === 'up' && now.pid !== killedPid);
      });
    } catch (error: unknown) {
      setup.push(String(error));
    }
    await sleep(HOLD_MS);
    const stats = gate.helper.stats();
    const sent = toHelper(names);
    const answered = await said(() =>
      within(LOOKUP_MS, `${AFTER} looked up`, names.resolver.resolve(AFTER, 4, {})),
    );
    killed = {
      helper: stats.state,
      route: stats.route,
      ...(stats.restMs === undefined ? {} : { restMs: stats.restMs }),
      respawned: stats.state === 'up' && stats.pid !== undefined && stats.pid !== killedPid,
      mode: names.modeValue(),
      trouble: gate.latch.value(),
      restingSaid: lines.filter((line) =>
        String(line['msg']).startsWith('the lookup helper is resting until ms-probe restarts'),
      ).length,
      answered,
      toHelper: toHelper(names) - sent,
    };
  } catch (error: unknown) {
    setup.push(error instanceof Error ? error.message : String(error));
  } finally {
    await within(20_000, 'ms-probe’s name resolution to stop', names.stop()).catch(
      (error: unknown) => {
        setup.push(String(error));
      },
    );
    rmSync(spoolDir, { recursive: true, force: true });
  }
  return {
    kind: 'skew',
    case: which,
    image,
    glibc: gate.policy.describe().glibc,
    ...(before === undefined ? {} : { before }),
    ...(edited === undefined ? {} : { edited }),
    ...(killed === undefined ? {} : { killed }),
    ...(setup.length > 0 ? { setup } : {}),
  };
}

function again(which: SkewCase, image: string): Promise<Omit<SkewRun, 'buildDigest'>> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SELF, '--case', which, '--image', image, '--in-situ'], {
      env: { PATH, UV_THREADPOOL_SIZE: '16' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (err = `${err}${chunk.toString()}`.slice(-4_000)));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`the in-situ process did not end within ${String(IN_SITU_MS)} ms: ${err}`));
    }, IN_SITU_MS);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(out) as Omit<SkewRun, 'buildDigest'>);
      } catch {
        reject(
          new Error(
            `the in-situ process exited ${String(code)} saying ${JSON.stringify(out + err)}`,
          ),
        );
      }
    });
  });
}

/** The world the check is on for, and its server on `lo`: what could not be set up is returned. */
async function setUp(): Promise<string[]> {
  const problems: string[] = [];
  for (const [path, text] of Object.entries(SKEW_WORLD)) {
    try {
      writeFileSync(path, text);
    } catch (error: unknown) {
      problems.push(`could not set ${path} up: ${String(error)}`);
    }
  }
  try {
    writeFileSync('/proc/sys/kernel/hostname', ANSWER_WORLD.hostname);
  } catch (error: unknown) {
    problems.push(`could not set the hostname: ${String(error)}`);
  }
  try {
    await run('ip', ['addr', 'add', `${SERVER}/32`, 'dev', 'lo']);
  } catch (error: unknown) {
    const words = (error as { stderr?: unknown }).stderr;
    if (typeof words !== 'string' || !words.includes('File exists')) {
      problems.push(`could not put ${SERVER} on lo: ${String(error)}`);
    }
  }
  return problems;
}

const argv = process.argv.slice(2);
const which = argv[argv.indexOf('--case') + 1] as SkewCase;
const image = argv[argv.indexOf('--image') + 1] ?? 'unknown';
if (!Object.hasOwn(SKEW_CASES, which)) {
  throw new Error(`usage: names-skew --case ${Object.keys(SKEW_CASES).join('|')} --image <image>`);
}
if (argv.includes('--in-situ')) {
  process.stdout.write(`${JSON.stringify(await inSitu(which, image))}\n`);
  // The helper's child is stopped with the resolution; nothing else of the run is left.
  process.exit(0);
} else {
  const build = new BuildWatch();
  const setup = await setUp();
  const sim = await DnsSimulator.start({
    servers: [
      {
        ...NAMESERVER,
        name: SERVER,
        address: SERVER,
        port: 53,
        ipv6: false,
        fallback: { a: replies.addresses(ANSWER_A), aaaa: replies.nodata },
      },
    ],
    ipv6: false,
  });
  let found: Omit<SkewRun, 'buildDigest'>;
  try {
    found = await again(which, image);
  } finally {
    await sim.stop();
  }
  build.look('at the end');
  const result: SkewRun = {
    ...found,
    ...(setup.length > 0 ? { setup: [...setup, ...(found.setup ?? [])] } : {}),
    ...build.fields(),
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
