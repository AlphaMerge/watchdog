import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { MAX_IMAGE_BYTES, MAX_IMAGE_EDGE, readImage } from '../src/maps/images.js';

/**
 * Deciding what an uploaded file is (`G-05`, `ADR-003`).
 *
 * Headers are built here by hand rather than fixtures on disk, for the same reason the flow
 * decoders' tests build datagrams: a test that reads a real PNG proves the reader works on that
 * PNG, and what needs proving is what it does with the ones somebody sends on purpose — a header
 * that lies about its size, a truncated one, an SVG called `.png`, a thumbnail before the frame.
 */

function png(width: number, height: number, options: { chunk?: string } = {}): Buffer {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write(options.chunk ?? 'IHDR', 12, 'latin1');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

/** A JPEG with `before` segments in front of its frame header, each carrying `filler` bytes. */
function jpeg(width: number, height: number, before: readonly Buffer[] = []): Buffer {
  const head = Buffer.from([0xff, 0xd8]);
  const frame = Buffer.alloc(11);
  frame.writeUInt16BE(0xffc0, 0);
  frame.writeUInt16BE(9, 2); // length: itself, precision, two dimensions, component count
  frame.writeUInt8(8, 4);
  frame.writeUInt16BE(height, 5);
  frame.writeUInt16BE(width, 7);
  frame.writeUInt8(1, 9);
  return Buffer.concat([head, ...before, frame]);
}

/** An APP segment of `payload`, which is how a thumbnail arrives before the real frame. */
function segment(marker: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt16BE(0xff00 | marker, 0);
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}

function riff(chunk: string, body: Buffer): Buffer {
  const bytes = Buffer.alloc(12 + 4 + 4 + body.length);
  bytes.write('RIFF', 0, 'latin1');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WEBP', 8, 'latin1');
  bytes.write(chunk, 12, 'latin1');
  bytes.writeUInt32LE(body.length, 16);
  body.copy(bytes, 20);
  return bytes;
}

function webpLossy(width: number, height: number): Buffer {
  const body = Buffer.alloc(10);
  Buffer.from([0x00, 0x00, 0x00, 0x9d, 0x01, 0x2a]).copy(body, 0);
  body.writeUInt16LE(width, 6);
  body.writeUInt16LE(height, 8);
  return riff('VP8 ', body);
}

function webpLossless(width: number, height: number): Buffer {
  const body = Buffer.alloc(5);
  body.writeUInt8(0x2f, 0);
  body.writeUInt32LE((width - 1) | ((height - 1) << 14), 1);
  return riff('VP8L', body);
}

function webpExtended(width: number, height: number): Buffer {
  const body = Buffer.alloc(10);
  body.writeUIntLE(width - 1, 4, 3);
  body.writeUIntLE(height - 1, 7, 3);
  return riff('VP8X', body);
}

function facts(bytes: Buffer): { mediaType: string; width: number; height: number } {
  const read = readImage(bytes);
  assert.ok(
    !('problem' in read),
    `expected an image, got: ${'problem' in read ? read.problem : ''}`,
  );
  return read;
}

function refusal(bytes: Buffer): string {
  const read = readImage(bytes);
  assert.ok('problem' in read, 'expected a refusal');
  return read.problem;
}

describe('what an uploaded file is', () => {
  it('reads a PNG', () => {
    assert.deepEqual(facts(png(800, 600)), {
      mediaType: 'image/png',
      width: 800,
      height: 600,
    });
  });

  it('refuses a PNG whose first chunk is not the header', () => {
    // The format requires IHDR first. Reading four bytes from wherever the first chunk happens to
    // be would produce a confident, wrong size.
    assert.match(refusal(png(800, 600, { chunk: 'tEXt' })), /not a PNG, JPEG or WebP/);
  });

  it('reads a JPEG', () => {
    assert.deepEqual(facts(jpeg(1024, 768)), {
      mediaType: 'image/jpeg',
      width: 1024,
      height: 768,
    });
  });

  it('steps over a thumbnail instead of measuring it', () => {
    // **The reason the JPEG reader walks lengths rather than scanning for `FFC0`.** An Exif
    // segment routinely contains a whole second JPEG; a scan finds its frame header first and
    // reports a 160×120 background.
    const thumbnail = jpeg(160, 120);
    const exif = segment(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), thumbnail]));
    assert.equal(facts(jpeg(1024, 768, [exif])).width, 1024);
  });

  it('gives up on a JPEG segment whose length would not move the walk forward', () => {
    // A length of 0 or 1 counts less than the two bytes it occupies: honouring it is an infinite
    // loop over a file somebody sent on purpose.
    const stuck = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      Buffer.from([0xff, 0xe0, 0x00, 0x00]),
      jpeg(1024, 768).subarray(2),
    ]);
    assert.match(refusal(stuck), /not a PNG, JPEG or WebP/);
  });

  it('reads all three WebPs', () => {
    assert.deepEqual(facts(webpLossy(640, 480)), {
      mediaType: 'image/webp',
      width: 640,
      height: 480,
    });
    assert.deepEqual(facts(webpLossless(640, 480)), {
      mediaType: 'image/webp',
      width: 640,
      height: 480,
    });
    // The extended form carries the *canvas* size, which is the one that matters: an animated
    // file's first frame need not be the whole canvas.
    assert.deepEqual(facts(webpExtended(1920, 1080)), {
      mediaType: 'image/webp',
      width: 1920,
      height: 1080,
    });
  });

  it('reads a lossless WebP shorter than a lossy one', () => {
    // The three forms keep their size at different offsets, so one length floor for all of them
    // refuses a small `VP8L` that is entirely well formed.
    const small = webpLossless(16, 16);
    assert.ok(small.length < 30);
    assert.equal(facts(small).width, 16);
  });

  it('refuses a lossy WebP without the key-frame sync code', () => {
    const broken = webpLossy(640, 480);
    broken.writeUInt8(0x00, 23);
    assert.match(refusal(broken), /not a PNG, JPEG or WebP/);
  });

  it('refuses SVG by name, because people will try it', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>…</script></svg>');
    assert.match(refusal(svg), /SVG is not accepted/);
    // Said to whoever uploaded it, who has no decision record to look up (`U-92`).
    assert.doesNotMatch(refusal(svg), /\b(?:[A-Z]|V2|ADR)-\d+[a-z]?\b/u);
  });

  it('refuses a file that only claims to be an image', () => {
    // The declared content type never reaches this function. A zip called `plan.png` is a zip.
    assert.match(refusal(Buffer.from('PKrest of a zip')), /not a PNG, JPEG or WebP/);
  });

  it('refuses an empty upload', () => {
    assert.match(refusal(Buffer.alloc(0)), /empty/);
  });

  it('refuses a truncated header rather than throwing', () => {
    // Every one of these would be an out-of-range read if the guards were not there, and a 500
    // where a 400 belongs.
    for (const length of [1, 4, 8, 12, 16, 20, 23]) {
      const read = readImage(png(800, 600).subarray(0, length));
      assert.ok('problem' in read, `${String(length)} bytes should not read as an image`);
    }
  });

  it('refuses an image bigger than the ceiling', () => {
    const huge = Buffer.concat([png(10, 10), Buffer.alloc(MAX_IMAGE_BYTES)]);
    assert.match(refusal(huge), /at most 2097152 bytes/);
  });

  it('refuses an image with an edge past the ceiling', () => {
    // Dimensions come from the header, so this is a 24-byte file claiming to be 40,000 pixels
    // wide — the cheap way to make something downstream allocate.
    assert.match(refusal(png(40_000, 10)), /4096 pixels on a side/);
    assert.equal(facts(png(MAX_IMAGE_EDGE, MAX_IMAGE_EDGE)).width, MAX_IMAGE_EDGE);
  });

  it('refuses an image that reports no size', () => {
    assert.match(refusal(png(0, 600)), /no size/);
  });
});
