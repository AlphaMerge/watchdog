import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ObjectDetail, SensorTypeSummary } from '../src/api/types';
import { ParamsForm } from '../src/routes/detail/ParamsForm';
import { alertSaying, expectCorrelation, expectQuiet, speaking } from './support/refusal-region';

/**
 * A save of a sensor's parameters the core refused, announced (`U-54`).
 *
 * Focus is on *Save parameters* when the refusal comes back, and nothing moves it, so a live
 * region is the only thing that says the save did not happen. The rules `U-48` and `U-52` hold a
 * refusal line to: there, empty, before anything is sent — a region added with its text already in
 * it is not reliably announced (`U-41`) — the core's words in that same node after, with the
 * correlation id (`U-51`), emptied as the next attempt starts, taking no space while empty
 * (`U-45`). Both shapes of refusal, the line and the channel-mode explanation, land in that one
 * region.
 */

const REFUSED = 'sensor params are not valid for "snmp.custom"';

const TYPE: SensorTypeSummary = {
  id: 'snmp.custom',
  category: 'SNMP',
  costHint: 'medium',
  hasPreview: false,
  paramsSchema: { type: 'object', properties: { unit: { type: 'string', title: 'Unit' } } },
};

const DETAIL = {
  id: 43,
  kind: 'sensor',
  name: 'Uptime',
  version: 1,
  sensorType: 'snmp.custom',
  params: { unit: '' },
  redactedParams: [],
} as unknown as ObjectDetail;

const MODE_MESSAGE =
  'this edit would turn channel "value" from a gauge into a counter, which is refused';

const MODE_FIXED = {
  status: 409,
  body: {
    error: {
      code: 'OBJECT_CHANNEL_MODE_FIXED',
      message: MODE_MESSAGE,
      correlationId: 'req-70',
      details: {
        sensorType: 'snmp.custom',
        channels: [{ key: 'value', from: 'gauge', to: 'counter' }],
      },
    },
  },
};

/** A refusal the core sends, or `null` for a save it accepts. */
type Answer = { readonly status: number; readonly body: unknown } | null;

