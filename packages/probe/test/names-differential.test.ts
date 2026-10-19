import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { DnsSimulator, dnsQuery, replies } from '@ms/simulators';
import { startCapture, type CaptureOptions } from './differential/names-capture.js';
import {
  NAMESERVER,
  STUB,
  canonicalAddress,
  classificationProblem,
  digestOf,
  expectationIn,
  judgePlan,
  listenerOf,
  nameserversOf,
  parseRun,
  pcapQuestions,
  recordingsFile,
  resolvedObserved,
  unplayable,
  verify as verifyAt,
  wireOf,
  type Current,
  type Expectation,
  type ImageRun,
  type InImage,
  type PlanRun,
  type Row,
  type RowRun,
  type RowsFile,
  type Wire,
} from './differential/names-differential.js';
import { within } from './support/within.js';

/**
 * The differential's judgement (`P-432` S8, D30): the pure half of `names-replay` and
 * `names-verify`, which `scripts/smoke/name-gate-differential.sh` runs in each image. What glibc
 * sent is held against S4's rows here by the same functions that judge a real run, so a judgement
 * that let a disagreement through would let it through in every image.
 */

const ROWS = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../test/fixtures/system-names-rows.json', import.meta.url)),
    'utf8',
  ),
) as RowsFile;

const ONE: Expectation = {
  class: 'walk',
  candidates: ['sw1.corp.example', 'sw1'],
  types: ['A', 'AAAA'],
  servers: ['10.0.0.53'],
  rotate: false,
  timeout: 5,
  attempts: 2,
  plans: [
    {
      plan: 'nxdomain',
      answers: { '10.0.0.53': { A: 'nxdomain', AAAA: 'nxdomain' } },
      wire: [
        ['10.0.0.53', 'sw1.corp.example', 'A', 1],
        ['10.0.0.53', 'sw1.corp.example', 'AAAA', 1],
        ['10.0.0.53', 'sw1', 'A', 1],
        ['10.0.0.53', 'sw1', 'AAAA', 1],
      ],
    },
    {
      plan: 'answer',
      answers: { '10.0.0.53': { A: 'address', AAAA: 'address' } },
      wire: [
        ['10.0.0.53', 'sw1.corp.example', 'A', 1],
        ['10.0.0.53', 'sw1.corp.example', 'AAAA', 1],
      ],
    },
  ],
};

const ROTATING: Expectation = {
  class: 'walk',
  candidates: ['sw1'],
  types: ['A'],
  servers: ['10.0.0.1', '10.0.0.2'],
  rotate: true,
  timeout: 5,
  attempts: 2,
  plans: [
    {
      plan: 'last-answers-after-servfail',
      answers: { '10.0.0.1': { A: 'servfail' }, '10.0.0.2': { A: 'address' } },
      wireByOffset: [
        [
          ['10.0.0.1', 'sw1', 'A', 1],
          ['10.0.0.2', 'sw1', 'A', 1],
        ],
        [['10.0.0.2', 'sw1', 'A', 1]],
      ],
    },
  ],
};

const ROW: Row = {
  id: 'aaaaaaaaaaaaaaaa',
  title: 'a walked name',
  world: {
    glibc: '2.39',
    hostname: 'probe-1',
    env: {},
    files: {},
    missingModules: [],
    addresses: ['10.0.0.53'],
    ipv6: false,
  },
  question: { name: 'sw1', family: 0 },
  expect: ONE,
  byImage: {},
};

const RESOLV_ROWS: RowsFile = {
  schema: 3,
  images: { debian12: '2.36', ubuntu2404: '2.39' },
  resolved: ['ubuntu2404'],
  texts: {},
  rows: [ROW, { ...ROW, id: 'bbbbbbbbbbbbbbbb', expect: ROTATING, byImage: { debian12: null } }],
};

/** What the policy reads of a row, as the replay records it. */
function classified(e: Expectation): InImage {
  return {
    class: e.class,
    ...(e.via === undefined ? {} : { via: e.via }),
    ...(e.candidates === undefined ? {} : { candidates: e.candidates }),
    ...(e.types === undefined ? {} : { types: e.types }),
    servers: e.servers,
    rotate: e.rotate,
    timeout: e.timeout,
    attempts: e.attempts,
  };
}

/** The rows file and the policy's build every run below replayed, unless it says otherwise. */
const CURRENT: Current = { rowsDigest: 'r0', policyDigest: 'p0' };
const verify = (rows: RowsFile, runs: readonly ImageRun[]): ReturnType<typeof verifyAt> =>
  verifyAt(rows, runs, CURRENT);

