import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Everything is relative to `/api/v1`.
 *
 * In development Vite proxies that to the core; in production the core serves this app itself,
 * so it is the same origin. Neither case needs a configured base URL, which is why there is no
 * setting for one — a base URL that is always the same value is a way to get it wrong once.
 */
const BASE = '/api/v1';

/**
 * The two namespaces a refusal carries, and they are not interchangeable.
 *
 * **The core's envelope has both `context` and `details`, and different errors fill different
 * ones.** `toHttpError` gives an `AuthError` its values as `context` — `enrolled` on an MFA
 * refusal, `retryAfterSeconds` on a throttled one — while `ObjectError`, `MethodError` and
 * `TriggerError` fill `details` with `problems` and `usedBy`. A client that reads one and not the
 * other does not fail loudly: the lookup is `undefined`, the branch it guards is simply never
 * taken, and the form quietly does the wrong thing for ever. That is what happened to the MFA
 * step, so both are read here and each is named for what the core calls it.
 */
export interface ErrorContext {
  [key: string]: unknown;
}

/**
 * What the core says about a refusal, beyond the sentence.
 *
 * `problems` carries the JSON Pointer of each parameter a schema rejected, which is what lets a
 * generated form put the message on the field it is about rather than in a banner above twelve
 * inputs (`U-08`).
 */
export interface ErrorDetails {
  /**
   * Two shapes, from two validators.
   *
   * A refusal by the *request* schema comes from Fastify's Ajv and names `instancePath`, a JSON
   * Pointer. A refusal of a sensor's *params* comes from the sensor-type gate and names `path`.
   * A client that read only one would silently lose the other's field mapping, so `problemPath`
   * below reads both.
   */
  problems?: { path?: string; instancePath?: string; message?: string }[];
  /**
   * What still references the thing a delete was refused for.
   *
   * A trigger names a template inside a `jsonb` document, so no foreign key can enforce it and
   * the "used by" lookup stands in for one (`N-05`). The list is the useful half of the refusal:
   * a bare "cannot delete" leaves somebody hunting through every object for the reference.
   */
  usedBy?: { triggerId?: number; objectId?: number; objectName?: string; summary?: string }[];
  [key: string]: unknown;
}

