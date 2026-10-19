import { readFileSync } from 'node:fs';
import { recordingsFile, verify, type ImageRun, type RowsFile } from './names-differential.js';

/**
 * The differential's verdict (`P-432` S8): `names-verify <rows.json> <run.json>…`. Prints the
 * recordings file on stdout when every row of every image verified, and exits 0; otherwise prints
 * every problem on stderr and exits 1, with nothing on stdout. Every image the rows name must be
 * among the runs: an unverified row fails the run (D30).
 */
const [rowsPath, ...runPaths] = process.argv.slice(2);
if (rowsPath === undefined || runPaths.length === 0) {
  process.stderr.write('usage: names-verify <rows.json> <run.json>...\n');
  process.exit(2);
}
const rows = JSON.parse(readFileSync(rowsPath, 'utf8')) as RowsFile;
const runs = runPaths.map((path) => JSON.parse(readFileSync(path, 'utf8')) as ImageRun);
const verified = verify(rows, runs);
for (const [image, count] of Object.entries(verified.counts)) {
  process.stderr.write(
    `${image}: ${String(count.rows)} rows, ${String(count.plans)} plans recorded\n`,
  );
}
if (verified.problems.length > 0) {
  for (const problem of verified.problems) process.stderr.write(`DISAGREES ${problem}\n`);
  process.stderr.write(`${String(verified.problems.length)} problems: nothing recorded\n`);
  process.exit(1);
}
process.stdout.write(`${JSON.stringify(recordingsFile(runs, verified), null, 2)}\n`);
