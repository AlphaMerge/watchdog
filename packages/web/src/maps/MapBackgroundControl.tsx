import { useRef, useState } from 'react';
import { ApiError } from '../api/client';
import { RefusalPanel } from '../components/Panels';
import { useRefusal } from '../components/refusal';
import { MAX_IMAGE_BYTES, backgroundUrl } from './background';

/**
 * Putting a floor plan behind a map, and taking it off again (`G-05`, `ADR-003`).
 *
 * **The upload is not a form post and not multipart.** The body is the file's bytes and nothing
 * else: multipart exists to carry several fields, there is one field here, and a parser for it
 * would be a dependency and a second place a size limit has to be enforced.
 *
 * **Nothing here decides what the file is.** The browser's `type` is passed along because it costs
 * nothing, and the core ignores it and reads the header instead. A check here would be a check a
 * caller can skip.
 */
export function MapBackgroundControl({
  mapId,
  onChanged,
  disabled = false,
}: {
  readonly mapId: number;
  /**
   * Told after an upload or a removal, so the canvas re-requests the image.
   *
   * The URL is stable on purpose (`ADR-003` Decision 4), which is what makes a second visit a
   * revalidation — and also what would leave somebody staring at the plan they just replaced.
   * The canvas owns the cache-buster because the canvas is what draws it.
   */
  readonly onChanged: () => void;
  readonly disabled?: boolean;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure, sayAgain] = useRefusal<ApiError>();
  const field = useRef<HTMLInputElement>(null);

  const send = async (method: 'POST' | 'DELETE', file?: File): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      const response = await fetch(backgroundUrl(mapId), {
        method,
        ...(file === undefined
          ? {}
          : { body: file, headers: { 'content-type': file.type || 'application/octet-stream' } }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as {
          error?: { code?: string; message?: string };
        };
        throw new ApiError(
          response.status,
          body.error?.code ?? 'UPLOAD_FAILED',
          body.error?.message ??
            (response.status === 413
              ? 'that file is larger than the 2 MiB a background may be'
              : 'the upload was refused'),
        );
      }
      onChanged();
      if (field.current !== null) field.current.value = '';
    } catch (error: unknown) {
      setFailure(
        error instanceof ApiError
          ? error
          : new ApiError(0, 'UNREACHABLE', 'the core is not reachable'),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <h3 className="ms-label">Background</h3>
      <div className="flex flex-wrap items-center gap-3">
        <input
          ref={field}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          disabled={disabled || busy}
          aria-label="Background image"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file === undefined) return;
            // Refused here as well as by the core and by Fastify's body limit, because this is the
            // only one of the three that can say so without spending the upload first. Decided in
            // this handler, which may have just said the same, so emptied first (`U-54`).
            if (file.size > MAX_IMAGE_BYTES) {
              sayAgain(
                new ApiError(
                  0,
                  'MAP_INVALID',
                  `that file is ${String(Math.round(file.size / 1024))} KiB; a background may be 2 MiB`,
                ),
              );
              return;
            }
            void send('POST', file);
          }}
          className="text-xs text-text-muted"
        />
        <button
          type="button"
          onClick={() => {
            void send('DELETE');
          }}
          disabled={disabled || busy}
          className="ms-label border border-control px-2 py-1 text-text-muted hover:text-text disabled:opacity-50"
        >
          Remove background
        </button>
      </div>
      {/* One block, the stack's last child, with the refusal always in it (`U-54`), as in
          `MapPriority`. */}
      <div>
        <p className="text-xs text-text-muted">
          PNG, JPEG or WebP, at most 2 MiB and 4096 pixels a side. SVG is not accepted.
        </p>
        <RefusalPanel error={failure} className="mt-2 empty:mt-0" />
      </div>
    </div>
  );
}
