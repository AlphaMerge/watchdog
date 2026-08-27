import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { createSocket, type Socket } from 'node:dgram';
import { dnsBlocklist, reverseIpv4 } from '../src/types/dns-blocklist.js';
import type { CheckContext, CheckExecution } from '../src/contract.js';

/**
 * The worked example from `docs/adding-a-sensor-type.md`, tested the way that guide says to.
 *
 * The simulator is forty lines of `node:dgram` answering DNS by hand, because the alternative is
 * querying a real blocklist — which CLAUDE.md forbids, and which would also mean a test that
 * fails when Spamhaus rate-limits the machine it runs on.
 */

let server: Socket;
let port = 0;
/** Zones that answer "listed", and the address they answer with. */
const listed = new Map<string, string>([['bad.example.invalid', '127.0.0.2']]);
/** Zones that answer nothing at all, for the "could not be queried" case. */
const silent = new Set(['silent.example.invalid']);
/** A zone that does not exist — the typo case, which NXDOMAIN alone cannot tell from "clean". */
const missing = new Set(['typo.example.invalid']);

before(async () => {
  server = createSocket('udp4');
  server.on('message', (query, sender) => {
    const name = readName(query);
    const zone = zoneOf(name);
    if (silent.has(zone)) return;

    // An SOA query is the zone-existence check: the name asked about *is* the zone.
    if (readType(query) === 6) {
      server.send(missing.has(name) ? nxdomain(query) : soa(query), sender.port, sender.address);
      return;
    }

    const answer = listed.get(zone);
    server.send(
      answer === undefined ? nxdomain(query) : withAnswer(query, answer),
      sender.port,
      sender.address,
    );
  });
  await new Promise<void>((resolve) => {
    server.bind(0, '127.0.0.1', () => {
      const address = server.address();
      port = typeof address === 'object' ? address.port : 0;
      resolve();
    });
  });
});