/** A run in which glibc did exactly what the policy says: each plan's wire, the first offset. */
function faithful(rows: RowsFile, image: string, glibc = rows.images[image]): ImageRun {
  const out: RowRun[] = [];
  for (const row of rows.rows) {
    const e = expectationIn(row, image);
    if (e === null) continue;
    out.push({
      id: row.id,
      inImage: classified(e),
      plans: e.plans.map((plan) => ({
        plan: plan.plan,
        wire: plan.wire ?? plan.wireByOffset?.[0] ?? [],
        outcome: 'answer:1',
        ms: 3.4,
      })),
    });
  }
  return {
    image,
    glibc,
    node: 'v24.19.0',
    base: `base-of-${image}`,
    digest: 'sha256:0',
    rowsDigest: CURRENT.rowsDigest,
    policyDigest: CURRENT.policyDigest,
    resolved: rows.resolved.includes(image),
    rows: out,
  };
}

describe('the differential: a wire from what the servers saw', () => {
  it('numbers each try of a question at a server, and marks one over TCP', () => {
    assert.deepEqual(
      wireOf([
        { server: '10.0.0.1', qname: 'sw1', qtype: 'A', transport: 'udp' },
        { server: '10.0.0.1', qname: 'sw1', qtype: 'AAAA', transport: 'udp' },
        { server: '10.0.0.2', qname: 'sw1', qtype: 'A', transport: 'udp' },
        { server: '10.0.0.1', qname: 'sw1', qtype: 'A', transport: 'udp' },
        { server: '10.0.0.1', qname: 'sw1', qtype: 'A', transport: 'tcp' },
      ]),
      [
        ['10.0.0.1', 'sw1', 'A', 1],
        ['10.0.0.1', 'sw1', 'AAAA', 1],
        ['10.0.0.2', 'sw1', 'A', 1],
        ['10.0.0.1', 'sw1', 'A', 2],
        ['10.0.0.1/tcp', 'sw1', 'A', 1],
      ],
    );
  });
});

describe('the differential: the policy in the image against the row', () => {
  it('agrees when every field is the row’s', () => {
    assert.equal(classificationProblem(ONE, classified(ONE)), undefined);
  });

  it('names the check off in the image, and each field read otherwise', () => {
    assert.match(
      classificationProblem(ONE, { class: 'off', off: 'module: myhostname is not installed' }) ??
        '',
      /check is off in the image: module: myhostname/u,
    );
    const cases: [Partial<InImage>, RegExp][] = [
      [{ class: 'local', via: 'hosts' }, /reads class as "local"/u],
      [{ candidates: ['sw1', 'sw1.corp.example'] }, /reads candidates as/u],
      [{ types: ['A'] }, /reads types as \["A"\]/u],
      [{ servers: ['10.0.0.54'] }, /reads servers as/u],
      [{ rotate: true }, /reads rotate as true/u],
      [{ timeout: 30 }, /reads timeout as 30, the row says 5/u],
      [{ attempts: 9 }, /reads attempts as 9, the row says 2/u],
    ];
    for (const [change, message] of cases) {
      const read = { ...classified(ONE), ...change } as InImage;
      assert.match(classificationProblem(ONE, read) ?? '', message, JSON.stringify(change));
    }
    const local: Expectation = { ...ONE, class: 'local', via: 'hosts', plans: [] };
    assert.match(
      classificationProblem(local, { ...classified(local), via: 'myhostname' } as InImage) ?? '',
      /reads via as "myhostname"/u,
    );
  });
});

describe('the differential: a plan against the wire glibc sent', () => {
  const sent = (plan: string, wire: readonly Wire[]) => ({ plan, wire, outcome: 'x', ms: 1 });

  it('agrees only with the plan’s wire exactly: no extra, missing, reordered or retried question', () => {
    const wire = ONE.plans[0]?.wire ?? [];
    assert.deepEqual(judgePlan(ONE, sent('nxdomain', wire)), { ok: true });
    const wrong: (readonly Wire[])[] = [
      wire.slice(1),
      [...wire, ['10.0.0.53', 'sw1', 'A', 2]],
      [wire[1], wire[0], wire[2], wire[3]].filter((w) => w !== undefined),
      wire.map((w): Wire => [w[0], w[1], w[2], 2]),
      [...wire.slice(0, 3), ['127.0.0.1', 'sw1', 'AAAA', 1]],
      [],
    ];
    for (const each of wrong) {
      const verdict = judgePlan(ONE, sent('nxdomain', each));
      assert.ok(!verdict.ok, JSON.stringify(each));
      assert.match(verdict.problem, /^nxdomain: the policy expects .* glibc sent/u);
    }
    // A local name: glibc must send nothing at all.
    const local: Expectation = {
      ...ONE,
      class: 'local',
      via: 'hosts',
      plans: [{ plan: 'nxdomain', answers: {}, wire: [] }],
    };
    assert.deepEqual(judgePlan(local, sent('nxdomain', [])), { ok: true });
    assert.equal(judgePlan(local, sent('nxdomain', [['10.0.0.53', 'printer', 'A', 1]])).ok, false);
  });

  it('under rotate, finds which server glibc started at, and refuses any other wire', () => {
    const plan = 'last-answers-after-servfail';
    assert.deepEqual(judgePlan(ROTATING, sent(plan, [['10.0.0.2', 'sw1', 'A', 1]])), {
      ok: true,
      offset: 1,
    });
    assert.deepEqual(
      judgePlan(
        ROTATING,
        sent(plan, [
          ['10.0.0.1', 'sw1', 'A', 1],
          ['10.0.0.2', 'sw1', 'A', 1],
        ]),
      ),
      { ok: true, offset: 0 },
    );
    const verdict = judgePlan(ROTATING, sent(plan, [['10.0.0.1', 'sw1', 'A', 1]]));
    assert.ok(!verdict.ok);
    assert.match(verdict.problem, /expects one of/u);
  });

  it('refuses a plan the row does not have', () => {
    assert.deepEqual(judgePlan(ONE, sent('servfail', [])), {
      ok: false,
      problem: 'the row has no plan servfail',
    });
  });
});

