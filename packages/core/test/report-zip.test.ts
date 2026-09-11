import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { inflateRawSync } from 'node:zlib';
import { buildZip } from '../src/reports/zip.js';

/**
 * The hand-written ZIP writer (`E-09`).
 *
 * **A format nobody else validates for us**, which is the cost of not taking a dependency and the
 * reason these cases are worth more than usual. Two kinds of assertion: the bytes are checked
 * against the specification directly, and — where the machine has one — the archive is handed to
 * a real `unzip` and asked whether it is an archive at all. An implementation that satisfies only
 * its own reader is an implementation that satisfies only its own reader.
 */

const LOCAL_HEADER = 0x04_03_4b_50;
const CENTRAL_HEADER = 0x02_01_4b_50;
const END_OF_CENTRAL = 0x06_05_4b_50;
const AT = new Date('2026-09-11T14:30:00Z');

/** Whether this machine has an `unzip` to check our homework with. */
function unzipAvailable(): boolean {
  try {
    execFileSync('unzip', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const hasUnzip = unzipAvailable();

describe('a ZIP archive', () => {
  it('starts with a local header and ends with an end-of-central-directory record', () => {
    const zip = buildZip([{ name: 'a.txt', content: Buffer.from('hello') }], AT);
    assert.equal(zip.readUInt32LE(0), LOCAL_HEADER);
    assert.equal(zip.readUInt32LE(zip.length - 22), END_OF_CENTRAL);
    assert.equal(zip.readUInt16LE(zip.length - 22 + 8), 1, 'one entry on this disk');
    assert.equal(zip.readUInt16LE(zip.length - 22 + 10), 1, 'one entry in total');
  });

  it('points the central directory at where the local header actually is', () => {
    // The offset is the one field a reader cannot recover if it is wrong, and the one most likely
    // to drift when an entry's size changes. Two entries, so the second offset is not zero.
    const zip = buildZip(
      [
        { name: 'first.csv', content: Buffer.from('a,b,c\n'.repeat(50)) },
        { name: 'second.csv', content: Buffer.from('x\n') },
      ],
      AT,
    );
    const end = zip.length - 22;
    const directoryAt = zip.readUInt32LE(end + 16);
    let cursor = directoryAt;
    for (let entry = 0; entry < 2; entry += 1) {
      assert.equal(zip.readUInt32LE(cursor), CENTRAL_HEADER, `entry ${String(entry)} header`);
      const nameLength = zip.readUInt16LE(cursor + 28);
      const localAt = zip.readUInt32LE(cursor + 42);
      assert.equal(
        zip.readUInt32LE(localAt),
        LOCAL_HEADER,
        `entry ${String(entry)} points at something that is not a local header`,
      );
      cursor += 46 + nameLength + zip.readUInt16LE(cursor + 30) + zip.readUInt16LE(cursor + 32);
    }
    assert.equal(cursor, directoryAt + zip.readUInt32LE(end + 12), 'the directory size is right');
  });

  it('deflates what compresses and stores what does not', () => {
    // A ZIP larger than its contents is a poor advertisement for the option, and a tiny entry is
    // exactly where deflate loses.
    const compressible = buildZip(
      [{ name: 'a.html', content: Buffer.from('<td>-</td>'.repeat(500)) }],
      AT,
    );
    assert.equal(compressible.readUInt16LE(8), 8, 'deflated');
    assert.ok(compressible.length < 5_000, `${String(compressible.length)} bytes`);

    const tiny = buildZip([{ name: 'a.txt', content: Buffer.from('x') }], AT);
    assert.equal(tiny.readUInt16LE(8), 0, 'stored');
  });

  it('round-trips the exact bytes through inflate', () => {
    const body = Buffer.from('Zeit,Wert\n2026-09-01T00:00:00Z,12.5\n'.repeat(40), 'utf8');
    const zip = buildZip([{ name: 'r.csv', content: body }], AT);
    const nameLength = zip.readUInt16LE(26);
    const compressedLength = zip.readUInt32LE(18);
    const start = 30 + nameLength + zip.readUInt16LE(28);
    const stored = zip.subarray(start, start + compressedLength);
    assert.deepEqual(inflateRawSync(stored), body);
    assert.equal(zip.readUInt32LE(22), body.length, 'and declares the uncompressed length');
  });

  it('marks names UTF-8, so a name with an umlaut survives the trip', () => {
    // Without bit 11 a name is read in the archiver's code page, which on a Windows desktop is
    // not UTF-8 — and a report is named after an operator's own title.
    const zip = buildZip([{ name: 'Bürorouter.csv', content: Buffer.from('x') }], AT);
    assert.equal(zip.readUInt16LE(6) & 0x08_00, 0x08_00, 'the UTF-8 flag is set');
    const nameLength = zip.readUInt16LE(26);
    assert.equal(zip.subarray(30, 30 + nameLength).toString('utf8'), 'Bürorouter.csv');
  });

  it('will not let an entry name escape the archive', () => {
    // **Zip Slip.** An entry called `../../etc/cron.d/x` is extracted *there* by a great many
    // tools, and the name is built from an operator's string.
    for (const [name, expected] of [
      ['../../etc/cron.d/x', 'x'],
      ['..\\..\\windows\\system32\\a.dll', 'a.dll'],
      ['/absolute/path.csv', 'path.csv'],
      ['..', 'file'],
      ['', 'file'],
    ] as const) {
      const zip = buildZip([{ name, content: Buffer.from('x') }], AT);
      const nameLength = zip.readUInt16LE(26);
      assert.equal(zip.subarray(30, 30 + nameLength).toString('utf8'), expected, name);
    }
  });

  it('writes the same bytes for the same inputs, whatever the server’s zone', () => {
    // The format has nowhere to put a zone, so a local timestamp is a number that means something
    // different to everyone who opens it — and two cores would produce different archives from
    // the same report.
    const once = buildZip([{ name: 'a.csv', content: Buffer.from('x,y\n') }], AT);
    const again = buildZip([{ name: 'a.csv', content: Buffer.from('x,y\n') }], AT);
    assert.deepEqual(once, again);
    // 14:30:00 UTC on 2026-09-11 in MS-DOS: time = 14<<11 | 30<<5, date = 46<<9 | 9<<5 | 11.
    assert.equal(once.readUInt16LE(10), (14 << 11) | (30 << 5));
    assert.equal(once.readUInt16LE(12), (46 << 9) | (9 << 5) | 11);
  });

  it(
    'is an archive a real unzip agrees is an archive',
    { skip: hasUnzip ? false : 'no unzip on this machine' },
    () => {
      // The assertion that matters most and the one our own reader cannot make.
      const directory = mkdtempSync(join(tmpdir(), 'ms-zip-'));
      try {
        const archive = join(directory, 'report.zip');
        writeFileSync(
          archive,
          buildZip(
            [
              { name: 'report.html', content: Buffer.from('<table><tr><td>—</td></tr></table>') },
              { name: 'Bürorouter.csv', content: Buffer.from('Zeit,Wert\n2026-09-01,12.5\n') },
            ],
            AT,
          ),
        );
        const listing = execFileSync('unzip', ['-l', archive], { encoding: 'utf8' });
        assert.match(listing, /report\.html/u);
        assert.match(listing, /2 files/u);

        execFileSync('unzip', ['-q', '-o', archive, '-d', directory]);
        const extracted = execFileSync('cat', [join(directory, 'report.html')], {
          encoding: 'utf8',
        });
        assert.equal(extracted, '<table><tr><td>—</td></tr></table>');
        // `unzip -t` verifies every entry's CRC, which is the one field a wrong implementation
        // most often gets away with until somebody actually extracts the file.
        assert.match(execFileSync('unzip', ['-t', archive], { encoding: 'utf8' }), /No errors/u);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
