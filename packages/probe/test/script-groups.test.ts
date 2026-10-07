import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  GroupLines,
  MAX_GROUPS_PER_CHECK,
  parseProc,
  readProc,
  ScriptGroups,
  type GroupSignal,
  type ProcessEntry,
  type ProcessView,
} from '../src/runner/script-groups.js';
import { GROUP_MARKER } from '../src/runner/types.js';
import { within } from './support/probe-process.js';

/**
 * What the runner believes of a check process's group lines (`P-266`), and what it then kills.
 *
 * The runner may be root, running checks as another user, and a script of that user can write to
 * its check process's stdout. Every case here where a line is not believed is a process the probe
 * would otherwise have killed for whoever wrote it.
 */

const CHECK = 5000;
const SCRIPT = 5001;

const line = (event: 'started' | 'ended', pgid: number): string =>
  `${GROUP_MARKER}${event} ${String(pgid)}\n`;

/** A script group as `runProgram`'s spawn makes one: its own session and group, the check's child. */
const own = (pid: number, starttime = '777', uid = 1000): ProcessEntry => ({
  pid,
  ppid: CHECK,
  pgrp: pid,
  session: pid,
  starttime,
  uid,
});

/** A `/proc` that says what the test says, and records every signal asked of it. */
function fakeView(
  table: Map<number, ProcessEntry | null>,
  groups: Map<number, GroupSignal> = new Map(),
): { view: ProcessView; signals: [number, 0 | 'SIGKILL'][] } {
  const signals: [number, 0 | 'SIGKILL'][] = [];
  return {
    signals,
    view: {
      read: (pid) => table.get(pid) ?? null,
      signalGroup: (pgid, signal) => {
        signals.push([pgid, signal]);
        return groups.get(pgid) ?? 'gone';
      },
    },
  };
}

describe('the group lines (`P-266`)', () => {
  it('reads a group from its start to its end, however the chunks fall', () => {
    const lines = new GroupLines();
    assert.deepEqual(lines.push(line('started', 4242)), [{ event: 'started', pgid: 4242 }]);
    assert.deepEqual(lines.push(`${GROUP_MARKER}sta`), []);
    assert.deepEqual(lines.push('rted 4343'), [], 'not before its line ends');
    assert.deepEqual(lines.push(`\n${GROUP_MARKER}ended 4242\nbanner\nmore`), [
      { event: 'started', pgid: 4343 },
      { event: 'ended', pgid: 4242 },
    ]);
  });

  it('reads nothing that is not a group line by its syntax', () => {
    const lines = new GroupLines();
    for (const said of [
      'started 0',
      'started 1',
      `started ${String(process.pid)}`,
      'started -4242',
      'started +4242',
      'started 04242',
      'started 4242 ',
      'started 4242x',
      'started  4242',
      'started 12345678901',
      'begun 4242',
    ]) {
      assert.deepEqual(lines.push(`${GROUP_MARKER}${said}\n`), [], said);
    }
    assert.deepEqual(lines.push(`said ${GROUP_MARKER}started 4242\n`), []);
    // A long line that ends in a group line is still the end of a long line.
    assert.deepEqual(lines.push('x'.repeat(80)), []);
    assert.deepEqual(lines.push(line('started', 4242)), []);
    assert.deepEqual(lines.push(line('started', 4242)), [{ event: 'started', pgid: 4242 }]);
  });
});

describe('verifying a group at its start (`P-266`)', () => {
  it('records its own group and forgets it when it ends', () => {
    const { view } = fakeView(new Map([[SCRIPT, own(SCRIPT)]]));
    const groups = new ScriptGroups(view, CHECK, 1000);
    groups.push(line('started', SCRIPT));
    assert.deepEqual(groups.open(), [SCRIPT]);
    assert.deepEqual(groups.refused, []);
    groups.push(line('ended', SCRIPT));
    assert.deepEqual(groups.open(), []);
  });

  const forgeries: [string, ProcessEntry][] = [
    // `sshd`, the postmaster or the core under systemd: its own session leader, init's child.
    ['another parent’s child, a service', { ...own(SCRIPT), ppid: 1 }],
    ['a process that is not its group’s leader', { ...own(SCRIPT), pgrp: 4000 }],
    ['a process that is not its session’s leader', { ...own(SCRIPT), session: 4000 }],
    ['a stat that is another pid’s', { ...own(SCRIPT), pid: 4000 }],
    ['another user’s process', { ...own(SCRIPT), uid: 0 }],
  ];
  for (const [what, entry] of forgeries) {
    it(`refuses ${what}, and counts it`, () => {
      const { view } = fakeView(new Map([[SCRIPT, entry]]));
      const groups = new ScriptGroups(view, CHECK, 1000);
      groups.push(line('started', SCRIPT));
      assert.deepEqual(groups.open(), []);
      assert.deepEqual(groups.refused, [SCRIPT]);
    });
  }

  it('does not ask the uid when the runner sets none', () => {
    const { view } = fakeView(new Map([[SCRIPT, own(SCRIPT, '777', 0)]]));
    const groups = new ScriptGroups(view, CHECK);
    groups.push(line('started', SCRIPT));
    assert.deepEqual(groups.open(), [SCRIPT]);
  });

  it('passes over a group that is not there, uncounted: a script that ended at once', () => {
    const { view } = fakeView(new Map());
    const groups = new ScriptGroups(view, CHECK, 1000);
    groups.push(line('started', SCRIPT));
    assert.deepEqual(groups.open(), []);
    assert.deepEqual(groups.refused, []);
  });

  it('reads /proc for at most a handful of lines from one check process', () => {
    let reads = 0;
    const groups = new ScriptGroups(
      {
        read: (pid) => {
          reads += 1;
          return { ...own(pid), ppid: 1 };
        },
        signalGroup: () => 'gone',
      },
      CHECK,
    );
    for (let pid = 10_000; pid < 10_100; pid += 1) groups.push(line('started', pid));
    assert.equal(reads, MAX_GROUPS_PER_CHECK);
    assert.equal(groups.refused.length, 100, 'every one past the bound refused as well');
  });
});