describe('the differential: every image’s run against the rows', () => {
  it('records each plan of each row in each image that replays it, and skips one off there', () => {
    const runs = [faithful(RESOLV_ROWS, 'debian12'), faithful(RESOLV_ROWS, 'ubuntu2404')];
    const verified = verify(RESOLV_ROWS, runs);
    assert.deepEqual(verified.problems, []);
    assert.deepEqual(verified.counts, {
      debian12: { rows: 1, plans: 2 },
      ubuntu2404: { rows: 2, plans: 3 },
    });
    assert.deepEqual(
      verified.recordings.map((r) => [r.image, r.id, r.plan, r.offset, r.ms]),
      [
        ['debian12', ROW.id, 'nxdomain', undefined, 3],
        ['debian12', ROW.id, 'answer', undefined, 3],
        ['ubuntu2404', ROW.id, 'nxdomain', undefined, 3],
        ['ubuntu2404', ROW.id, 'answer', undefined, 3],
        ['ubuntu2404', 'bbbbbbbbbbbbbbbb', 'last-answers-after-servfail', 0, 3],
      ],
    );
    const file = recordingsFile(runs, verified);
    assert.equal(file.schema, 2);
    assert.deepEqual(file.images['ubuntu2404'], {
      base: 'base-of-ubuntu2404',
      digest: 'sha256:0',
      glibc: '2.39',
      node: 'v24.19.0',
      resolved: true,
      rowsDigest: 'r0',
      policyDigest: 'p0',
    });
  });

  it('keeps what resolved asked upstream with the recording', () => {
    const up: Wire[] = [['127.0.0.2', 'sw1', 'A', 1]];
    const other = faithful(RESOLV_ROWS, 'ubuntu2404');
    const through = {
      ...other,
      rows: other.rows.map((row) => ({
        ...row,
        plans: row.plans.map((plan) => ({ ...plan, upstream: up })),
      })),
    };
    const verified = verify(RESOLV_ROWS, [faithful(RESOLV_ROWS, 'debian12'), through]);
    assert.deepEqual(verified.problems, []);
    const recorded = verified.recordings.filter((r) => r.image === 'ubuntu2404');
    assert.ok(recorded.length > 0 && recorded.every((r) => r.upstream === up));
    assert.ok(verified.recordings.every((r) => r.image === 'ubuntu2404' || !('upstream' in r)));
  });

  it('fails a run of other rows, or of another build of the policy: a run kept from before a change', () => {
    const runs = [faithful(RESOLV_ROWS, 'debian12'), faithful(RESOLV_ROWS, 'ubuntu2404')];
    assert.deepEqual(verifyAt(RESOLV_ROWS, runs, { ...CURRENT, rowsDigest: 'r1' }).problems, [
      'debian12: replayed rows r0, the rows file is r1',
      'ubuntu2404: replayed rows r0, the rows file is r1',
    ]);
    assert.deepEqual(verifyAt(RESOLV_ROWS, runs, { ...CURRENT, policyDigest: 'p1' }).problems, [
      'debian12: loaded the policy build p0, the build is p1',
      'ubuntu2404: loaded the policy build p0, the build is p1',
    ]);
    // A run from before runs said what they ran.
    const [first, second] = runs;
    assert.ok(first !== undefined && second !== undefined);
    const unsaid: Record<string, unknown> = { ...first };
    delete unsaid['rowsDigest'];
    delete unsaid['policyDigest'];
    assert.deepEqual(verify(RESOLV_ROWS, [unsaid as unknown as ImageRun, second]).problems, [
      'debian12: replayed rows undefined, the rows file is r0',
      'debian12: loaded the policy build undefined, the build is p0',
    ]);
  });

  it('fails a row played that the rows do not replay in that image, or that is no row', () => {
    const good = faithful(RESOLV_ROWS, 'debian12');
    const other = faithful(RESOLV_ROWS, 'ubuntu2404');
    const offThere = other.rows.find((row) => row.id === 'bbbbbbbbbbbbbbbb');
    assert.ok(offThere !== undefined);
    assert.deepEqual(
      verify(RESOLV_ROWS, [{ ...good, rows: [...good.rows, offThere] }, other]).problems,
      ['debian12, row bbbbbbbbbbbbbbbb (a walked name): played, and not replayed there'],
    );
    const stray = { ...offThere, id: 'cccccccccccccccc' };
    assert.deepEqual(
      verify(RESOLV_ROWS, [{ ...good, rows: [...good.rows, stray] }, other]).problems,
      ['debian12, row cccccccccccccccc: played, and is no row'],
    );
  });

  it('fails an image whose stub rows go through systemd-resolved where the run did not see it', () => {
    const good = faithful(RESOLV_ROWS, 'debian12');
    const other = faithful(RESOLV_ROWS, 'ubuntu2404');
    assert.deepEqual(verify(RESOLV_ROWS, [good, { ...other, resolved: false }]).problems, [
      'ubuntu2404: systemd-resolved was not seen to serve the stub rows',
    ]);
    assert.deepEqual(verify(RESOLV_ROWS, [{ ...good, resolved: false }, other]).problems, []);
  });

  it('fails an image not run, run twice, or not one of the rows’, and a glibc not the one stated', () => {
    const good = faithful(RESOLV_ROWS, 'debian12');
    const other = faithful(RESOLV_ROWS, 'ubuntu2404');
    assert.deepEqual(verify(RESOLV_ROWS, [good]).problems, ['ubuntu2404: not run']);
    assert.deepEqual(verify(RESOLV_ROWS, [good, other, other]).problems, [
      'ubuntu2404: run 2 times',
    ]);
    assert.deepEqual(verify(RESOLV_ROWS, [good, other, { ...good, image: 'alpine' }]).problems, [
      'alpine is no image the rows are replayed in',
    ]);
    assert.deepEqual(
      verify(RESOLV_ROWS, [faithful(RESOLV_ROWS, 'debian12', '2.35'), other]).problems,
      ['debian12: runs glibc 2.35, the rows state 2.36'],
    );
  });

  it('fails a row not replayed, a plan not played or played extra, a world not set up, a misread', () => {
    const other = faithful(RESOLV_ROWS, 'ubuntu2404');
    const at = `debian12, row ${ROW.id} (${ROW.title})`;
    const changed = (change: (row: RowRun) => RowRun | undefined): string[] => {
      const good = faithful(RESOLV_ROWS, 'debian12');
      const rows = good.rows.map(change).filter((row) => row !== undefined);
      return verify(RESOLV_ROWS, [{ ...good, rows }, other]).problems;
    };
    assert.deepEqual(
      changed(() => undefined),
      [`${at}: not replayed`],
    );
    assert.deepEqual(
      changed((row) => ({ ...row, plans: row.plans.slice(1) })),
      [`${at}: plan nxdomain not played`],
    );
    assert.deepEqual(
      changed((row) => ({
        ...row,
        plans: [...row.plans, { plan: 'refused', wire: [], outcome: 'x', ms: 1 }],
      })),
      [`${at}: played refused, which the row has no plan for`],
    );
    const unset = changed((row) => ({ ...row, setup: ['could not set /etc/hosts up: EBUSY'] }));
    assert.deepEqual(unset, [`${at}: could not set /etc/hosts up: EBUSY`]);
    assert.deepEqual(
      changed((row) => ({ ...row, inImage: { class: 'off', off: 'nscd: running' } })),
      [`${at}: the check is off in the image: nscd: running`],
    );
    assert.match(
      changed((row) => ({
        ...row,
        plans: row.plans.map((p) => ({ ...p, wire: p.wire.slice(0, 1) })),
      })).join('\n'),
      /nxdomain: the policy expects .*\n.*answer: the policy expects/u,
    );
  });

  it('records nothing for a row whose world was not set up or which the policy misread', () => {
    const other = faithful(RESOLV_ROWS, 'ubuntu2404');
    const good = faithful(RESOLV_ROWS, 'debian12');
    const unset = { ...good, rows: good.rows.map((row) => ({ ...row, setup: ['no'] })) };
    const misread = {
      ...good,
      rows: good.rows.map((row) => ({ ...row, inImage: { ...row.inImage, rotate: true } })),
    };
    for (const run of [unset, misread]) {
      const verified = verify(RESOLV_ROWS, [run, other]);
      assert.equal(verified.counts['debian12']?.plans, 0);
      assert.ok(verified.recordings.every((r) => r.image !== 'debian12'));
    }
  });

  it('S4’s committed rows verify, every image and plan, against a glibc that did what they say', () => {
    const runs = Object.keys(ROWS.images).map((image) => faithful(ROWS, image));
    const verified = verify(ROWS, runs);
    assert.deepEqual(verified.problems, []);
    assert.ok(ROWS.rows.length >= 255, String(ROWS.rows.length));
    assert.deepEqual(ROWS.resolved, ['ubuntu2404']);
    // No committed row is one the replay cannot play: no IP literal, no stub beside another server.
    for (const row of ROWS.rows) {
      const resolv = row.world.files['/etc/resolv.conf'];
      const named = nameserversOf(resolv === undefined ? '' : (ROWS.texts[resolv] ?? ''));
      assert.equal(unplayable(row.question.name, named, true), undefined, row.title);
    }
    const plans = ROWS.rows.reduce((sum, row) => sum + row.expect.plans.length, 0);
    assert.ok(plans >= 400, String(plans));
    assert.equal(verified.counts['debian11']?.rows, ROWS.rows.length);
    // A row not replayed in an image (a name beginning with - at 2.28) owes it no run.
    const dash = ROWS.rows.find(
      (row) => row.question.name === '-dash' && row.question.family === 4,
    );
    assert.ok(dash !== undefined);
    const rocky8 = runs.find((run) => run.image === 'rocky8');
    assert.equal(
      rocky8?.rows.find((row) => row.id === dash.id),
      undefined,
    );
    assert.equal(verified.counts['rocky8']?.rows, ROWS.rows.length - 9);
    // A local row recorded with a question fails.
    const local = ROWS.rows.find((row) => row.expect.class === 'local');
    assert.ok(local !== undefined);
    const broken = runs.map((run) =>
      run.image !== 'debian12'
        ? run
        : {
            ...run,
            rows: run.rows.map((row) =>
              row.id !== local.id
                ? row
                : {
                    ...row,
                    plans: row.plans.map((p) => ({
                      ...p,
                      wire: [['10.0.0.53', local.question.name, 'A', 1] as Wire],
                    })),
                  },
            ),
          },
    );
    assert.equal(verify(ROWS, broken).problems.length, 1);
  });
});

