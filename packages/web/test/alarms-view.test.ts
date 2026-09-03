import { describe, expect, it } from 'vitest';
import { whereSteps } from '../src/routes/alarms-model';
import type { Alarm } from '../src/api/types';

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