describe('ending what a check process left (`P-266`)', () => {
  function recorded(
    later: ProcessEntry | null,
    group: GroupSignal = 'sent',
  ): ReturnType<typeof fakeView> & { groups: ScriptGroups } {
    const table = new Map<number, ProcessEntry | null>([[SCRIPT, own(SCRIPT, '777')]]);
    const fake = fakeView(table, new Map([[SCRIPT, group]]));
    const groups = new ScriptGroups(fake.view, CHECK, 1000);
    groups.push(line('started', SCRIPT));
    assert.deepEqual(groups.open(), [SCRIPT], 'recorded to begin with');
    table.set(SCRIPT, later);
    return { ...fake, groups };
  }

  it('kills the group while its leader is the one recorded', () => {
    const { groups, signals } = recorded(own(SCRIPT, '777'));
    assert.deepEqual(groups.endLeftBehind(), { ended: [SCRIPT], recycled: [], failed: [] });
    assert.deepEqual(signals, [[SCRIPT, 'SIGKILL']]);
  });

  it('leaves alone a pid that names another process now, and says so', () => {
    // The leader was reaped and its pid handed to a newcomer: another sensor's check process,
    // say, which `runProgram` also makes a group leader.
    const { groups, signals } = recorded({ ...own(SCRIPT, '9999'), ppid: 1 });
    assert.deepEqual(groups.endLeftBehind(), { ended: [], recycled: [SCRIPT], failed: [] });
    assert.deepEqual(signals, [], 'not even asked whether it lives');
  });

  it('kills a group whose leader is gone while members hold its id', () => {
    const { groups, signals } = recorded(null, 'sent');
    assert.deepEqual(groups.endLeftBehind(), { ended: [SCRIPT], recycled: [], failed: [] });
    assert.deepEqual(signals, [
      [SCRIPT, 0],
      [SCRIPT, 'SIGKILL'],
    ]);
  });

  it('does nothing for a group that has gone entirely', () => {
    const { groups, signals } = recorded(null, 'gone');
    assert.deepEqual(groups.endLeftBehind(), { ended: [], recycled: [], failed: [] });
    assert.deepEqual(signals, [[SCRIPT, 0]]);
  });

  it('reports a kill it was refused', () => {
    const { groups } = recorded(own(SCRIPT, '777'), { refused: 'EPERM' });
    assert.deepEqual(groups.endLeftBehind(), {
      ended: [],
      recycled: [],
      failed: [{ pgid: SCRIPT, code: 'EPERM' }],
    });
  });

  it('ends nothing that said it had ended', () => {
    const { groups, signals } = recorded(own(SCRIPT, '777'));
    groups.push(line('ended', SCRIPT));
    assert.deepEqual(groups.endLeftBehind(), { ended: [], recycled: [], failed: [] });
    assert.deepEqual(signals, []);
  });
});

describe('reading /proc (`P-266`)', () => {
  it('counts the fields from the last parenthesis, whatever the command is called', () => {
    const fields = ['S', '42', '4242', '4242', ...Array<string>(15).fill('0'), '123456', '9'];
    const entry = parseProc(
      `4242 (a) (b c) ${fields.join(' ')}\n`,
      'Name:\tx\nUid:\t1000\t0\t0\t0\n',
    );
    assert.deepEqual(entry, {
      pid: 4242,
      ppid: 42,
      pgrp: 4242,
      session: 4242,
      starttime: '123456',
      uid: 1000,
    });
  });

  it('reads nothing from a stat it cannot make sense of', () => {
    assert.equal(parseProc('', ''), null);
    assert.equal(parseProc('4242 (x) S 42', 'Uid:\t0\t0\t0\t0\n'), null, 'too short');
    const fields = ['S', '42', '4242', '4242', ...Array<string>(15).fill('0'), '123456'];
    assert.equal(parseProc(`4242 (x) ${fields.join(' ')}`, 'Name:\tx\n'), null, 'no uid');
  });

  it(
    'reads a real session leader, oddly named, on Linux',
    { skip: process.platform === 'linux' ? false : 'Linux only' },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'ms-p266-'));
      const odd = join(dir, 'a) (b c');
      await copyFile('/bin/sleep', odd);
      const child = spawn(odd, ['30'], { detached: true, stdio: 'ignore' });
      try {
        const pid = child.pid ?? 0;
        assert.ok(pid > 1);
        await within(5_000, 'the copy to start', new Promise((done) => child.once('spawn', done)));
        const entry = readProc(pid);
        assert.ok(entry !== null);
        assert.equal(entry.pid, pid);
        assert.equal(entry.ppid, process.pid);
        assert.equal(entry.pgrp, pid, 'its own group');
        assert.equal(entry.session, pid, 'and its own session');
        assert.equal(entry.uid, process.getuid?.());
        assert.match(entry.starttime, /^\d+$/);
        assert.equal(readProc(process.pid)?.starttime, readProc(process.pid)?.starttime);
      } finally {
        child.kill('SIGKILL');
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