describe('the differential: setting a world’s servers up', () => {
  it('writes a server as the policy does, an IPv4-mapped one in hex', () => {
    assert.equal(canonicalAddress('10.0.0.53'), '10.0.0.53');
    assert.equal(canonicalAddress('2001:DB8:0:0:0:0:0:1'), '2001:db8::1');
    assert.equal(canonicalAddress('::ffff:10.0.0.1'), '::ffff:a00:1');
    assert.equal(canonicalAddress('fe80::1%eth0'), undefined);
    assert.equal(canonicalAddress('10.1'), undefined);
  });

  it('names every server a resolv.conf names, past the 3 glibc asks, once each', () => {
    assert.deepEqual(
      nameserversOf(
        'nameserver 10.0.0.1\nnameserver 10.0.0.2\n# nameserver 10.0.0.9\nnameserver 10.0.0.3\n' +
          'nameserver 10.0.0.4\nnameserver 10.0.0.1\nnameserver\t::ffff:10.0.0.7 \n',
      ),
      ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4', '::ffff:a00:7'],
    );
    // Every server any row names is one a simulator can stand for.
    for (const row of ROWS.rows) {
      const id = row.world.files['/etc/resolv.conf'];
      const named = nameserversOf(id === undefined ? '' : (ROWS.texts[id] ?? ''));
      for (const server of row.world.addresses) assert.ok(named.includes(server), row.title);
    }
  });

  it('listens for an IPv4-mapped server on its IPv4 address, and for IPv6 on the address', () => {
    assert.deepEqual(listenerOf('10.0.0.53'), { v4: '10.0.0.53' });
    assert.deepEqual(listenerOf('::ffff:a00:1'), { v4: '10.0.0.1' });
    assert.deepEqual(listenerOf('::ffff:c000:2ff'), { v4: '192.0.2.255' });
    assert.deepEqual(listenerOf('2001:db8::1'), { v6: '2001:db8::1' });
    assert.deepEqual(listenerOf('::1'), { v6: '::1' });
  });
});