const invalid = (correlationId?: string): Answer => ({
  status: 400,
  body: {
    error: {
      code: 'OBJECT_INVALID',
      message: REFUSED,
      ...(correlationId === undefined ? {} : { correlationId }),
    },
  },
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The core: each `PATCH` takes the next answer. */
function core(...answers: Answer[]): { saves: () => number } {
  let saves = 0;
  vi.stubGlobal('fetch', () => {
    saves += 1;
    const answer = answers.shift() ?? null;
    const [status, body] =
      answer === null ? [200, { ...DETAIL, version: 2 }] : [answer.status, answer.body];
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
  return { saves: () => saves };
}

/** The form, with a change to save. */
function open(): { region: HTMLElement; save: () => void } {
  render(<ParamsForm detail={DETAIL} type={TYPE} onSaved={() => undefined} />);
  const region = screen.getByRole('alert');
  fireEvent.change(screen.getByRole('textbox', { name: 'Unit' }), { target: { value: 'C' } });
  return {
    region,
    save: () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save parameters' }));
    },
  };
}

const settled = async (): Promise<void> => {
  await waitFor(() => {
    expect(screen.getByRole('button', { name: /Save parameters|Saving…/u }).textContent).toBe(
      'Save parameters',
    );
  });
};

describe('a save the core refused (U-54)', () => {
  it('is there empty before, says the core’s words and id in that node, and empties on the next attempt', async () => {
    const { saves } = core(invalid('req-54'), null);
    const { region, save } = open();

    // Before anything was sent: present, empty, assertive by its role.
    expect(region.matches(':empty')).toBe(true);
    expect(region.hasAttribute('aria-live')).toBe(false);

    save();
    expect(await alertSaying(REFUSED)).toBe(region);
    // The id said after the message and a space, in `CorrelationId` (`U-65`).
    expect(region.textContent).toBe(`${REFUSED} req-54`);
    expectCorrelation(region, 'req-54');
    await settled();

    // Accepted: emptied as it starts, and left empty.
    save();
    expect(region.matches(':empty')).toBe(true);
    await waitFor(() => {
      expect(saves()).toBe(2);
    });
    await settled();
    expect(region.matches(':empty')).toBe(true);
    expect(screen.getByRole('alert')).toBe(region);
    expect(saves()).toBe(2);
  });

  it('says a second refusal in the same words by emptying first', async () => {
    core(invalid(), invalid());
    const { region, save } = open();
    save();
    await waitFor(() => {
      expect(region.textContent).toBe(REFUSED);
    });
    await settled();
    save();
    // Committed empty before the core answers: React did not fold the two into one.
    expect(region.matches(':empty')).toBe(true);
    await waitFor(() => {
      expect(region.textContent).toBe(REFUSED);
    });
    expect(screen.getByRole('alert')).toBe(region);
    expect(region.querySelector('span')).toBeNull();
  });

  it('is emptied by Discard changes', async () => {
    core(invalid());
    const { region, save } = open();
    save();
    await waitFor(() => {
      expect(region.textContent).toBe(REFUSED);
    });
    await settled();
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(region.matches(':empty')).toBe(true);
    expect(speaking()).toEqual([]);
  });

  it('says a channel-mode refusal in the same region, with no alert of its own', async () => {
    core(MODE_FIXED);
    const { region, save } = open();
    save();
    expect(await alertSaying('Not saved: this edit would change what a channel stores.')).toBe(
      region,
    );
    expect(within(region).getByRole('listitem').textContent).toBe(
      'Channel value: a gauge cannot become a counter.',
    );
    expect(screen.getAllByRole('alert')).toEqual([region]);

    // The core's sentence, then a space and the id, in one paragraph through `CorrelationId`
    // (`U-70`): not a paragraph of its own, which is said as a line by itself.
    const paragraphs = [...region.querySelectorAll('p')].map((p) => p.textContent);
    expect(paragraphs).toContain(`${MODE_MESSAGE} req-70`);
    expect(paragraphs).not.toContain('req-70');
    expectCorrelation(region, 'req-70');
    expect(region.querySelector('span.font-mono')?.classList.contains('text-xs')).toBe(true);
  });

  it('is in the DOM while empty and takes no space', () => {
    core();
    const { region } = open();
    expectQuiet(region, ['mt-4', 'empty:mt-0']);
    // The last child of a block that is not a stack, and that block the form's last child:
    // `space-y-4` puts a margin on every child but the last, which would sit under the buttons
    // while the region is empty.
    const block = region.parentElement;
    expect(block?.lastElementChild).toBe(region);
    expect(block?.parentElement?.tagName).toBe('FORM');
    expect(block?.parentElement?.lastElementChild).toBe(block);
  });
});

/**
 * Focus through a save of the parameters (`U-23` review).
 *
 * The whole generated form was `disabled` while a save was out, and *Save* and *Discard* with it,
 * so whatever had focus — the box Enter was pressed in, or *Save* — lost it to the page, and
 * nothing put it back: not on a refusal, and not after an accepted save, when *Save* stays
 * disabled with nothing left to save. Now nothing that can hold focus is disabled while the save
 * is out, and a press that leaves its button with nothing to do moves focus to the line that says
 * what it did.
 */
describe('focus through a save of the parameters (U-23 review)', () => {
  /** The core: the first `PATCH` waits for `answer`, and is refused or accepted as told. */
  function held(refuse: boolean): { answer: () => void; saves: () => number } {
    let saves = 0;
    let answer: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      answer = resolve;
    });
    vi.stubGlobal('fetch', async () => {
      saves += 1;
      await hold;
      const [status, body] = refuse
        ? [400, { error: { code: 'OBJECT_INVALID', message: REFUSED } }]
        : [200, { ...DETAIL, version: 2, params: { unit: 'C' } }];
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    });
    return { answer, saves: () => saves };
  }

  /** The page as far as the form sees it: an accepted save re-reads the sensor (`U-36`). */
  function Page(): React.JSX.Element {
    const [detail, setDetail] = useState(DETAIL);
    return (
      <ParamsForm
        detail={detail}
        type={TYPE}
        onSaved={() => {
          setDetail({ ...DETAIL, version: 2, params: { unit: 'C' } });
        }}
      />
    );
  }

  const unit = (): HTMLInputElement => screen.getByRole('textbox', { name: 'Unit' });
  const saveButton = (): HTMLButtonElement =>
    screen.getByRole('button', { name: /^(Save parameters|Saving…)$/u });

  it('keeps focus in the box Enter saved from while the save is out and when it is refused', async () => {
    const { answer, saves } = held(true);
    render(<Page />);
    fireEvent.change(unit(), { target: { value: 'C' } });
    const box = unit();
    const form = box.closest('form');
    if (form === null) throw new Error('no form');
    act(() => {
      box.focus();
    });
    fireEvent.submit(form);
    await waitFor(() => {
      expect(saves()).toBe(1);
    });

    // Out: the box is not disabled and keeps focus; Save says it is unavailable, and is.
    expect(box.disabled).toBe(false);
    expect(document.activeElement).toBe(box);
    expect(saveButton().textContent).toBe('Saving…');
    expect(saveButton().disabled).toBe(false);
    expect(saveButton().getAttribute('aria-disabled')).toBe('true');
    const discard = screen.getByRole<HTMLButtonElement>('button', { name: 'Discard changes' });
    expect(discard.disabled).toBe(false);
    expect(discard.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(discard);
    expect(unit().value).toBe('C');
    fireEvent.submit(form);
    fireEvent.click(saveButton());
    expect(saves()).toBe(1);

    answer();
    await alertSaying(REFUSED);
    expect(document.activeElement).toBe(box);
    await waitFor(() => {
      expect(saveButton().getAttribute('aria-disabled')).toBe('false');
    });
    expect(document.activeElement).toBe(box);
  });

  it('keeps focus on Save while the save is out and when it is refused', async () => {
    const { answer, saves } = held(true);
    render(<Page />);
    fireEvent.change(unit(), { target: { value: 'C' } });
    const pressed = saveButton();
    act(() => {
      pressed.focus();
    });
    fireEvent.click(pressed);
    await waitFor(() => {
      expect(saves()).toBe(1);
    });
    expect(saveButton()).toBe(pressed);
    expect(pressed.disabled).toBe(false);
    expect(pressed.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(pressed);

    answer();
    await alertSaying(REFUSED);
    expect(document.activeElement).toBe(pressed);
    await waitFor(() => {
      expect(pressed.getAttribute('aria-disabled')).toBe('false');
    });
    expect(document.activeElement).toBe(pressed);
  });

  it('moves focus from Save to the line that says it saved, once there is nothing left to save', async () => {
    const { answer } = held(false);
    render(<Page />);
    const status = screen.getByRole('status');
    fireEvent.change(unit(), { target: { value: 'C' } });
    const pressed = saveButton();
    act(() => {
      pressed.focus();
    });
    fireEvent.click(pressed);
    answer();
    await waitFor(() => {
      expect(status.textContent).toBe(
        'Saved. The probe picks the change up on its next configuration push.',
      );
    });
    expect(pressed.disabled).toBe(true);
    expect(document.activeElement).toBe(status);
    expect(status.getAttribute('tabindex')).toBe('-1');
  });

  it('leaves focus in the box an accepted save was made from with Enter', async () => {
    const { answer } = held(false);
    render(<Page />);
    const status = screen.getByRole('status');
    fireEvent.change(unit(), { target: { value: 'C' } });
    const box = unit();
    act(() => {
      box.focus();
    });
    const form = box.closest('form');
    if (form === null) throw new Error('no form');
    fireEvent.submit(form);
    answer();
    await waitFor(() => {
      expect(status.textContent).toContain('Saved.');
    });
    expect(document.activeElement).toBe(box);
  });

  it('moves focus from Discard to the line that says the changes were discarded', () => {
    core();
    render(<Page />);
    const status = screen.getByRole('status');
    fireEvent.change(unit(), { target: { value: 'C' } });
    const discard = screen.getByRole<HTMLButtonElement>('button', { name: 'Discard changes' });
    act(() => {
      discard.focus();
    });
    fireEvent.click(discard);
    expect(unit().value).toBe('');
    expect(discard.disabled).toBe(true);
    expect(document.activeElement).toBe(status);
    expect(status.textContent).toBe('Discarded. The form shows the parameters as they are stored.');
    // Gone with the next change, which is no longer the form as stored.
    fireEvent.change(unit(), { target: { value: 'F' } });
    expect(status.matches(':empty')).toBe(true);
  });
});