after(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

/** The QNAME of a DNS query, as dotted labels. */
function readName(query: Buffer): string {
  const labels: string[] = [];
  let at = 12;
  for (;;) {
    const length = query[at] ?? 0;
    if (length === 0) break;
    labels.push(query.toString('utf8', at + 1, at + 1 + length));
    at += 1 + length;
  }
  return labels.join('.');
}

/** `42.2.0.192.bad.example.invalid` -> `bad.example.invalid`: everything past the four octets. */
function zoneOf(name: string): string {
  return name.split('.').slice(4).join('.');
}

/** The QTYPE of a query: 1 is A, 6 is SOA. */
function readType(query: Buffer): number {
  let at = 12;
  while ((query[at] ?? 0) !== 0) at += 1 + (query[at] ?? 0);
  return query.readUInt16BE(at + 1);
}

function header(query: Buffer, rcode: number, answers: number): Buffer {
  const out = Buffer.alloc(12);
  query.copy(out, 0, 0, 12);
  // QR=1, RD copied from the query, RA=1, and the response code in the low nibble.
  out.writeUInt16BE(0x8180 | rcode, 2);
  out.writeUInt16BE(answers, 6);
  return out;
}

function questionOf(query: Buffer): Buffer {
  let at = 12;
  while ((query[at] ?? 0) !== 0) at += 1 + (query[at] ?? 0);
  return query.subarray(12, at + 5);
}

function nxdomain(query: Buffer): Buffer {
  return Buffer.concat([header(query, 3, 0), questionOf(query)]);
}

/** The smallest SOA that `node:dns` will parse: two compressed names and five 32-bit fields. */
function soa(query: Buffer): Buffer {
  const question = questionOf(query);
  const rdata = Buffer.concat([Buffer.from([0xc0, 0x0c, 0xc0, 0x0c]), Buffer.alloc(20)]);
  const record = Buffer.alloc(12);
  record.writeUInt16BE(0xc00c, 0);
  record.writeUInt16BE(6, 2);
  record.writeUInt16BE(1, 4);
  record.writeUInt32BE(60, 6);
  record.writeUInt16BE(rdata.length, 10);
  return Buffer.concat([header(query, 0, 1), question, record, rdata]);
}

function withAnswer(query: Buffer, address: string): Buffer {
  const question = questionOf(query);
  const record = Buffer.alloc(16);
  // A compression pointer to the question's name at offset 12, then A / IN / TTL / RDLENGTH.
  record.writeUInt16BE(0xc00c, 0);
  record.writeUInt16BE(1, 2);
  record.writeUInt16BE(1, 4);
  record.writeUInt32BE(60, 6);
  record.writeUInt16BE(4, 10);
  for (const [index, octet] of address.split('.').entries()) {
    record.writeUInt8(Number(octet), 12 + index);
  }
  return Buffer.concat([header(query, 0, 1), question, record]);
}

function run(
  params: Record<string, unknown>,
  over: Partial<CheckContext> = {},
): Promise<CheckExecution> {
  return dnsBlocklist.execute({
    sensorId: 1,
    target: { host: '192.0.2.42', ipVersion: 'v4' },
    params: { resolver: `127.0.0.1:${String(port)}`, timeoutMs: 3_000, ...params },
    credentials: {},
    signal: new AbortController().signal,
    ...over,
  });
}

const valueOf = (execution: CheckExecution, key: string): number | undefined =>
  execution.channels.find((channel) => channel.key === key)?.value;

describe('reverseIpv4', () => {
  it('reverses the octets, which is how a DNSBL is asked', () => {
    // Getting this backwards produces a sensor that always answers "not listed".
    assert.equal(reverseIpv4('192.0.2.42'), '42.2.0.192');
    assert.equal(reverseIpv4(' 10.1.2.3 '), '3.2.1.10');
  });

  it('refuses anything that is not an IPv4 address', () => {
    for (const bad of ['example.com', '192.0.2', '192.0.2.256', '::1', '', '1.2.3.4.5']) {
      assert.equal(reverseIpv4(bad), null, bad);
    }
  });
});

describe('dns.blocklist', () => {
  it('reports zero listings as a reading, not as a healthy nothing', async () => {
    const execution = await run({ zones: ['clean.example.invalid', 'also-clean.example.invalid'] });
    assert.equal(valueOf(execution, 'listings'), 0);
    assert.equal(valueOf(execution, 'checked'), 2);
    assert.ok((valueOf(execution, 'lookupTime') ?? -1) >= 0);
    assert.match(execution.message ?? '', /192\.0\.2\.42 is on none of 2 blocklists/);
  });

  it('counts a listing and names the list and the code it answered with', async () => {
    // Which 127.0.0.x came back is what says *why* — 127.0.0.2 and 127.0.0.4 mean different
    // things on Spamhaus, and an operator needs the number to look it up.
    const execution = await run({ zones: ['clean.example.invalid', 'bad.example.invalid'] });
    assert.equal(valueOf(execution, 'listings'), 1);
    assert.match(execution.message ?? '', /listed on bad\.example\.invalid \(127\.0\.0\.2\)/);
  });

  it('leaves the verdict to a limit rather than going Down on its own', async () => {
    // A sensor that failed when listed would be a threshold baked into a file. The channel is
    // the primary, so an upper error limit of zero is what an operator sets.
    const execution = await run({ zones: ['bad.example.invalid'] });
    assert.equal(execution.channels.find((c) => c.key === 'listings')?.value, 1);
    assert.deepEqual(
      dnsBlocklist
        .channels({})
        .filter((c) => c.isPrimary === true)
        .map((c) => c.key),
      ['listings'],
    );
  });

  it('reports how many lists it could not reach, while still answering', async () => {
    // Timed, and the timing is the point: Node's resolver retries four times by default and its
    // `timeout` is per *try*, so without `tries: 1` a 700 ms deadline takes nearly three seconds.
    // A configured timeout that means a quarter of what it says is a timeout that means nothing.
    const started = Date.now();
    const execution = await run({
      zones: ['clean.example.invalid', 'silent.example.invalid'],
      timeoutMs: 700,
    });
    assert.equal(valueOf(execution, 'checked'), 1);
    assert.match(execution.message ?? '', /1 could not be queried/);
    assert.ok(
      Date.now() - started < 1_800,
      `it waited ${String(Date.now() - started)} ms for a 700 ms timeout, so it retried`,
    );
  });

  it('fails rather than reporting zero when it could reach none of them', async () => {
    // Reporting "we are on no lists" on the strength of no evidence is the worst answer here.
    await assert.rejects(
      () => run({ zones: ['silent.example.invalid'], timeoutMs: 700 }),
      /none of the 1 blocklists could be queried/,
    );
  });

  it('does not read a typo’d list name as “not listed”', async () => {
    // NXDOMAIN is the protocol's way of saying "not listed" *and* what a zone that does not
    // exist answers. Found live: two zones queried, one of them fictional, both counted clean.
    const execution = await run({
      zones: ['clean.example.invalid', 'typo.example.invalid'],
    });
    assert.equal(valueOf(execution, 'checked'), 1, 'the fictional zone was not counted as clean');
    assert.match(execution.message ?? '', /1 could not be queried/);
  });

  it('says why a device reached by name cannot be checked', async () => {
    await assert.rejects(
      () =>
        run(
          { zones: ['clean.example.invalid'] },
          { target: { host: 'mail.example.invalid', ipVersion: 'v4' } },
        ),
      /is not an IPv4 address, and a DNS blocklist is queried by reversing one/,
    );
  });

  it('checks the address it was given rather than the device’s, when told to', async () => {
    // The usual arrangement behind NAT: the address that sends mail is not the address the
    // device is reached on.
    const execution = await run({
      zones: ['clean.example.invalid'],
      address: '203.0.113.9',
    });
    assert.match(execution.message ?? '', /203\.0\.113\.9 is on none of/);
  });

  it('returns promptly when the check is cancelled', async () => {
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort();
    }, 50);
    const started = Date.now();
    await assert.rejects(
      () =>
        run(
          { zones: ['silent.example.invalid'], timeoutMs: 30_000 },
          { signal: controller.signal },
        ),
      /cancelled|ECANCELLED/i,
    );
    assert.ok(Date.now() - started < 5_000, 'it waited for the timeout instead of the signal');
  });
});
