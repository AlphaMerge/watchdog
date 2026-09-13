import { ReportError } from './errors.js';
import { renderOutputs } from './formats.js';
import type { FormatReply, FormatRequest } from './formatter.js';

/**
 * One formatting job, as a worker runs it (`P-204`).
 *
 * Separate from `format-worker.ts` so a test can drive a worker that crashes or hangs on purpose
 * around the same job code, without either behaviour living in shipped code — the probe's pool is
 * tested the same way.
 */

/**
 * Bytes the worker owns outright, so they can be transferred rather than copied.
 *
 * A small `Buffer` shares Node's 8 KiB allocation pool with every other small buffer in the thread,
 * and transferring that pool's `ArrayBuffer` would detach it from all of them. A buffer that already
 * owns its memory — every large one does — is transferred as it is; anything else is copied first.
 */
function owned(bytes: Buffer): Uint8Array {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? new Uint8Array(bytes.buffer, 0, bytes.byteLength)
    : new Uint8Array(bytes);
}

export async function formatJob(
  request: FormatRequest,
): Promise<{ reply: FormatReply; transfer: ArrayBuffer[] }> {
  try {
    const parts = await renderOutputs(
      { name: request.name },
      request.document,
      request.outputs,
      request.at,
    );
    const bodies = parts.map((part) => owned(part.body));
    return {
      reply: {
        id: request.id,
        ok: true,
        parts: parts.map((part, index) => ({
          format: part.format,
          filename: part.filename,
          body: bodies[index] ?? new Uint8Array(),
        })),
      },
      transfer: bodies.map((body) => body.buffer as ArrayBuffer),
    };
  } catch (error: unknown) {
    // **A refusal crosses the thread as a refusal.** A `ReportError` cannot be structured-cloned
    // with its class intact, so its fields are sent and the pool rebuilds it — otherwise a PDF over
    // its page limit would reach the API as a 500 rather than the 422 that tells its author what to
    // narrow.
    return {
      reply:
        error instanceof ReportError
          ? {
              id: request.id,
              ok: false,
              error: {
                kind: 'report',
                code: error.code,
                message: error.message,
                details: { ...error.details },
                context: { ...error.context },
              },
            }
          : {
              id: request.id,
              ok: false,
              error: {
                kind: 'other',
                message: error instanceof Error ? error.message : String(error),
              },
            },
      transfer: [],
    };
  }
}
