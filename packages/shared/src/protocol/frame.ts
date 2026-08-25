import { AppError } from '../errors/app-error.js';

/**
 * Length-prefixed framing for the core↔probe channel.
 *
 *   +--------------------+---------------------------+
 *   | uint32be length    | UTF-8 JSON payload        |
 *   +--------------------+---------------------------+
 *
 * TLS gives us a byte stream, not a message stream: a `data` event may carry half a message or
 * six of them. Everything above this file gets whole messages or nothing.
 */

export const FRAME_HEADER_BYTES = 4;

/** Refuse anything larger rather than letting a peer allocate arbitrary memory. */
export const DEFAULT_MAX_FRAME_BYTES = 4 * 1024 * 1024;

export class FrameError extends AppError {
  constructor(
    message: string,
    options?: { context?: Record<string, string | number>; cause?: unknown },
  ) {
    super('FRAME_INVALID', message, {
      context: options?.context ?? {},
      ...(options?.cause === undefined ? {} : { cause: options.cause }),
    });
    this.name = 'FrameError';
  }
}

export function encodeFrame(value: unknown, maxBytes = DEFAULT_MAX_FRAME_BYTES): Buffer {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  if (payload.byteLength > maxBytes) {
    throw new FrameError('outbound frame exceeds the maximum frame size', {
      context: { bytes: payload.byteLength, maxBytes },
    });
  }
  const frame = Buffer.allocUnsafe(FRAME_HEADER_BYTES + payload.byteLength);
  frame.writeUInt32BE(payload.byteLength, 0);
  payload.copy(frame, FRAME_HEADER_BYTES);
  return frame;
}

/**
 * Accumulates stream chunks and yields complete payloads.
 *
 * Stateful and single-connection: one decoder per socket. A protocol violation is terminal —
 * once `push` throws, the connection must be destroyed, because the stream position is no
 * longer trustworthy.
 */
export class FrameDecoder {
  readonly #maxBytes: number;
  #buffer: Buffer = Buffer.alloc(0);
  #failed = false;

  constructor(maxBytes = DEFAULT_MAX_FRAME_BYTES) {
    this.#maxBytes = maxBytes;
  }

  /** Bytes held back waiting for the rest of their frame. Surfaced for backpressure metrics. */
  get pendingBytes(): number {
    return this.#buffer.byteLength;
  }

  push(chunk: Buffer): unknown[] {
    if (this.#failed) {
      throw new FrameError('decoder is in a failed state; the connection must be closed');
    }

    this.#buffer = this.#buffer.byteLength === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    const messages: unknown[] = [];

    for (;;) {
      if (this.#buffer.byteLength < FRAME_HEADER_BYTES) break;

      const length = this.#buffer.readUInt32BE(0);
      if (length > this.#maxBytes) {
        this.#failed = true;
        throw new FrameError('inbound frame exceeds the maximum frame size', {
          context: { bytes: length, maxBytes: this.#maxBytes },
        });
      }

      const total = FRAME_HEADER_BYTES + length;
      if (this.#buffer.byteLength < total) break;

      const payload = this.#buffer.subarray(FRAME_HEADER_BYTES, total);
      this.#buffer = this.#buffer.subarray(total);

      let parsed: unknown;
      try {
        parsed = JSON.parse(payload.toString('utf8'));
      } catch (cause) {
        this.#failed = true;
        throw new FrameError('frame payload is not valid JSON', {
          context: { bytes: length },
          cause,
        });
      }
      messages.push(parsed);
    }

    return messages;
  }
}
