import type { Duplex } from 'node:stream';
import { describeError } from '../errors/app-error.js';
import type { Logger } from '../logging/logger.js';
import { DEFAULT_MAX_FRAME_BYTES, encodeFrame, FrameDecoder } from './frame.js';

export type CloseCause = 'local' | 'peer' | 'idle-timeout' | 'protocol-error' | 'transport-error';

export interface ConnectionClose {
  cause: CloseCause;
  detail: string;
}

export interface MessageConnectionOptions<Inbound> {
  socket: Duplex;
  logger: Logger;
  /** Boundary validation. Throwing here closes the connection as a protocol error. */
  parse: (value: unknown) => Inbound;
  onMessage: (message: Inbound) => void;
  onClose: (close: ConnectionClose) => void;
  maxFrameBytes?: number;
  /**
   * Close if nothing arrives in this window. Set from the negotiated heartbeat interval, so a
   * peer that has stopped answering is detected in bounded time rather than lingering as a
   * half-open socket.
   */
  idleTimeoutMs?: number;
}

/**
 * A framed, validated message channel over any duplex stream (a `tls.TLSSocket` in production,
 * a socket pair in tests). Knows nothing about who is core and who is probe.
 */
export class MessageConnection<Inbound, Outbound> {
  readonly #socket: Duplex;
  readonly #logger: Logger;
  readonly #decoder: FrameDecoder;
  readonly #parse: (value: unknown) => Inbound;
  readonly #onMessage: (message: Inbound) => void;
  readonly #onClose: (close: ConnectionClose) => void;
  readonly #maxFrameBytes: number;
  readonly #idleTimeoutMs: number | undefined;

  #idleTimer: NodeJS.Timeout | undefined;
  #closed = false;

  constructor(options: MessageConnectionOptions<Inbound>) {
    this.#socket = options.socket;
    this.#logger = options.logger;
    this.#maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    this.#decoder = new FrameDecoder(this.#maxFrameBytes);
    this.#parse = options.parse;
    this.#onMessage = options.onMessage;
    this.#onClose = options.onClose;
    this.#idleTimeoutMs = options.idleTimeoutMs;

    this.#socket.on('data', (chunk: Buffer) => {
      this.#handleChunk(chunk);
    });
    this.#socket.on('error', (error: Error) => {
      this.#finish({ cause: 'transport-error', detail: describeError(error).message });
    });
    this.#socket.on('close', () => {
      this.#finish({ cause: 'peer', detail: 'socket closed' });
    });
    this.#socket.on('end', () => {
      this.#finish({ cause: 'peer', detail: 'peer ended the stream' });
    });

    this.#armIdleTimer();
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Bytes buffered waiting for the rest of a frame — a backpressure signal for Probe Health. */
  get pendingInboundBytes(): number {
    return this.#decoder.pendingBytes;
  }

  send(message: Outbound): void {
    if (this.#closed) {
      this.#logger.debug({ message }, 'dropping outbound message on a closed connection');
      return;
    }
    try {
      this.#socket.write(encodeFrame(message, this.#maxFrameBytes));
    } catch (error) {
      this.#finish({ cause: 'transport-error', detail: describeError(error).message });
    }
  }

  /** Sends a final message if given, then ends the stream. */
  close(detail: string, farewell?: Outbound): void {
    if (this.#closed) return;
    if (farewell !== undefined) this.send(farewell);
    this.#finish({ cause: 'local', detail });
    this.#socket.end();
  }

  destroy(detail: string): void {
    this.#finish({ cause: 'local', detail });
    this.#socket.destroy();
  }

  #handleChunk(chunk: Buffer): void {
    if (this.#closed) return;
    this.#armIdleTimer();

    let decoded: unknown[];
    try {
      decoded = this.#decoder.push(chunk);
    } catch (error) {
      this.#failProtocol(error);
      return;
    }

    for (const value of decoded) {
      let message: Inbound;
      try {
        message = this.#parse(value);
      } catch (error) {
        this.#failProtocol(error);
        return;
      }
      try {
        this.#onMessage(message);
      } catch (error) {
        this.#logger.error({ err: describeError(error) }, 'message handler threw');
        this.#failProtocol(error);
        return;
      }
      // The handler may have closed the connection (a reject, a bye). Anything still in this
      // batch belongs to a conversation that is over.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- #closed is mutated by #finish() during the handler call above; the checker cannot see that
      if (this.#closed) return;
    }
  }

  #failProtocol(error: unknown): void {
    const described = describeError(error);
    this.#logger.warn({ err: described }, 'closing connection on protocol violation');
    this.#finish({ cause: 'protocol-error', detail: described.message });
    // Destroy rather than end: after a framing error the stream position is meaningless.
    this.#socket.destroy();
  }

  #armIdleTimer(): void {
    if (this.#idleTimeoutMs === undefined) return;
    if (this.#idleTimer !== undefined) clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => {
      this.#logger.warn({ idleTimeoutMs: this.#idleTimeoutMs }, 'connection idle, closing');
      this.#finish({ cause: 'idle-timeout', detail: 'no frames within the idle timeout' });
      this.#socket.destroy();
    }, this.#idleTimeoutMs);
    this.#idleTimer.unref();
  }

  #finish(close: ConnectionClose): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#idleTimer !== undefined) clearTimeout(this.#idleTimer);
    this.#onClose(close);
  }
}