/** A pcap file of these packets, as tcpdump `-w` writes it on Linux's `lo` (Ethernet). */
function pcap(packets: readonly Buffer[], linkType = 1, header: Buffer = Buffer.alloc(14)): Buffer {
  const global = Buffer.alloc(24);
  global.writeUInt32LE(0xa1b2c3d4, 0);
  global.writeUInt16LE(2, 4);
  global.writeUInt16LE(4, 6);
  global.writeUInt32LE(262_144, 16);
  global.writeUInt32LE(linkType, 20);
  const records = packets.map((ip) => {
    const frame = Buffer.concat([header, ip]);
    const record = Buffer.alloc(16);
    record.writeUInt32LE(frame.length, 8);
    record.writeUInt32LE(frame.length, 12);
    return Buffer.concat([record, frame]);
  });
  return Buffer.concat([global, ...records]);
}

function dnsMessage(name: string, type: number, response = false): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x1234, 0);
  header.writeUInt16BE(response ? 0x8180 : 0x0100, 2);
  header.writeUInt16BE(1, 4);
  const labels = name
    .split('.')
    .filter((label) => label !== '')
    .map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)]));
  const tail = Buffer.alloc(5);
  tail.writeUInt16BE(type, 1);
  tail.writeUInt16BE(1, 3);
  return Buffer.concat([header, ...labels, tail]);
}

function udp(dstPort: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt16BE(40_000, 0);
  header.writeUInt16BE(dstPort, 2);
  header.writeUInt16BE(8 + payload.length, 4);
  return Buffer.concat([header, payload]);
}

