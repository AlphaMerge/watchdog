import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ResolvedWidget } from '../src/api/types';
import { MapCanvas } from '../src/maps/MapBoard';
import { MapDesigner } from '../src/maps/MapDesigner';
import { MAX_HTML, readCanvas, writeLayout, type Canvas } from '../src/maps/canvas';

/**
 * Custom HTML widgets (`G-07`, `ADR-002` Decision 2).
 *
 * **The claim under test is the sandbox, and it is asserted on the attribute** rather than by
 * trying to make hostile markup misbehave: jsdom does not enforce a sandbox, so a test that
 * "proved" a script did not run would prove nothing at all. What can be checked here is that the
 * markup reaches a frame, that the frame is sandboxed with no tokens, and that nothing anywhere
 * between the document and the frame rewrites what an operator typed — the three things that
 * would have to be true for the browser's guarantee to apply.
 */

const HOSTILE = '<img src=x onerror="alert(1)"><script>fetch("/api/v1/maps")</script>';

function htmlWidget(html: string): ResolvedWidget {
  return {
    id: 'w1',
    kind: 'html',
    box: { x: 0, y: 0, w: 8, h: 4 },
    title: 'On call',
    state: 'ok',
    data: { kind: 'html', html },
  };
}

function view(...widgets: ResolvedWidget[]): { widgets: ResolvedWidget[]; connectors: [] } {
  return { widgets, connectors: [] };
}

describe('drawing one', () => {
  it('puts the markup in a frame with every restriction on', () => {
    const { container } = render(
      <MapCanvas
        view={view(htmlWidget(HOSTILE))}
        states={new Map()}
        tick={0}
        graphs="chart"
        backgroundSrc={null}
      />,
    );

    const frame = container.querySelector('iframe');
    expect(frame).not.toBeNull();
    // **An empty string, not a missing attribute.** Absent means "not sandboxed"; `sandbox=""` is
    // every restriction at once — opaque origin, no scripts, no forms, no navigation.
    expect(frame?.getAttribute('sandbox')).toBe('');
    expect(frame?.hasAttribute('src')).toBe(false);
  });

  it('hands the frame exactly what was typed', () => {
    // Not cleaned on the way in or the way out: the sandbox is the defence, and a half-sanitiser
    // in front of it is a weaker second one somebody would start relying on.
    const { container } = render(
      <MapCanvas
        view={view(htmlWidget(HOSTILE))}
        states={new Map()}
        tick={0}
        graphs="chart"
        backgroundSrc={null}
      />,
    );
    expect(container.querySelector('iframe')?.getAttribute('srcdoc')).toBe(HOSTILE);
  });

  it('names the frame, because nothing inside it can', () => {
    const { container } = render(
      <MapCanvas
        view={view(htmlWidget('<p>hi</p>'), htmlWidget(''))}
        states={new Map()}
        tick={0}
        graphs="chart"
        backgroundSrc={null}
      />,
    );
    const frames = container.querySelectorAll('iframe');
    expect(frames[0]?.getAttribute('title')).toBe('On call');
  });

  it('draws the same frame on a shared map, where it matters most', () => {
    // `ADR-002`: operator markup on a public map is content served to strangers. The public page
    // renders through this same component, so there is one sandbox rather than two.
    const { container } = render(
      <MapCanvas
        view={view(htmlWidget(HOSTILE))}
        states={new Map()}
        tick={0}
        graphs="values"
        backgroundSrc={null}
      />,
    );
    expect(container.querySelector('iframe')?.getAttribute('sandbox')).toBe('');
  });
});

describe('editing one', () => {
  const EMPTY: Canvas = readCanvas({ widgets: [] });

  function designer(): void {
    render(<MapDesigner initial={EMPTY} save={() => Promise.resolve()} />);
  }

  it('adds a custom HTML tile without asking which object it draws', async () => {
    // Every other kind needs a sensor or a group. This one draws what somebody typed, so the
    // picker is not part of adding it — and the Add button must not wait for a pick that will
    // never come.
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('{}', { status: 200 })));
    designer();

    fireEvent.change(screen.getByLabelText('Widget'), { target: { value: 'html' } });
    expect(screen.queryByLabelText('Sensor')).toBeNull();

    const add = screen.getByRole('button', { name: 'Add widget' });
    expect((add as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(add);

    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'Custom HTML' })).toBeDefined();
    });
  });

  it('says what a custom widget cannot do, where somebody is typing it', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('{}', { status: 200 })));
    designer();
    fireEvent.change(screen.getByLabelText('Widget'), { target: { value: 'html' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add widget' }));

    await waitFor(() => {
      expect(screen.getByText(/scripts do not run/)).toBeDefined();
    });
    // The surprising half, said before an afternoon is spent on a stylesheet that cannot load.
    expect(screen.getByText(/external images and stylesheets do not load/)).toBeDefined();
  });

  it('keeps the markup in the document, bounded', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('{}', { status: 200 })));
    const saved: Canvas[] = [];
    render(
      <MapDesigner
        initial={EMPTY}
        save={(canvas) => {
          saved.push(canvas);
          return Promise.resolve();
        }}
      />,
    );

    fireEvent.change(screen.getByLabelText('Widget'), { target: { value: 'html' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add widget' }));
    const field = await screen.findByRole('textbox', { name: 'Custom HTML' });
    fireEvent.change(field, { target: { value: HOSTILE } });
    fireEvent.click(screen.getByRole('button', { name: /^Save/ }));

    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    const layout = writeLayout(saved[0] ?? EMPTY);
    expect(layout.widgets[0]?.['html']).toBe(HOSTILE);
    expect(layout.widgets[0]?.['objectId']).toBe(null);
  });

  it('truncates rather than refusing markup past the ceiling', () => {
    const long = readCanvas({ widgets: [{ id: 'w1', kind: 'html', html: 'x'.repeat(9000) }] });
    expect(long.tiles[0]?.html.length).toBe(MAX_HTML);
  });
});
