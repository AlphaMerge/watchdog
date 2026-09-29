import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { confirmReload, kindOf, useConfirmReload, whereSteps } from '../src/routes/alarms-model';
import type { Alarm, AlarmPage, HeldReturn } from '../src/api/types';

function alarm(path: number[], pathNames: string[]): Alarm {
  return {
    sensorId: path[path.length - 1] ?? 0,
    sensorName: pathNames[pathNames.length - 1] ?? '',
    state: 'down',
    cause: 'scan',
    message: 'ETIMEDOUT',
    since: '2026-08-26T12:00:00.000Z',
    priority: 3,
    path,
    pathNames,
    acknowledged: false,
    acknowledgedUntil: null,
    consecutiveFailures: 2,
    recovering: null,
  };
}

describe('where an alarm is', () => {
  it('names the device and the group above it, and not the sensor', () => {
    // The sensor's name is already the row's heading; repeating it would be the same word twice.
    const steps = whereSteps(
      alarm([1, 2, 6, 7, 8], ['Root', 'Smoke probe', 'Development', 'ms-target', 'Ping']),
    );
    expect(steps).toEqual([
      { id: 6, name: 'Development' },
      { id: 7, name: 'ms-target' },
    ]);
  });

  it('stops short of the root on a shallow tree rather than repeating it', () => {
    const steps = whereSteps(alarm([1, 2, 3], ['Root', 'probe', 'Ping']));
    expect(steps).toEqual([
      { id: 1, name: 'Root' },
      { id: 2, name: 'probe' },
    ]);
  });

  it('has nothing to say about a sensor with no ancestors', () => {
    expect(whereSteps(alarm([8], ['Ping']))).toEqual([]);
  });

  it('falls back to the id when a name is missing rather than rendering "undefined"', () => {
    // The two arrays come from the same query and are the same length, but a row that ever
    // disagreed would put the word "undefined" on the operator's home screen.
    const steps = whereSteps(alarm([1, 6, 7, 8], ['Root', 'Development', 'ms-target']));
    expect(steps.map((step) => step.name)).toEqual(['Development', 'ms-target']);
  });
});

/** The core's clock when the page was read. */
const CORE_NOW = '2026-09-29T12:00:00.000Z';
const coreAt = (seconds: number): string =>
  new Date(Date.parse(CORE_NOW) + seconds * 1000).toISOString();

function held(confirmsIn: number | null, state: Alarm['state'] = 'up'): Alarm {
  const recovering: HeldReturn = {
    since: coreAt(-60),
    confirmsAt: confirmsIn === null ? null : coreAt(confirmsIn),
  };
  return { ...alarm([1, 2, 3], ['Root', 'probe', 'Probe Health']), state, recovering };
}

function page(items: Alarm[], now = CORE_NOW): AlarmPage {
  return { items, total: items.length, counts: {}, now };
}

describe('what a row counts as (`M-18`)', () => {
  it('is its state when that is an alarm state, and a held return when the sensor is back', () => {
    expect(kindOf(alarm([1], ['Ping']))).toBe('down');
    expect(kindOf(held(240))).toBe('recovering');
    // Back from Down only as far as Warning: a Warning, with the hold beside it, as the core
    // counts it.
    expect(kindOf(held(240, 'warning'))).toBe('warning');
  });
});

describe('when the list asks again for a held return’s end (`M-18`)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('has nothing to wait for when nothing is held', () => {
    expect(confirmReload(page([alarm([1], ['Ping'])]), 0)).toBeNull();
    expect(confirmReload(page([held(null)]), 0)).toBeNull();
  });

  it('waits until the earliest hold ends, a second past it, on the core’s clock whatever the browser’s says', () => {
    // The browser ten minutes behind the core and ten minutes ahead of it: the wait is the
    // core's four minutes either way. Worked out from the browser's clock it would be fourteen
    // minutes, or none.
    for (const skew of [-600_000, 0, 600_000]) {
      vi.useFakeTimers();
      vi.setSystemTime(Date.parse(CORE_NOW) + skew);
      expect(confirmReload(page([held(600), held(240)]), 0)).toEqual({
        delayMs: 241_000,
        pastDue: false,
      });
      vi.useRealTimers();
    }
  });

  it('backs off from a hold already past its end: 2 s, 5 s, then 15 s and no less', () => {
    const late = page([held(-1)]);
    expect([0, 1, 2, 3, 50].map((tries) => confirmReload(late, tries)?.delayMs)).toEqual([
      2_000, 5_000, 15_000, 15_000, 15_000,
    ]);
    expect(confirmReload(late, 0)?.pastDue).toBe(true);
  });

  it('reloads once when the hold ends, timed from the page and not the browser’s clock', () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(CORE_NOW) - 600_000);
    const reload = vi.fn();
    const current = page([held(240)]);
    renderHook(() => {
      useConfirmReload(current, reload);
    });
    vi.advanceTimersByTime(240_999);
    expect(reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not reload on every render of a page whose hold is past due, and backs off across pages', () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    const first = page([held(-5)]);
    const { rerender } = renderHook(
      ({ current }: { current: AlarmPage }) => {
        useConfirmReload(current, reload);
      },
      { initialProps: { current: first } },
    );
    for (let render = 0; render < 5; render += 1) rerender({ current: first });
    vi.advanceTimersByTime(1_999);
    expect(reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(reload).toHaveBeenCalledTimes(1);
    // The same page again schedules nothing more: it was planned once.
    vi.advanceTimersByTime(60_000);
    expect(reload).toHaveBeenCalledTimes(1);

    // The sweep still late: each page it answers with waits longer, and no less than 15 s.
    const waits: number[] = [];
    for (let asked = 0; asked < 4; asked += 1) {
      const before = reload.mock.calls.length;
      rerender({ current: page([held(-5 - asked)]) });
      let waited = 0;
      while (reload.mock.calls.length === before && waited < 60_000) {
        vi.advanceTimersByTime(1_000);
        waited += 1_000;
      }
      waits.push(waited);
    }
    expect(waits).toEqual([5_000, 15_000, 15_000, 15_000]);

    // The first page without a late hold starts the count again.
    rerender({ current: page([]) });
    const before = reload.mock.calls.length;
    rerender({ current: page([held(-1)]) });
    vi.advanceTimersByTime(2_000);
    expect(reload.mock.calls.length).toBe(before + 1);
  });
});