function ipv4(dst: readonly number[], payload: Buffer, protocol = 17): Buffer {
  const header = Buffer.alloc(20);
  header[0] = 0x45;
  header[9] = protocol;
  Buffer.from([127, 0, 0, 1]).copy(header, 12);
  Buffer.from(dst).copy(header, 16);
  return Buffer.concat([header, payload]);
}

function ipv6(dst: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(40);
  header[0] = 0x60;
  header[6] = 17;
  const groups = dst.split(':');
  for (let k = 0; k < 8; k += 1)
    header.writeUInt16BE(Number.parseInt(groups[k] ?? '0', 16), 24 + 2 * k);
  return Buffer.concat([header, payload]);
}

describe('the differential: what glibc sent the stub, read off a capture', () => {
  it('reads each question to port 53, and nothing else', () => {
    const stub = [127, 0, 0, 53];
    const file = pcap([
      ipv4(stub, udp(53, dnsMessage('sw1', 1))),
      ipv4(stub, udp(53, dnsMessage('sw1', 28))),
      ipv4(stub, udp(53, dnsMessage('sw1', 1, true))),
      ipv4(stub, udp(5353, dnsMessage('sw1', 1))),
      ipv4(stub, udp(53, dnsMessage('sw1', 1)), 6),
      ipv4(stub, udp(53, dnsMessage('sw1.corp.example', 65))),
      ipv6('2001:db8:0:0:0:0:0:1', udp(53, dnsMessage('sw2', 28))),
    ]);
    assert.deepEqual(pcapQuestions(file), [
      { server: '127.0.0.53', qname: 'sw1', qtype: 'A', transport: 'udp' },
      { server: '127.0.0.53', qname: 'sw1', qtype: 'AAAA', transport: 'udp' },
      { server: '127.0.0.53', qname: 'sw1.corp.example', qtype: 'TYPE65', transport: 'udp' },
      { server: '2001:db8::1', qname: 'sw2', qtype: 'AAAA', transport: 'udp' },
    ]);
  });

  it('reads Linux cooked captures and raw IP too, and refuses a file that is not pcap', () => {
    const packet = ipv4([127, 0, 0, 53], udp(53, dnsMessage('sw1', 1)));
    const want = [{ server: '127.0.0.53', qname: 'sw1', qtype: 'A', transport: 'udp' }];
    assert.deepEqual(pcapQuestions(pcap([packet], 113, Buffer.alloc(16))), want);
    assert.deepEqual(pcapQuestions(pcap([packet], 276, Buffer.alloc(20))), want);
    assert.deepEqual(pcapQuestions(pcap([packet], 101, Buffer.alloc(0))), want);
    assert.deepEqual(pcapQuestions(pcap([packet], 147)), []);
    assert.throws(() => pcapQuestions(Buffer.alloc(40, 1)), /not a pcap file/u);
  });
});

describe('the differential: through systemd-resolved, and rows it cannot play', () => {
  const up: Wire[] = [['127.0.0.2', 'sw1', 'A', 1]];
  const plan = (wire: Wire[], upstream?: Wire[]): PlanRun => ({
    plan: 'nxdomain',
    wire,
    outcome: 'x',
    ms: 1,
    ...(upstream === undefined ? {} : { upstream }),
  });
  const rowOf = (...plans: PlanRun[]): RowRun => ({
    id: 'aaaaaaaaaaaaaaaa',
    inImage: classified(ONE),
    plans,
  });
  const toStub: Wire[] = [[STUB, 'sw1', 'A', 1]];
  const toServer: Wire[] = [['10.0.0.53', 'sw1', 'A', 1]];

  it('sees resolved serve the stub only where every plan that asked it went upstream', () => {
    assert.equal(resolvedObserved([rowOf(plan(toStub, up))]), true);
    assert.equal(resolvedObserved([rowOf(plan(toStub, up), plan(toStub, []))]), false);
    assert.equal(resolvedObserved([rowOf(plan(toStub))]), false, 'a simulator stood in for it');
    assert.equal(resolvedObserved([rowOf(plan(toServer))]), false, 'no plan asked the stub');
    assert.equal(resolvedObserved([]), false);
    // A plan that asked another server owes no upstream.
    assert.equal(resolvedObserved([rowOf(plan(toStub, up)), rowOf(plan(toServer))]), true);
  });

  it('will not play an IP literal, nor the stub beside another server through resolved', () => {
    assert.match(unplayable('192.0.2.1', ['10.0.0.53'], false) ?? '', /IP literal/u);
    assert.match(unplayable('2001:db8::1', ['10.0.0.53'], false) ?? '', /IP literal/u);
    // The inet_aton forms are no literal to Node: they reach glibc.
    for (const name of ['10.1', '0x7f.1', '1.2.3.256']) {
      assert.equal(unplayable(name, ['10.0.0.53'], false), undefined, name);
    }
    assert.equal(unplayable('sw1', [STUB], true), undefined);
    assert.match(
      unplayable('sw1', [STUB, '10.0.0.1'], true) ?? '',
      /the stub with another server \(127\.0\.0\.53, 10\.0\.0\.1\)/u,
    );
    assert.match(unplayable('sw1', ['10.0.0.1', STUB], true) ?? '', /order across them/u);
    // A simulator standing in for the stub logs it with the rest, in one order.
    assert.equal(unplayable('sw1', [STUB, '10.0.0.1'], false), undefined);
  });
});

