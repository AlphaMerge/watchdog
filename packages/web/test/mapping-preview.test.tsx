import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MappingPreview, type PreviewResult } from '../src/forms/MappingPreview';

/**
 * The mapping editor, driven the way an operator drives it (`U-13`).
 *
 * **What the core answers is not stubbed lightly.** The bodies below are the shapes
 * `rest.custom`'s own `preview` returns — `packages/sensors/test/rest-custom.test.ts` proves they
 * are, against a real check — so what is tested here is the half that only a rendered panel can
 * show: that a paste reaches the core with the form's parameters attached, that a slow answer
 * cannot overwrite a newer one, and that a path selecting values but producing no reading says
 * *why* rather than showing a zero.
 */

interface Asked {
  url: string;
  body: { document: string; contentType: string; params: Record<string, unknown> };
}

/** Records every request and answers with whatever the test scripted, when it chooses to. */
function stubFetch(answer: (asked: Asked) => Promise<PreviewResult> | PreviewResult): {
  asked: Asked[];
} {
  const asked: Asked[] = [];
  vi.stubGlobal('fetch', async (url: string, init: { body?: string }) => {
    const one = { url, body: JSON.parse(init.body ?? '{}') as Asked['body'] };
    asked.push(one);
    const result = await answer(one);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { asked };
}

const EMPTY: PreviewResult = { format: 'json', rows: [], expectations: [], problems: [] };

const DOCUMENT = '{"queue":{"depth":12}}';

/** Opens the panel, which every test does before it can paste anything. */
function open(): void {
  const toggle = screen.getByRole('button', { name: /Test these paths/ });
  if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle);
}

/** Opens the panel if it is shut, pastes, and lets the debounced request run to completion. */
async function paste(document = DOCUMENT): Promise<void> {
  open();
  fireEvent.change(screen.getByLabelText('The response'), { target: { value: document } });
  await act(async () => {
    // Past the debounce, then let the fetch's microtasks drain inside `act` so React has
    // applied the state update by the time the assertions run.
    vi.advanceTimersByTime(500);
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('the mapping preview', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('asks nothing until there is a document to ask about', async () => {
    // The panel is on the form whether or not anybody uses it, and a request per keystroke in an
    // unrelated field would be a request per keystroke in an unrelated field.
    const { asked } = stubFetch(() => EMPTY);
    render(<MappingPreview typeId="rest.custom" params={{ extract: [] }} />);
    open();
    await act(async () => {
      vi.advanceTimersByTime(2_000);
      await Promise.resolve();
    });
    expect(asked).toHaveLength(0);
  });

  it('sends the pasted document with the parameters the form currently holds', async () => {
    const { asked } = stubFetch(() => EMPTY);
    render(
      <MappingPreview
        typeId="rest.custom"
        params={{ extract: [{ key: 'depth', path: '$.queue.depth' }] }}
      />,
    );
    await paste();

    expect(asked).toHaveLength(1);
    expect(asked[0]?.url).toContain('/sensor-types/rest.custom/preview');
    expect(asked[0]?.body.document).toBe(DOCUMENT);
    // Half-finished parameters go as they are: the core does not validate them first, because
    // this form has a half-finished parameter set in it by definition.
    expect(asked[0]?.body.params).toEqual({ extract: [{ key: 'depth', path: '$.queue.depth' }] });
  });

  it('waits for a pause rather than asking per keystroke', async () => {
    const { asked } = stubFetch(() => EMPTY);
    render(<MappingPreview typeId="rest.custom" params={{}} />);
    open();

    const box = screen.getByLabelText('The response');
    for (const text of ['{', '{"a"', '{"a":1}']) {
      fireEvent.change(box, { target: { value: text } });
      act(() => {
        vi.advanceTimersByTime(100);
      });
    }
    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });

    expect(asked).toHaveLength(1);
    expect(asked[0]?.body.document).toBe('{"a":1}');
  });

  it('shows what each path selected and the reading it makes', async () => {
    stubFetch(() => ({
      format: 'json',
      rows: [
        {
          key: 'depth',
          path: '$.queue.depth',
          selected: [{ text: '12', numeric: true }],
          selectedCount: 1,
          value: 12,
        },
      ],
      expectations: [],
      problems: [],
    }));
    render(<MappingPreview typeId="rest.custom" params={{}} />);
    await paste();

    expect(screen.getByText('depth')).toBeDefined();
    expect(screen.getByText('$.queue.depth')).toBeDefined();
    expect(screen.getByText('12', { selector: 'code' })).toBeDefined();
  });

  it('says a path found nothing rather than drawing it as zero', async () => {
    // The rule the whole system is built on. A preview that printed 0 here would teach exactly
    // the mistake the storage layer refuses to make.
    stubFetch(() => ({
      format: 'json',
      rows: [{ key: 'gone', path: '$.queue.removed', selected: [], selectedCount: 0, value: null }],
      expectations: [],
      problems: [],
    }));
    render(<MappingPreview typeId="rest.custom" params={{}} />);
    await paste();

    expect(screen.getByText('no reading')).toBeDefined();
    expect(screen.queryByText('0')).toBeNull();
  });

  it('marks the selected values no aggregate can use, which is why a reading is missing', async () => {
    // The commonest confusion this panel exists to end: five values on screen and no number.
    stubFetch(() => ({
      format: 'json',
      rows: [
        {
          key: 'names',
          path: '$.nodes[*].name',
          selected: [
            { text: 'a', numeric: false },
            { text: 'b', numeric: false },
          ],
          selectedCount: 2,
          value: null,
        },
      ],
      expectations: [],
      problems: [],
    }));
    render(<MappingPreview typeId="rest.custom" params={{}} />);
    await paste();

    const chip = screen.getByText('a', { selector: 'code' });
    // Read off the accessible text, not the shading: colour alone would say this to nobody
    // using a screen reader and nobody printing the page in grey (WCAG 1.4.1).
    expect(chip.textContent).toContain('not a number');
    expect(screen.getByText('no reading')).toBeDefined();
  });

  it('says how many a wildcard really selected when it shows only some', async () => {
    stubFetch(() => ({
      format: 'json',
      rows: [
        {
          key: 'all',
          path: '$.rows[*].v',
          selected: Array.from({ length: 10 }, (_v, i) => ({ text: String(i), numeric: true })),
          selectedCount: 40,
          value: 40,
        },
      ],
      expectations: [],
      problems: [],
    }));
    render(<MappingPreview typeId="rest.custom" params={{}} />);
    await paste();

    expect(screen.getByText(/30 more, 40 in all/)).toBeDefined();
  });

  it('reports a path that does not parse on its own row', async () => {
    stubFetch(() => ({
      format: 'json',
      rows: [
        {
          key: 'broken',
          path: '$.nodes[?(@.load',
          error: 'a filter that is never closed',
          selected: [],
          selectedCount: 0,
          value: null,
        },
      ],
      expectations: [],
      problems: ['channel "broken": a filter that is never closed'],
    }));
    render(<MappingPreview typeId="rest.custom" params={{}} />);
    await paste();

    expect(screen.getByText('a filter that is never closed')).toBeDefined();
    expect(screen.getByText(/this check would fail/)).toBeDefined();
  });

  it('says the document did not parse, instead of a table of empty rows', async () => {
    stubFetch(() => ({
      format: 'json',
      error: 'this is not JSON: Unexpected token <',
      rows: [],
      expectations: [],
      problems: [],
    }));
    render(<MappingPreview typeId="rest.custom" params={{}} />);
    await paste('<html>nope</html>');

    expect(screen.getByText(/this is not JSON/)).toBeDefined();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('names the format it was read as, since auto is a guess', async () => {
    stubFetch(() => ({ ...EMPTY, format: 'xml' }));
    render(<MappingPreview typeId="rest.custom" params={{}} />);
    await paste('<cluster/>');
    expect(screen.getByText('xml')).toBeDefined();
  });

  it('shows the expected values, which fail a check whatever the channels say', async () => {
    stubFetch(() => ({
      format: 'json',
      rows: [{ key: 'depth', path: '$.queue.depth', selected: [], selectedCount: 1, value: 12 }],
      expectations: [
        { path: '$.status', actual: 'degraded', ok: false },
        { path: '$.version', actual: '4.2.1', ok: true },
      ],
      problems: ['$.status is "degraded", which is not what this sensor expects'],
    }));
    render(<MappingPreview typeId="rest.custom" params={{}} />);
    await paste();

    expect(screen.getByText('$.status')).toBeDefined();
    expect(screen.getByText(/is “degraded”/)).toBeDefined();
    expect(screen.getByText(/this check would fail/)).toBeDefined();
  });

  it('lets a newer answer win when an older one is still in flight', async () => {
    // The failure this catches is silent: a slow reply landing after a fast one leaves the panel
    // describing paths nobody has any more, and nothing on screen says it is stale.
    let release: (() => void) | null = null;
    const { asked } = stubFetch(async (one) => {
      if (asked.length === 1) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { ...EMPTY, format: 'stale' };
      }
      return { ...EMPTY, format: one.body.document === DOCUMENT ? 'fresh' : 'other' };
    });

    render(<MappingPreview typeId="rest.custom" params={{}} />);
    await paste('{"first":1}');
    await paste();

    expect(screen.getByText('fresh')).toBeDefined();

    // The first request finishes last, and must not repaint what the second one answered.
    await act(async () => {
      release?.();
      await Promise.resolve();
    });
    expect(screen.getByText('fresh')).toBeDefined();
    expect(screen.queryByText('stale')).toBeNull();
  });

  it('refuses a document bigger than the core reads, without sending it', async () => {
    // 256 kB across the wire to be told 400 is a round trip that says nothing useful; this says
    // what to do instead.
    const { asked } = stubFetch(() => EMPTY);
    render(<MappingPreview typeId="rest.custom" params={{}} />);
    await paste('x'.repeat(300_000));

    expect(asked).toHaveLength(0);
    expect(screen.getByText(/paste the part with the values in it/)).toBeDefined();
  });

  it('surfaces a refusal from the core rather than showing the last good answer', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(
          JSON.stringify({ error: { code: 'OBJECT_INVALID', message: 'no paths to preview' } }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    render(<MappingPreview typeId="icmp.ping" params={{}} />);
    await paste();

    expect(screen.getByText('no paths to preview')).toBeDefined();
  });
});
