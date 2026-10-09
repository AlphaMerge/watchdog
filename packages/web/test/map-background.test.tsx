import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_IMAGE_BYTES, backgroundUrl } from '../src/maps/background';
import { MapBackgroundControl } from '../src/maps/MapBackgroundControl';
import { MapBackgroundImage } from '../src/maps/MapBackgroundImage';
import { SAY_AGAIN_MS } from '../src/components/refusal';
import { expectQuiet, speaking } from './support/refusal-region';

/**
 * Putting a floor plan behind a map (`G-05`, `ADR-003`).
 *
 * What is asserted here is the browser's half: that the file goes up as bytes rather than as a
 * form, that the one refusal worth making before spending an upload is made, and that a map
 * without a background renders nothing rather than a broken-image icon.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

function fileOf(bytes: number, type = 'image/png'): File {
  return new File([new Uint8Array(bytes)], 'plan.png', { type });
}

describe('where the image lives', () => {
  it('is a stable URL, which is what makes the second visit a revalidation', () => {
    expect(backgroundUrl(4)).toBe('/api/v1/maps/4/background');
  });

  it('is bust once, and only after a change in this tab', () => {
    // The URL being stable is exactly what would otherwise leave somebody staring at the plan
    // they just replaced.
    expect(backgroundUrl(4, 2)).toBe('/api/v1/maps/4/background?v=2');
  });
});

describe('uploading one', () => {
  it('sends the bytes themselves, not a form', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(
        new Response(JSON.stringify({ mediaType: 'image/png' }), { status: 200 }),
      );
    });
    const changed = vi.fn();
    render(<MapBackgroundControl mapId={4} onChanged={changed} />);

    const field = screen.getByLabelText('Background image');
    fireEvent.change(field, { target: { files: [fileOf(64)] } });

    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(calls[0]?.url).toBe('/api/v1/maps/4/background');
    expect(calls[0]?.init.method).toBe('POST');
    // Multipart exists to carry several fields and there is one field here; a parser for it would
    // be a dependency and a second place the size limit has to be enforced.
    expect(calls[0]?.init.body).toBeInstanceOf(File);
    await waitFor(() => {
      expect(changed).toHaveBeenCalledTimes(1);
    });
  });

  it('refuses a file over the ceiling without spending the upload', async () => {
    const fetched = vi.fn();
    vi.stubGlobal('fetch', fetched);
    render(<MapBackgroundControl mapId={4} onChanged={() => undefined} />);

    fireEvent.change(screen.getByLabelText('Background image'), {
      target: { files: [fileOf(MAX_IMAGE_BYTES + 1)] },
    });

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('a background may be 2 MiB');
    });
    // The core and Fastify's body limit both refuse this too; this is the only one of the three
    // that can say so without sending two megabytes first.
    expect(fetched).not.toHaveBeenCalled();
  });

  it('says what the core said when it refuses', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(
          JSON.stringify({ error: { code: 'MAP_INVALID', message: 'SVG is not accepted' } }),
          { status: 400 },
        ),
      ),
    );
    render(<MapBackgroundControl mapId={4} onChanged={() => undefined} />);
    fireEvent.change(screen.getByLabelText('Background image'), {
      target: { files: [fileOf(64)] },
    });

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('SVG is not accepted');
    });
  });

  it('explains a 413 in its own words, because the core never sees that one', async () => {
    // Fastify refuses the body before a handler runs, so there is no `error.message` to quote.
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('', { status: 413 })));
    render(<MapBackgroundControl mapId={4} onChanged={() => undefined} />);
    fireEvent.change(screen.getByLabelText('Background image'), {
      target: { files: [fileOf(64)] },
    });

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('larger than the 2 MiB');
    });
  });
});

describe('drawing one', () => {
  it('renders nothing at all once the request fails', () => {
    // Most maps have no background. Asking "is there one?" before asking for it would be two
    // requests on every map to save one 404 on the ones without.
    const { container } = render(<MapBackgroundImage src={backgroundUrl(4)} />);
    const image = container.querySelector('img');
    expect(image).not.toBeNull();
    fireEvent.error(image as HTMLImageElement);
    expect(container.querySelector('img')).toBeNull();
  });

  it('is decoration, so it announces nothing', () => {
    const { container } = render(<MapBackgroundImage src={backgroundUrl(4)} />);
    const image = container.querySelector('img');
    expect(image?.getAttribute('alt')).toBe('');
    expect(image?.getAttribute('aria-hidden')).toBe('true');
  });
});

/**
 * A refused background, announced (`U-54`): said through an `ErrorPanel` in a region that is in
 * the tree and empty before anything is chosen. The size refusal is decided in the handler that
 * may have just said the same thing, so it empties first and fills a moment later; an upload the
 * core accepts empties it as it starts.
 */
describe('a refused background (U-54)', () => {
  it('says the same size refusal twice, emptied first, and empties on an upload accepted', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(new Response(JSON.stringify({ mediaType: 'image/png' }), { status: 200 })),
    );
    render(<MapBackgroundControl mapId={4} onChanged={() => undefined} />);
    const region = screen.getByRole('alert');
    expectQuiet(region, ['mt-2', 'empty:mt-0']);
    expect(region.parentElement?.lastElementChild).toBe(region);
    expect(region.parentElement?.parentElement?.lastElementChild).toBe(region.parentElement);
    const choose = (bytes: number): void => {
      fireEvent.change(screen.getByLabelText('Background image'), {
        target: { files: [fileOf(bytes)] },
      });
    };

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      choose(MAX_IMAGE_BYTES + 1);
      expect(region.matches(':empty')).toBe(true);
      act(() => {
        vi.advanceTimersByTime(SAY_AGAIN_MS);
      });
      expect(region.textContent).toContain('a background may be 2 MiB');
      const said = region.textContent;

      // The same refusal again: emptied as it is chosen, and only then filled.
      choose(MAX_IMAGE_BYTES + 1);
      expect(region.matches(':empty')).toBe(true);
      act(() => {
        vi.advanceTimersByTime(SAY_AGAIN_MS - 1);
      });
      expect(region.matches(':empty')).toBe(true);
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(region.textContent).toBe(said);
      expect(screen.getByRole('alert')).toBe(region);
    } finally {
      vi.useRealTimers();
    }

    choose(64);
    expect(region.matches(':empty')).toBe(true);
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Background image').disabled).toBe(false);
    });
    expect(speaking()).toEqual([]);
  });

  it('says the core’s refusal in that same node', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(
          JSON.stringify({ error: { code: 'MAP_INVALID', message: 'SVG is not accepted' } }),
          { status: 400 },
        ),
      ),
    );
    render(<MapBackgroundControl mapId={4} onChanged={() => undefined} />);
    const region = screen.getByRole('alert');
    fireEvent.change(screen.getByLabelText('Background image'), {
      target: { files: [fileOf(64)] },
    });
    await waitFor(() => {
      expect(region.textContent).toContain('SVG is not accepted');
    });
    expect(screen.getAllByRole('alert')).toEqual([region]);
  });
});