const VERIFY = fileURLToPath(new URL('./differential/names-verify.js', import.meta.url));
const POLICY = fileURLToPath(new URL('../src/resolver/system-names.js', import.meta.url));

describe('the differential: the verdict over the files the runs left', () => {
  it('reads a run, and names a file that is none: empty, as a replay that stopped leaves it', () => {
    const run = faithful(RESOLV_ROWS, 'debian12');
    assert.deepEqual(parseRun('/out/debian12.json', JSON.stringify(run)), { run });
    for (const text of ['', '{"image":', 'null', '{}', '{"image":"debian12"}']) {
      const parsed = parseRun('/out/rocky8.json', text);
      assert.ok('problem' in parsed, text);
      assert.match(parsed.problem, /^\/out\/rocky8\.json: not an image's run/u);
    }
  });

  it('judges every run it can read, and fails the one it cannot, with the digests of what it judges by', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ms-names-verify-'));
    try {
      const rowsPath = join(dir, 'rows.json');
      writeFileSync(rowsPath, JSON.stringify(RESOLV_ROWS));
      const current: Current = {
        rowsDigest: digestOf(readFileSync(rowsPath)),
        policyDigest: digestOf(readFileSync(POLICY)),
      };
      const runOf = (image: string): ImageRun => ({ ...faithful(RESOLV_ROWS, image), ...current });
      const debian = join(dir, 'debian12.json');
      const ubuntu = join(dir, 'ubuntu2404.json');
      writeFileSync(debian, JSON.stringify(runOf('debian12')));
      const verdict = (...runs: string[]): ReturnType<typeof spawnSync> =>
        spawnSync(process.execPath, [VERIFY, rowsPath, ...runs], {
          encoding: 'utf8',
          timeout: 30_000,
        });
      writeFileSync(ubuntu, '');
      const stopped = verdict(debian, ubuntu);
      assert.equal(stopped.status, 1, String(stopped.stderr));
      assert.equal(stopped.stdout, '');
      const said = String(stopped.stderr);
      assert.match(said, /^debian12: 1 rows, 2 plans recorded$/mu);
      assert.match(said, /^DISAGREES .*ubuntu2404\.json: not an image's run/mu);
      assert.match(said, /^DISAGREES ubuntu2404: not run$/mu);
      writeFileSync(ubuntu, JSON.stringify(runOf('ubuntu2404')));
      const passed = verdict(debian, ubuntu);
      assert.equal(passed.status, 0, String(passed.stderr));
      const file = JSON.parse(String(passed.stdout)) as {
        schema: number;
        images: Record<string, { rowsDigest: string; policyDigest: string }>;
      };
      assert.equal(file.schema, 2);
      const recorded = file.images['debian12'];
      assert.ok(recorded !== undefined);
      assert.equal(recorded.rowsDigest, current.rowsDigest);
      assert.equal(recorded.policyDigest, current.policyDigest);
      // A run of the rows as they were before a change.
      writeFileSync(ubuntu, JSON.stringify({ ...runOf('ubuntu2404'), rowsDigest: 'f'.repeat(64) }));
      const stale = verdict(debian, ubuntu);
      assert.equal(stale.status, 1);
      assert.match(
        String(stale.stderr),
        /^DISAGREES ubuntu2404: replayed rows f{64}, the rows file is /mu,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the differential: a capture’s process, every wait on it bounded', () => {
  const node = (script: string, stopBoundMs = 2_000): CaptureOptions => ({
    command: process.execPath,
    argv: ['-e', script],
    ready: 'listening on',
    startBoundMs: 10_000,
    stopBoundMs,
    settleMs: 10,
  });
  const LISTENS = "process.stderr.write('listening on lo\\n');";

  it('stops a capture with SIGINT once it is listening', async () => {
    const capture = await within(
      15_000,
      'the capture to start',
      startCapture(
        node(
          `process.on('SIGINT', () => process.exit(0)); ${LISTENS} setTimeout(() => process.exit(0), 8000);`,
        ),
      ),
    );
    await within(5_000, 'the capture to stop', capture.stop());
  });

  it('says at once that a capture ended on its own, rather than wait for an exit already past', async () => {
    const capture = await within(
      15_000,
      'the capture to start',
      startCapture(node(`${LISTENS} setTimeout(() => {}, 20);`)),
    );
    await sleep(500);
    await assert.rejects(
      within(5_000, 'stop to answer', capture.stop()),
      /ended before it was stopped: listening on lo/u,
    );
  });

  it('fails a capture that ends before it listens, and one that will not stop', async () => {
    await assert.rejects(
      within(15_000, 'the start to fail', startCapture(node('process.exit(3);'))),
      /exited before it was ready/u,
    );
    const stubborn = await within(
      15_000,
      'the capture to start',
      startCapture(
        node(
          `process.on('SIGINT', () => {}); ${LISTENS} setTimeout(() => process.exit(0), 8000);`,
          300,
        ),
      ),
    );
    await assert.rejects(
      within(5_000, 'stop to give up', stubborn.stop()),
      /timed out after 300 ms waiting for .* to stop/u,
    );
  });
});

const LIB = fileURLToPath(new URL('../../../../scripts/lib/names-diff.sh', import.meta.url));
const RECORDINGS = fileURLToPath(
  new URL('../../test/fixtures/system-names-recordings.json', import.meta.url),
);

function bash(script: string, ...args: string[]): { status: number | null; stdout: string } {
  const result = spawnSync('bash', ['-c', `. "$0"; ${script}`, LIB, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout };
}

describe('the differential’s script: the build the boxes load, and the bases they are built on', () => {
  it('refuses a source newer than its build, or not built, in every package the boxes load', () => {
    const root = mkdtempSync(join(tmpdir(), 'ms-names-stale-'));
    try {
      let clock = Date.now();
      const tick = (): Date => new Date((clock += 60_000));
      const old = new Date('2026-10-01T00:00:00Z');
      const put = (path: string, when: Date): void => {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), '');
        utimesSync(join(root, path), when, when);
      };
      const pairs = [
        ['probe', 'src/resolver/system-names'],
        ['probe', 'test/differential/names-replay'],
        ['probe', 'test/support/within'],
        ['simulators', 'src/dns-server'],
        ['sensors', 'src/support/system-lookup'],
        ['shared', 'src/index'],
      ] as const;
      for (const [pkg, file] of pairs) {
        put(`packages/${pkg}/${file}.ts`, old);
        put(`packages/${pkg}/dist/${file}.js`, old);
      }
      put('packages/probe/src/types.d.ts', tick());
      const stale = (): { status: number | null; stdout: string } =>
        bash('ms_names_diff_stale "$1"', root);
      assert.deepEqual(stale(), { status: 0, stdout: '' });
      for (const [pkg, file] of pairs) {
        const src = `packages/${pkg}/${file}.ts`;
        const js = `packages/${pkg}/dist/${file}.js`;
        const when = tick();
        utimesSync(join(root, src), when, when);
        assert.deepEqual(stale(), { status: 1, stdout: `${src}\n` }, `${src} edited`);
        // A build that found its text unchanged emits nothing and records that it has seen it.
        put(`packages/${pkg}/dist/tsconfig.tsbuildinfo`, tick());
        assert.deepEqual(stale(), { status: 0, stdout: '' }, `${src} seen by a build`);
        rmSync(join(root, js));
        assert.deepEqual(stale(), { status: 1, stdout: `${src}\n` }, `${js} missing`);
        put(js, tick());
        assert.deepEqual(stale(), { status: 0, stdout: '' }, `${src} built again`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads each image’s recorded digest, and none for another base, image or file', () => {
    const recorded = JSON.parse(readFileSync(RECORDINGS, 'utf8')) as {
      images: Record<string, { base: string; digest: string }>;
    };
    assert.ok(Object.keys(recorded.images).length >= 7);
    for (const [image, { base, digest }] of Object.entries(recorded.images)) {
      assert.match(digest, /^[a-z]+@sha256:[0-9a-f]{64}$/u, image);
      const read = bash('ms_names_diff_recorded "$1" "$2" "$3"', RECORDINGS, image, base);
      assert.deepEqual(read, { status: 0, stdout: `${digest}\n` }, image);
      const moved = bash('ms_names_diff_recorded "$1" "$2" "$3"', RECORDINGS, image, `${base}x`);
      assert.deepEqual(moved, { status: 0, stdout: '' }, `${image} from another base`);
    }
    const none = { status: 0, stdout: '' };
    assert.deepEqual(bash('ms_names_diff_recorded "$1" alpine alpine:3', RECORDINGS), none);
    assert.deepEqual(bash('ms_names_diff_recorded /nowhere.json debian12 debian:bookworm'), none);
  });
});

describe('the differential: a simulator server as a row’s nameserver', () => {
  it('answers a question as the plan says now, though a plan before left it silent', async () => {
    const sim = await within(
      15_000,
      'the DNS simulator to bind',
      DnsSimulator.start({ servers: [{ ...NAMESERVER, name: 'ns' }], ipv6: false }),
    );
    try {
      const ask = (): ReturnType<typeof dnsQuery> =>
        dnsQuery(sim.target('ns'), 'sw1', 'A', { timeoutMs: 1_000, avoid: sim.ports });
      await sim.set({ fallback: true }, { reply: replies.silent }, 'ns');
      assert.equal((await within(5_000, 'the silent question', ask())).kind, 'timeout');
      // The next plan: the same question, answered, as glibc's next lookup asks it.
      await sim.set({ fallback: true }, { reply: replies.addresses('192.0.2.53') }, 'ns');
      const answered = await within(5_000, 'the answered question', ask());
      assert.equal(answered.kind, 'reply', JSON.stringify(answered));
    } finally {
      await sim.stop();
    }
  });
});
