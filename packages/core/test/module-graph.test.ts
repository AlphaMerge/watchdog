import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

/**
 * What a core's module graph loads, by profile (`H-19`).
 *
 * **Read from the loader, not from the source.** A child process records every module the
 * resolver hands back while it imports `main.js` — the whole static graph of the service, which
 * is what every build loads whether or not it constructs anything. The full profile then takes
 * the one dynamic import it adds, through the same function `startV2Subsystems` calls. Grepping
 * for `pdfkit` would miss the path that mattered here: a re-export two modules away.
 *
 * **A full core loads the two in different threads.** `fontkit` is on the main thread, because
 * the fonts are checked at start-up. `pdfkit` is only in the formatting worker (`P-204`), whose
 * graph is recorded separately, from `format-job.js`: the worker's entry module refuses to run
 * outside a worker thread, and loads nothing else.
 *
 * `main.js` runs nothing when imported (`main.ts` checks `process.argv[1]`), so this starts no
 * server and needs no database.
 */

const MAIN = new URL('../src/main.js', import.meta.url).href;
const PROFILE = new URL('../src/profile.js', import.meta.url).href;
const FORMAT_JOB = new URL('../src/reports/format-job.js', import.meta.url).href;

// The line the child's report is on, so that anything else a module writes to stdout is not parsed.
const MARK = 'module-graph:';

const LOAD_BOUND_MS = 240_000;

type Graph = 'v1' | 'full' | 'format worker';

/** Every module URL the child resolved while loading one graph. */
function loadedModules(graph: Graph): readonly string[] {
  const load = {
    v1: `await import(${JSON.stringify(MAIN)});`,
    full: `await import(${JSON.stringify(MAIN)});
      await (await import(${JSON.stringify(PROFILE)})).loadReporting();`,
    'format worker': `await import(${JSON.stringify(FORMAT_JOB)});`,
  }[graph];
  const script = `
    import { registerHooks } from 'node:module';
    const seen = [];
    registerHooks({
      resolve(specifier, context, nextResolve) {
        const resolved = nextResolve(specifier, context);
        seen.push(resolved.url);
        return resolved;
      },
    });
    ${load}
    process.stdout.write('\\n' + ${JSON.stringify(MARK)} + JSON.stringify(seen) + '\\n');
  `;
  // Its own bound: a child that hangs is killed, and the test fails saying so rather than as a
  // wrong graph. Wide, because loading the whole service took 30 s at a load of 40. At 60 s,
  // one run under a load near 75 failed the v1 case, and the same graph passed straight after.
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    encoding: 'utf8',
    timeout: LOAD_BOUND_MS,
  });
  assert.equal(
    child.signal,
    null,
    `the ${graph} graph did not finish loading within ${String(LOAD_BOUND_MS / 1_000)} s`,
  );
  const output = `${child.stdout}${child.stderr}`;
  assert.equal(child.status, 0, `the ${graph} graph loads: ${output}`);
  const report = child.stdout.split('\n').find((line) => line.startsWith(MARK));
  assert.ok(report !== undefined, `the ${graph} graph reports what it loaded: ${output}`);
  return JSON.parse(report.slice(MARK.length)) as string[];
}

function loads(modules: readonly string[], name: string): boolean {
  return modules.some((url) => url.includes(`/node_modules/${name}/`));
}

describe('what a core build loads (H-19)', () => {
  it('a v1 core loads neither pdfkit nor fontkit', () => {
    const modules = loadedModules('v1');
    // Presence first: a hook that recorded nothing would pass the two refusals below.
    assert.ok(loads(modules, 'fastify'), 'the recorded graph includes fastify');
    assert.ok(modules.includes(MAIN), 'the recorded graph includes main.js');
    assert.equal(loads(modules, 'pdfkit'), false, 'a v1 core loads pdfkit');
    assert.equal(loads(modules, 'fontkit'), false, 'a v1 core loads fontkit');
  });

  it('a full core loads both, so the check above can fail', () => {
    assert.ok(loads(loadedModules('full'), 'fontkit'), 'a full core loads fontkit');
    const worker = loadedModules('format worker');
    assert.ok(loads(worker, 'pdfkit'), 'its formatting worker loads pdfkit');
    assert.ok(loads(worker, 'fontkit'), 'its formatting worker loads fontkit');
  });
});
