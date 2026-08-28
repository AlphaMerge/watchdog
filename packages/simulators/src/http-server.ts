import { createServer as createHttpServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { close, listen } from './net.js';

/**
 * An HTTP server whose latency, status, body and misbehaviour are scripted per route (`P-06`).
 *
 * **The scriptable latency is the point, and it is what a test cannot get any other way.** Every
 * HTTP-shaped sensor this system has is really a timing and edge-case sensor: `T-13` reads a
 * response time, `T-15` follows a redirect that must not re-send its body, `P-02`'s pool needs a
 * check that hangs, and `T-14` bounds a body and must fail rather than truncate. None of those
 * are reachable against a server behaving normally, and all of them are one field here.
 *
 * **Written rather than borrowed.** `nock` and its relatives intercept at the client library,
 * which is precisely the layer under test — a redirect that our code mishandles is a redirect the
 * interceptor never sees. This binds a real socket and speaks real HTTP, so what is asserted is
 * what would happen on a network.
 *
 * Before this, seven test files each stood up their own `createServer` with its own ad-hoc
 * routing, and the interesting cases — a slow drip, a socket reset mid-body — were in none of
 * them, because writing one of those by hand costs more than the test it supports.
 */

export interface HttpResponseScript {
  status?: number;
  headers?: Record<string, string>;
  /** The body. A string is sent as UTF-8; a Buffer is sent as it stands. */
  body?: string | Buffer;
  /** Held for this long before the response head goes out. A stalled server, not a slow one. */
  delayMs?: number;
  /**
   * Sends the body in pieces, this many milliseconds apart.
   *
   * Different from `delayMs` in the way that matters: the response *starts* immediately, so a
   * client that measures time-to-first-byte sees a fast server while a client that reads to the
   * end sees a slow one. That difference is the whole of what a body-size bound and a read
   * timeout are for.
   */
  dripMs?: number;
  /** How many pieces `dripMs` splits the body into. */
  dripChunks?: number;
  /**
   * Sends the head immediately and the body after this long.
   *
   * The distinction from `delayMs` is the one a sensor with a single timing cannot make: this is
   * a server that accepted and answered promptly and then thought about the body, where `delayMs`
   * is a server that had not answered at all. An operator debugging a slow check needs to know
   * which, and a harness that could only express one of them could not test the difference.
   *
   * **`flushHeaders` is the whole trick**, and leaving it out is a mistake this codebase has
   * already made once: `writeHead` only *stages* the headers, and Node sends them with the first
   * body chunk — so the server appears to think for the whole delay and then answer instantly,
   * which is exactly the shape being told apart.
   */
  bodyDelayMs?: number;
  /** Accepts the request and never answers. What a check's own timeout is tested against. */
  hang?: boolean;
  /** Destroys the socket instead of answering — a connection reset, not a status code. */
  reset?: boolean;
  /** Answers 302 to this location. Shorthand for a status and a header. */
  redirectTo?: string;
}

/** What arrived, so a test can assert on the request as well as on the answer. */
export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface HttpSimulatorOptions {
  /**
   * Per path, one script or a sequence of them.
   *
   * A sequence is consumed in order and the last entry repeats, which is how "fails twice then
   * succeeds" is written — the shape every retry and backoff test needs and none of them could
   * express against a server that answers the same way every time.
   */
  routes?: Record<string, HttpResponseScript | HttpResponseScript[]>;
  /** Answered for any path with no route. Defaults to 404. */
  fallback?: HttpResponseScript;
  /** TLS material. Present, the simulator speaks HTTPS. */
  tls?: { key: string | Buffer; cert: string | Buffer };
}

const DEFAULT_DRIP_CHUNKS = 4;

export class HttpSimulator {
  readonly #options: HttpSimulatorOptions;
  readonly #requests: RecordedRequest[] = [];
  readonly #consumed = new Map<string, number>();
  /** Sockets left hanging, so `stop()` can end them rather than waiting on a client that will not. */
  readonly #hanging = new Set<{ destroy: () => void }>();
  #server: Server | undefined;
  #port = 0;

  constructor(options: HttpSimulatorOptions = {}) {
    this.#options = options;
  }

  get port(): number {
    return this.#port;
  }

  /** Every request that arrived, in order. */
  get requests(): readonly RecordedRequest[] {
    return this.#requests;
  }

  /** The paths that were asked for, which is what most assertions actually want. */
  get paths(): readonly string[] {
    return this.#requests.map((request) => request.url);
  }

  url(path = '/'): string {
    const scheme = this.#options.tls === undefined ? 'http' : 'https';
    return `${scheme}://127.0.0.1:${String(this.#port)}${path}`;
  }

  async start(): Promise<number> {
    const server =
      this.#options.tls === undefined
        ? createHttpServer((request, response) => {
            void this.#handle(request, response);
          })
        : createHttpsServer(this.#options.tls, (request, response) => {
            void this.#handle(request, response);
          });
    this.#server = server;
    this.#port = await listen(this.#server);
    return this.#port;
  }

  async stop(): Promise<void> {
    // Hanging sockets first: `close()` waits for open connections, and a hang is an open
    // connection by definition, so a test that scripted one would otherwise hang its own teardown.
    for (const socket of this.#hanging) socket.destroy();
    this.#hanging.clear();
    await close(this.#server);
    this.#server = undefined;
  }

  /** Forgets what has arrived and where each sequence had got to. */
  reset(): void {
    this.#requests.length = 0;
    this.#consumed.clear();
  }

  async #handle(
    request: Parameters<NonNullable<Parameters<typeof createHttpServer>[1]>>[0],
    response: Parameters<NonNullable<Parameters<typeof createHttpServer>[1]>>[1],
  ): Promise<void> {
    const url = request.url ?? '/';
    const body = await readBody(request);
    this.#requests.push({
      method: request.method ?? 'GET',
      url,
      headers: request.headers,
      body,
    });

    const script = this.#scriptFor(url);
    if (script.hang === true) {
      this.#hanging.add(request.socket);
      return;
    }
    if (script.reset === true) {
      request.socket.destroy();
      return;
    }

    if (script.delayMs !== undefined && script.delayMs > 0) await sleep(script.delayMs);

    const headers = { ...(script.headers ?? {}) };
    let status = script.status ?? 200;
    if (script.redirectTo !== undefined) {
      status = script.status ?? 302;
      headers['location'] = script.redirectTo;
    }
    const payload = toBuffer(script.body ?? '');
    if (headers['content-type'] === undefined) headers['content-type'] = 'text/plain';
    response.writeHead(status, headers);

    if (script.bodyDelayMs !== undefined && script.bodyDelayMs > 0) {
      // See `bodyDelayMs`: staged headers are not sent headers.
      response.flushHeaders();
      await sleep(script.bodyDelayMs);
    }

    if (script.dripMs === undefined || script.dripMs <= 0 || payload.length === 0) {
      response.end(payload);
      return;
    }

    const pieces = Math.max(1, script.dripChunks ?? DEFAULT_DRIP_CHUNKS);
    const size = Math.ceil(payload.length / pieces);
    for (let at = 0; at < payload.length; at += size) {
      response.write(payload.subarray(at, at + size));
      await sleep(script.dripMs);
    }
    response.end();
  }

  /**
   * The script for this request.
   *
   * A sequence advances by one per request and **the last entry repeats** rather than running
   * out. Running out would make a test's third request answer 404 for a reason that has nothing
   * to do with what it was testing, which is a failure that reads as a bug in the sensor.
   */
  #scriptFor(url: string): HttpResponseScript {
    const path = url.split('?')[0] ?? url;
    const route = this.#options.routes?.[url] ?? this.#options.routes?.[path];
    if (route === undefined) return this.#options.fallback ?? { status: 404, body: 'not found' };
    if (!Array.isArray(route)) return route;
    if (route.length === 0) return { status: 404, body: 'not found' };

    const seen = this.#consumed.get(path) ?? 0;
    this.#consumed.set(path, seen + 1);
    return route[Math.min(seen, route.length - 1)] ?? route[route.length - 1] ?? {};
  }
}

function toBuffer(body: string | Buffer): Buffer {
  return typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
}

async function readBody(
  request: Parameters<NonNullable<Parameters<typeof createHttpServer>[1]>>[0],
): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
