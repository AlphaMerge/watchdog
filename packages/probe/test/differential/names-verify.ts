import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildDigest } from './names-build.js';
import {
  answerRowsDigest,
  digestOf,
  parseRun,
  recordingsFile,
  verify,
  verifyBoxes,
  type BudgetRun,
  type ImageRun,
  type OffRun,
  type RowsFile,
} from './names-differential.js';

/**
 * The differential's verdict (`P-432` S8, `P-460`, `P-461`): `names-verify <rows.json> <run.json>…`.
 * Prints the recordings file on stdout when every row of every image verified, glibc's wire and
 * the walk's, every answer row held, and every budget box and box with the check off held; and
 * exits 0. Otherwise prints every problem on stderr and exits 1, with nothing on stdout. Every image
 * the rows name, every budget box and every off box must be among the runs: an unverified row
 * fails the run (D30). Each image's run must have replayed this rows file and these answer rows
 * and loaded this build of the policy (`dist/src/resolver/system-names.js`), by sha256; and every
 * run, an image's or a box's, this build of all the boxes load (`names-build.ts`), unchanged while
 * it ran. A run file that is not a run (a replay that stopped leaves it empty) is a problem of its
 * own, and the others are judged all the same.
 */
const POLICY = fileURLToPath(new URL('../../src/resolver/system-names.js', import.meta.url));

const [rowsPath, ...runPaths] = process.argv.slice(2);
if (rowsPath === undefined || runPaths.length === 0) {
  process.stderr.write('usage: names-verify <rows.json> <run.json>...\n');
  process.exit(2);
}
const rowsBytes = readFileSync(rowsPath);
const rows = JSON.parse(rowsBytes.toString('utf8')) as RowsFile;
const runs: ImageRun[] = [];
const budget: BudgetRun[] = [];
const off: OffRun[] = [];
const unread: string[] = [];
for (const path of runPaths) {
  const parsed = parseRun(path, readFileSync(path, 'utf8'));
  if ('run' in parsed) runs.push(parsed.run);
  else if ('budget' in parsed) budget.push(parsed.budget);
  else if ('off' in parsed) off.push(parsed.off);
  else unread.push(parsed.problem);
}
const current = {
  rowsDigest: digestOf(rowsBytes),
  policyDigest: digestOf(readFileSync(POLICY)),
  answerRowsDigest: answerRowsDigest(),
  buildDigest: buildDigest(),
};
const verified = verify(rows, runs, current);
for (const [image, count] of Object.entries(verified.counts)) {
  process.stderr.write(
    `${image}: ${String(count.rows)} rows, ${String(count.plans)} plans recorded\n`,
  );
}
process.stderr.write(`answer rows: ${String(verified.answerRecordings.length)} plans recorded\n`);
for (const box of budget) {
  for (const arm of box.arms) {
    process.stderr.write(
      `budget ${box.forwarder} ${arm.arm}: ${String(arm.peakHeld)} distinct questions held at once at most, ${String(arm.distinct)} in all${arm.maxReached === undefined ? '' : `, table full ${String(arm.maxReached)} times`}\n`,
    );
  }
}
for (const box of off) {
  process.stderr.write(
    `off ${box.case} in ${box.image}: check ${box.check}${box.off === undefined ? '' : ` by ${box.off.code} (${box.off.why})`}, route ${String(box.route)}, ${Array.isArray(box.asked) ? `${String(box.asked.length)} questions asked` : 'what it asked not recorded'}\n`,
  );
}
process.stderr.write(`build ${current.buildDigest}\n`);
const problems = [...unread, ...verified.problems, ...verifyBoxes(budget, off, current)];
if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`DISAGREES ${problem}\n`);
  process.stderr.write(`${String(problems.length)} problems: nothing recorded\n`);
  process.exit(1);
}
process.stdout.write(`${JSON.stringify(recordingsFile(runs, verified), null, 2)}\n`);
