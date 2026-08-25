import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  encodeFrame,
  FrameDecoder,
  FrameError,
  FRAME_HEADER_BYTES,
} from '../src/protocol/frame.js';

describe('frame codec', () => {
  it('round-trips a message', () => {
    const decoder = new FrameDecoder();
    const out = decoder.push(encodeFrame({ type: 'heartbeat', seq: 7 }));
    assert.deepEqual(out, [{ type: 'heartbeat', seq: 7 }]);
    assert.equal(decoder.pendingBytes, 0);
  });

  it('reassembles a message split across chunks', () => {
    const decoder = new FrameDecoder();
    const frame = encodeFrame({ type: 'bye', reason: 'restarting for an upgrade' });

    // Worst case: the length prefix itself is torn in half.
    assert.deepEqual(decoder.push(frame.subarray(0, 2)), []);
    assert.deepEqual(decoder.push(frame.subarray(2, FRAME_HEADER_BYTES + 3)), []);
    assert.ok(decoder.pendingBytes > 0, 'partial frames are held, not dropped');
    assert.deepEqual(decoder.push(frame.subarray(FRAME_HEADER_BYTES + 3)), [
      { type: 'bye', reason: 'restarting for an upgrade' },
    ]);
    assert.equal(decoder.pendingBytes, 0);
  });

  it('yields every message when several arrive in one chunk', () => {
    const decoder = new FrameDecoder();
    const chunk = Buffer.concat([
      encodeFrame({ seq: 1 }),
      encodeFrame({ seq: 2 }),
      encodeFrame({ seq: 3 }),
    ]);
    assert.deepEqual(decoder.push(chunk), [{ seq: 1 }, { seq: 2 }, { seq: 3 }]);
  });

  it('holds a trailing partial frame across a batch', () => {
    const decoder = new FrameDecoder();
    const whole = encodeFrame({ seq: 1 });
    const partial = encodeFrame({ seq: 2 });

    assert.deepEqual(decoder.push(Buffer.concat([whole, partial.subarray(0, 3)])), [{ seq: 1 }]);
    assert.deepEqual(decoder.push(partial.subarray(3)), [{ seq: 2 }]);
  });

  it('preserves unicode payloads', () => {
    const decoder = new FrameDecoder();
    const message = { reason: 'sonde à distance — ✅ 世界' };
    assert.deepEqual(decoder.push(encodeFrame(message)), [message]);
  });

  it('refuses to encode beyond the maximum frame size', () => {
    assert.throws(() => encodeFrame({ blob: 'x'.repeat(2048) }, 1024), FrameError);
  });

  it('rejects an inbound frame that claims to be oversized', () => {
    const decoder = new FrameDecoder(1024);
    const header = Buffer.allocUnsafe(FRAME_HEADER_BYTES);
    header.writeUInt32BE(64 * 1024 * 1024, 0);

    // A peer must not be able to make us allocate 64 MiB by asserting a length.
    assert.throws(() => decoder.push(header), FrameError);
  });

  it('rejects a payload that is not JSON', () => {
    const decoder = new FrameDecoder();
    const payload = Buffer.from('{not json', 'utf8');
    const frame = Buffer.allocUnsafe(FRAME_HEADER_BYTES + payload.byteLength);
    frame.writeUInt32BE(payload.byteLength, 0);
    payload.copy(frame, FRAME_HEADER_BYTES);

    assert.throws(() => decoder.push(frame), FrameError);
  });

  it('stays failed after a violation — the stream position is no longer trustworthy', () => {
    const decoder = new FrameDecoder(1024);
    const header = Buffer.allocUnsafe(FRAME_HEADER_BYTES);
    header.writeUInt32BE(999_999, 0);

    assert.throws(() => decoder.push(header), FrameError);
    assert.throws(() => decoder.push(encodeFrame({ seq: 1 })), FrameError);
  });

  it('handles a zero-length payload as a protocol violation, not a hang', () => {
    const decoder = new FrameDecoder();
    const header = Buffer.alloc(FRAME_HEADER_BYTES);
    header.writeUInt32BE(0, 0);
    assert.throws(() => decoder.push(header), FrameError);
  });
});
