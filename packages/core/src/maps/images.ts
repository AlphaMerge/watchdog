/**
 * What an uploaded file actually is (`G-05`, `ADR-003` Decisions 2 and 3).
 *
 * **The declared `Content-Type` is not consulted anywhere in here.** It is a claim by the client,
 * and accepting a file because it *says* it is a PNG is the oldest upload hole there is. The
 * format is decided by the bytes, and a file whose bytes are not one of three permitted formats is
 * refused — including SVG, which is not an image but a document that can carry script (`ADR-002`
 * Decision 2 settled that operator-supplied documents never run in the application's own page, and
 * a background is drawn in that page by definition).
 *
 * **The dimensions are read here too, not taken on trust and not measured by decoding.** A caller
 * cannot be asked for them — it would be the same claim again — and decoding a two-megabyte image
 * to learn its size means running a decoder over hostile bytes. Every header this reads is a fixed
 * offset or a walk of length-prefixed segments, and every read is bounds-checked: a truncated or
 * lying file returns a problem, never an exception and never a wrong number.
 */

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp';

export interface ImageFacts {
  readonly mediaType: ImageMediaType;
  readonly width: number;
  readonly height: number;
}

/** `ADR-003` Decision 2. Both are refusals at the boundary, not truncations. */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_IMAGE_EDGE = 4096;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * The JPEG markers that carry a frame's size.
 *
 * Every `SOF` except the four that are not frame headers at all: `C4` is a Huffman table, `C8` is
 * reserved, `CC` is an arithmetic-coding table, and reading a size out of any of them would be
 * reading whatever happened to be there.
 */
function isStartOfFrame(marker: number): boolean {
  if (marker < 0xc0 || marker > 0xcf) return false;
  return marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function png(bytes: Buffer): ImageFacts | undefined {
  // Signature, then the length and type of the first chunk, which the format requires to be
  // IHDR, then the two dimensions: 8 + 4 + 4 + 4 + 4 = 24 bytes before anything is read.
  if (bytes.length < 24) return undefined;
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return undefined;
  if (bytes.toString('latin1', 12, 16) !== 'IHDR') return undefined;
  return {
    mediaType: 'image/png',
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

/**
 * JPEG, by walking its segments.
 *
 * There is no fixed offset to read: a file may carry any number of application and comment
 * segments before the frame header, and Exif thumbnails routinely put a *second* JPEG inside one
 * of them. The walk uses each segment's own length, so it steps over the thumbnail rather than
 * into it — reading the first `FFC0` found by scanning would return the thumbnail's size.
 */
function jpeg(bytes: Buffer): ImageFacts | undefined {
  if (bytes.length < 4) return undefined;
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return undefined;

  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return undefined;
    const marker = bytes[at + 1];
    if (marker === undefined) return undefined;
    // Padding: any number of 0xFF bytes may precede a marker.
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    // Standalone markers, which carry no length: RSTn and SOI/EOI/TEM.
    if ((marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) {
      at += 2;
      continue;
    }
    const length = bytes.readUInt16BE(at + 2);
    // A segment length counts its own two bytes, so anything under two is a lie that would make
    // this walk stand still or go backwards.
    if (length < 2) return undefined;
    if (isStartOfFrame(marker)) {
      if (at + 9 > bytes.length) return undefined;
      return {
        mediaType: 'image/jpeg',
        height: bytes.readUInt16BE(at + 5),
        width: bytes.readUInt16BE(at + 7),
      };
    }
    // Start of scan: the entropy-coded data follows and there is no frame header after it.
    if (marker === 0xda) return undefined;
    at += 2 + length;
  }
  return undefined;
}

/**
 * WebP, which is three formats wearing one extension.
 *
 * Lossy (`VP8 `) keeps the size in the VP8 frame header behind a sync code; lossless (`VP8L`)
 * packs two 14-bit values into a little-endian word with one-based lengths; extended (`VP8X`)
 * carries the *canvas* size in two 24-bit values, which is the one that matters because an
 * animated or alpha-carrying file's first frame need not be the canvas.
 */
function webp(bytes: Buffer): ImageFacts | undefined {
  // Enough to name the container and its first chunk. **Each branch then checks its own length**
  // rather than one number for all three: a lossless file's size lives at byte 24 and a lossy
  // one's at byte 29, so a single 30-byte floor would refuse a small `VP8L` that is entirely
  // well formed.
  if (bytes.length < 16) return undefined;
  if (bytes.toString('latin1', 0, 4) !== 'RIFF') return undefined;
  if (bytes.toString('latin1', 8, 12) !== 'WEBP') return undefined;

  const chunk = bytes.toString('latin1', 12, 16);

  if (chunk === 'VP8X') {
    if (bytes.length < 30) return undefined;
    return {
      mediaType: 'image/webp',
      width: bytes.readUIntLE(24, 3) + 1,
      height: bytes.readUIntLE(27, 3) + 1,
    };
  }

  if (chunk === 'VP8 ') {
    if (bytes.length < 30) return undefined;
    // The three-byte frame tag, then the sync code that says this is a key frame. Without the
    // check, a non-key frame's bytes would be read as a size.
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return undefined;
    return {
      mediaType: 'image/webp',
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
    };
  }

  if (chunk === 'VP8L') {
    if (bytes.length < 25) return undefined;
    if (bytes[20] !== 0x2f) return undefined;
    const packed = bytes.readUInt32LE(21);
    return {
      mediaType: 'image/webp',
      width: (packed & 0x3fff) + 1,
      height: ((packed >> 14) & 0x3fff) + 1,
    };
  }

  return undefined;
}

/**
 * What these bytes are, or why they are refused.
 *
 * Never throws: the input is a request body, and a truncated header is a 400 rather than a 500.
 */
export function readImage(bytes: Buffer): ImageFacts | { problem: string } {
  if (bytes.length === 0) return { problem: 'the uploaded file is empty' };
  if (bytes.length > MAX_IMAGE_BYTES) {
    return {
      problem: `an image may be at most ${String(MAX_IMAGE_BYTES)} bytes; this one is ${String(bytes.length)}`,
    };
  }

  const facts = png(bytes) ?? jpeg(bytes) ?? webp(bytes);
  if (facts === undefined) {
    // Named, because "unsupported" leaves somebody re-uploading the same file. SVG is the one
    // people will try, and it is refused on purpose rather than for want of support.
    const looksLikeSvg = bytes
      .toString('latin1', 0, Math.min(bytes.length, 200))
      .trimStart()
      .startsWith('<');
    return {
      problem: looksLikeSvg
        ? 'SVG is not accepted: it is a document rather than an image, and a background is drawn in the application’s own page (ADR-003)'
        : 'the file is not a PNG, JPEG or WebP image — whatever it is called',
    };
  }

  if (facts.width < 1 || facts.height < 1) {
    return { problem: 'the image reports no size' };
  }
  if (facts.width > MAX_IMAGE_EDGE || facts.height > MAX_IMAGE_EDGE) {
    return {
      problem: `an image may be at most ${String(MAX_IMAGE_EDGE)} pixels on a side; this one is ${String(facts.width)}×${String(facts.height)}`,
    };
  }
  return facts;
}