/** The dotted parameter path a refusal names, whichever validator produced it. */
export function problemPath(problem: { path?: string; instancePath?: string }): string {
  const raw = problem.path ?? problem.instancePath ?? '';
  if (raw === '' || raw === '(root)') return '';
  return raw.replace(/^\//, '').replace(/\//g, '.');
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly correlationId: string | undefined;
  readonly details: ErrorDetails;
  readonly context: ErrorContext;

  constructor(
    status: number,
    code: string,
    message: string,
    correlationId?: string,
    details: ErrorDetails = {},
    context: ErrorContext = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.correlationId = correlationId;
    this.details = details;
    this.context = context;
  }
}

/**
 * What to do when the core says a request needed a session it did not have (`U-17`).
 *
 * **The filter is the code, not the status, and the difference is the whole login form.**
 * `POST /auth/login` answers 401 three ways — a password that was not accepted, a second factor
 * the account needs, a code that was wrong — and every one of those is the login form doing its
 * job, not a session going away. Routing them here would send somebody mistyping their password
 * back to the page they are already looking at, and clear the fields on the way. `AUTH_REQUIRED`
 * is the one code the authentication hook raises, and it means exactly one thing.
 *
 * A single listener rather than a set: there is one session in a tab, and a second subscriber
 * would be a second thing deciding what "logged out" looks like.
 */
let sessionLost: ((ended?: string) => void) | undefined;

/** `ended`, when given, is why — in the core's words — for the login form to say (`A-34`). */
export function onSessionLost(listener: ((ended?: string) => void) | undefined): void {
  sessionLost = listener;
}

/**
 * The core closed the live stream because this browser's session no longer authenticates, and
 * said why (`A-34`). The one report of a lost session that carries its reason: every other one is
 * a 401 or a question asked afterwards, and neither can say what happened.
 */
export function sessionEnded(reason: string): void {
  sessionLost?.(reason);
}

/**
 * Asks the core whether this browser still has a session, and reports it if not (`U-19`).
 *
 * **For the WebSocket, which cannot answer the question itself.** With authentication on, an
 * upgrade with no session is refused with a perfectly good `401 AUTH_REQUIRED` — and the browser
 * `WebSocket` API deliberately hides it: the page gets `onerror` and a 1006 close with no status,
 * exactly what a pulled cable produces. So a stream whose session has gone reconnects for ever,
 * at the ceiling of its backoff, while the header still says the operator is signed in.
 *
 * `GET /auth/session` is public and always answers, which is what makes it the right thing to
 * ask. A failure here is *not* an answer — an unreachable core is what the reconnect loop is
 * already handling, and treating it as a lost session would put a login form in front of somebody
 * whose network blinked.
 */
export async function confirmSession(): Promise<void> {
  let reply: { authenticated?: boolean };
  try {
    reply = await request<{ authenticated?: boolean }>('/auth/session');
  } catch {
    return;
  }
  if (reply.authenticated !== true) sessionLost?.();
}

/** Every refusal is built here, so neither verb can forget to report a lost session. */
function refusal(status: number, statusText: string, body: ErrorBody): ApiError {
  const error = new ApiError(
    status,
    body.error?.code ?? 'HTTP_ERROR',
    body.error?.message ?? `${String(status)} ${statusText}`,
    body.error?.correlationId,
    body.error?.details,
    body.error?.context,
  );
  if (error.status === 401 && error.code === 'AUTH_REQUIRED') sessionLost?.();
  return error;
}

interface ErrorBody {
  error?: {
    code?: string;
    message?: string;
    correlationId?: string;
    context?: ErrorContext;
    details?: ErrorDetails;
  };
}

export async function request<T>(path: string, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      signal: signal ?? null,
      headers: { accept: 'application/json' },
    });
  } catch {
    // Every rejection from fetch itself means the same thing here, and saying so beats
    // "Failed to fetch" — the browser's phrasing for nine different problems.
    throw new ApiError(0, 'UNREACHABLE', 'the core is not reachable', undefined);
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ErrorBody;
    throw refusal(response.status, response.statusText, body);
  }
  return (await response.json()) as T;
}

/**
 * A write.
 *
 * Separate from `request` rather than a method parameter on it, because the two have different
 * obligations: a read can be retried freely and a write cannot, and every caller of this one has
 * to decide what to do when it fails. Nothing here retries on its own.
 */
export async function send<T>(
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  /** `If-Match` mostly: the core requires it on PATCH so two open forms cannot silently race. */
  headers: Readonly<Record<string, string>> = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError(0, 'UNREACHABLE', 'the core is not reachable', undefined);
  }

  if (!response.ok) {
    const failed = (await response.json().catch(() => ({}))) as ErrorBody;
    throw refusal(response.status, response.statusText, failed);
  }
  // A 204 has no body to parse, and asking for one would turn a success into an error.
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export type Loadable<T> =
  { status: 'loading' } | { status: 'ready'; data: T } | { status: 'error'; error: ApiError };

/**
 * Fetch on mount, and again when `path` changes or `reload` is called.
 *
 * Deliberately not a data-fetching library: U-01 needs one request per view and U-02 replaces
 * polling with a WebSocket stream anyway. A cache layer added now would be a cache layer to
 * unpick then.
 */
export function useApi<T>(path: string | null): Loadable<T> & { reload: () => void } {
  const [state, setState] = useState<Loadable<T>>({ status: 'loading' });
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => {
    setNonce((n) => n + 1);
  }, []);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (path === null) return;
    const controller = new AbortController();
    setState({ status: 'loading' });

    request<T>(path, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setState({ status: 'ready', data });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: 'error',
          error:
            error instanceof ApiError
              ? error
              : new ApiError(0, 'UNKNOWN', error instanceof Error ? error.message : String(error)),
        });
      });

    return () => {
      controller.abort();
    };
  }, [path, nonce]);

  return { ...state, reload };
}
