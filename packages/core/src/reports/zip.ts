import { crc32, deflateRawSync } from 'node:zlib';

/**
 * A minimal ZIP writer (`E-09`, `CAPABILITIES.MD §6`).
 *
 * **Hand-written rather than a dependency**, for the reason this project builds its own syslog,
 * NetFlow and WMI transports: what is needed here is a small, completely specified slice of a
 * format — local headers, deflated entries, a central directory — and `node:zlib` already supplies
 * the only hard part. An archiver library is a dependency tree inside a service whose entire
 * premise is that an operator installs one thing, in exchange for code we would not read.
 *
 * **What this deliberately does not implement**, because a report does not need it and each is
 * somewhere to get it wrong: no ZIP64 (the size is bounded by `E-04`'s cell limit and `ADR-005`
 * Decision 2 — four gigabytes is not reachable), no encryption, no directories, no multi-disk, no
 * data descriptors. Entries are written in one pass with their sizes already known, which is the
 * case that needs none of the streaming tricks.
 *
 * Specification: APPNOTE.TXT 6.3.x, sections 4.3.7 (local file header), 4.3.12 (central directory
 * header) and 4.3.16 (end of central directory record).
 */

export interface ZipEntry {
  /** The name inside the archive. Written as UTF-8; see `safeName`. */
  readonly name: string;
  readonly content: Buffer;
}

const LOCAL_HEADER = 0x04_03_4b_50;
const CENTRAL_HEADER = 0x02_01_4b_50;
const END_OF_CENTRAL = 0x06_05_4b_50;

/** Deflate, which is method 8 and the only one worth having for text. */
const METHOD_DEFLATE = 8;
/** Stored, for the rare entry deflate makes bigger. */
const METHOD_STORE = 0;

/**
 * Bit 11 of the general-purpose flags: the name and comment are UTF-8.
 *
 * Without it a name is read in the archiver's code page, which on a Windows desktop is not UTF-8 —
 * and a report is named after an operator's own report, which can hold anything. Setting the flag
 * costs two bytes and is what makes `Bürorouter.csv` survive the trip.
 */
const FLAG_UTF8 = 0x08_00;

/**
 * A name that cannot escape the archive it is in.
 *
 * **Zip Slip**, and it is worth the four lines even though every name here is generated from a
 * report's own title: an archive entry called `../../etc/cron.d/x` is extracted *there* by a great
 * many tools, and the report title is an operator's string. The guard belongs where the name is
 * written rather than in a hope about what is passed in.
 */
function safeName(raw: string): string {
  const flattened = raw.replaceAll('\\', '/').split('/').pop() ?? 'file';
  // By code point rather than a regex: control characters in a character class are what
  // `no-control-regex` exists to catch, and spelling the range out here says what is meant.
  let stripped = '';
  for (const character of flattened) {
    const code = character.codePointAt(0) ?? 0;
    if (code >= 0x20 && code !== 0x7f) stripped += character;
  }
  const cleaned = stripped.trim();
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? 'file' : cleaned.slice(0, 200);
}

/**
 * MS-DOS date and time, which is what a ZIP entry carries.
 *
 * Two-second resolution and a 1980 epoch, both of them the format's. **UTC rather than local**: the
 * format has nowhere to put a zone, so a local timestamp means something different to everyone who
 * opens it, and an archive built twice from the same inputs would differ by the server's offset.
 */
function dosTimestamp(at: Date): { time: number; date: number } {
  const year = Math.max(at.getUTCFullYear(), 1980);
  return {
    time: (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | Math.floor(at.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate(),
  };
}

/** One archive, built in memory. Bounded by `ADR-005` Decision 2 — see the note above. */
export function buildZip(entries: readonly ZipEntry[], at: Date): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  const stamp = dosTimestamp(at);
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(safeName(entry.name), 'utf8');
    const raw = entry.content;
    const deflated = deflateRawSync(raw);
    // **Stored when deflate made it bigger**, which happens for a tiny or already-compressed
    // entry. A ZIP larger than its contents is a poor advertisement for the option.
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? METHOD_DEFLATE : METHOD_STORE;
    const crc = crc32(raw);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(LOCAL_HEADER, 0);
    header.writeUInt16LE(20, 4); // version needed: 2.0, which is deflate
    header.writeUInt16LE(FLAG_UTF8, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(stamp.time, 10);
    header.writeUInt16LE(stamp.date, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(raw.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28); // no extra field
    local.push(header, name, body);

    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(CENTRAL_HEADER, 0);
    directory.writeUInt16LE(20, 4); // version made by
    directory.writeUInt16LE(20, 6); // version needed
    directory.writeUInt16LE(FLAG_UTF8, 8);
    directory.writeUInt16LE(method, 10);
    directory.writeUInt16LE(stamp.time, 12);
    directory.writeUInt16LE(stamp.date, 14);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(body.length, 20);
    directory.writeUInt32LE(raw.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt16LE(0, 30); // extra
    directory.writeUInt16LE(0, 32); // comment
    directory.writeUInt16LE(0, 34); // disk number
    directory.writeUInt16LE(0, 36); // internal attributes
    // 0o644 in the high sixteen bits, which is where a Unix archiver reads a file mode. Zero there
    // means "no mode", and some extractors then create the file unreadable.
    //
    // **`>>> 0` because `<<` is signed.** `0o100644 << 16` is 2,174,844,928, which is past 2^31,
    // so JavaScript's shift hands back a negative number and `writeUInt32LE` refuses it. Every
    // archive would have thrown; found by the first test that built one.
    directory.writeUInt32LE((0o10_0644 << 16) >>> 0, 38);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);

    offset += header.length + name.length + body.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL, 0);
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk holding the central directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // no comment

  return Buffer.concat([...local, directory, end]);
}
