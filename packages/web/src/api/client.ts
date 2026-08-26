import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Everything is relative to `/api/v1`.
 *
 * In development Vite proxies that to the core; in production the core serves this app itself,
 * so it is the same origin. Neither case needs a configured base URL, which is why there is no
 * setting for one — a base URL that is always the same value is a way to get it wrong once.
 */
const BASE = '/api/v1';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly correlationId: string | undefined;

  constructor(status: number, code: string, message: string, correlationId?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.correlationId = correlationId;
  }
}

interface ErrorBody {
  error?: { code?: string; message?: string; correlationId?: string };
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
    throw new ApiError(
      response.status,
      body.error?.code ?? 'HTTP_ERROR',
      body.error?.message ?? `${String(response.status)} ${response.statusText}`,
      body.error?.correlationId,
    );
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
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      headers:
        body === undefined
          ? { accept: 'application/json' }
          : { accept: 'application/json', 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError(0, 'UNREACHABLE', 'the core is not reachable', undefined);
  }

  if (!response.ok) {
    const failed = (await response.json().catch(() => ({}))) as ErrorBody;
    throw new ApiError(
      response.status,
      failed.error?.code ?? 'HTTP_ERROR',
      failed.error?.message ?? `${String(response.status)} ${response.statusText}`,
      failed.error?.correlationId,
    );
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
