import { strict as assert } from 'node:assert';
import { createSocket } from 'node:dgram';
import { Resolver } from 'node:dns/promises';
import { once } from 'node:events';
import { connect, createServer } from 'node:net';
import { describe, it, type TestContext } from 'node:test';
import {
  DnsClient,
  DnsSimulator,
  dnsQuery,
  replies,
  type DnsQueryRecord,
  type DnsQueryResult,
  type DnsSimulatorOptions,
} from '../src/dns-server.js';
import { encodeQuery, frame, typeCode } from '../src/dns-wire.js';
import { avoidingPorts } from '../src/net.js';
import { pollWithin, within } from './support/within.js';

/**
 * The DNS simulator's own tests (`P-432` S5): every behaviour the gate's tests (§7.2–§7.6) ask
 * of it, over real sockets on loopback.
 *
 * **Outcomes, not durations.** A reply that should come is waited for with a bound far past any
 * delay a case sets; silence is read from the server's own query log and its held questions,
 * which say the server decided not to answer, rather than from a client timing out. Everything
 * the simulator decides by time runs on its manual clock here, moved by the test, and a question
 * that must wait is `held` until the test answers it, not delayed for a while (F3).
 */

const ZONE_A = '192.0.2.10';
const ZONE_A_V6 = '2001:db8::10';
const ANSWER_BOUND_MS = 5_000;

async function start(t: TestContext, options: DnsSimulatorOptions = {}): Promise<DnsSimulator> {
  const sim = await within(15_000, 'the DNS simulator to bind', DnsSimulator.start(options));
  t.after(() => sim.stop());
  return sim;
}

function replied(result: DnsQueryResult): Extract<DnsQueryResult, { kind: 'reply' }> {
  if (result.kind !== 'reply') return assert.fail(`no reply: ${JSON.stringify(result)}`);
  return result;
}

const ask = (
  sim: DnsSimulator,
  name: string,
  type = 'A',
  options: Parameters<typeof dnsQuery>[3] = {},
): Promise<DnsQueryResult> =>
  dnsQuery(sim.target(), name, type, { timeoutMs: ANSWER_BOUND_MS, avoid: sim.ports, ...options });

/**
 * The reply `client` holds already for `id`, else `timeout`: no turn of the event loop is waited
 * for, so a reply still on its way is not one.
 */
const inHand = (client: DnsClient, id: number): Promise<DnsQueryResult> =>
  Promise.race([client.reply(id, 0), Promise.resolve<DnsQueryResult>({ kind: 'timeout' })]);

/** One turn of the event loop. From the check phase it runs one poll phase, and only one. */
const turn = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

/** The latest log entry `match` accepts, once the worker has logged one. */
async function logged(
  sim: DnsSimulator,
  match: (entry: DnsQueryRecord) => boolean,
  what: string,
): Promise<DnsQueryRecord> {
  let found: DnsQueryRecord | undefined;
  await pollWithin(ANSWER_BOUND_MS, what, async () => {
    found = (await sim.log()).filter(match).at(-1);
    return found !== undefined;
  });
  return found ?? assert.fail(what);
}

const named =
  (qname: string, qtype = 'A') =>
  (entry: DnsQueryRecord) =>
    entry.qname === qname && entry.qtype === qtype;

/** Whether a UDP socket can bind `address:port`: false on EADDRINUSE. */
function udpFree(type: 'udp4' | 'udp6', address: string, port: number): Promise<boolean> {
  const socket = createSocket({ type, ipv6Only: type === 'udp6' });
  return new Promise((resolve) => {
    socket.once('error', () => {
      resolve(false);
    });
    socket.bind({ port, address, exclusive: true }, () => {
      socket.close(() => {
        resolve(true);
      });
    });
  });
}

/** Whether this machine has an IPv6 loopback at all, asked once and apart from the simulator. */
const v6Here = await udpFree('udp6', '::1', 0);

function tcpFree(host: string, port: number): Promise<boolean> {
  const server = createServer();
  return new Promise((resolve) => {
    server.once('error', () => {
      resolve(false);
    });
    server.listen({ host, port, exclusive: true }, () => {
      server.close(() => {
        resolve(true);
      });
    });
  });
}

describe('the DNS simulator', () => {
  describe('its sockets', () => {
    it('holds one port on 127.0.0.1 and ::1, UDP and TCP, and answers on each (P-442)', async (t) => {
      const sim = await start(t, {
        zones: { 'zone-a.test': { reply: replies.addresses(ZONE_A) } },
      });
      const { port, ipv6 } = sim.server();
      assert.ok(port > 0);
      assert.equal(await udpFree('udp4', '127.0.0.1', port), false);
      assert.equal(await tcpFree('127.0.0.1', port), false);
      assert.deepEqual(replied(await ask(sim, 'dev-1.zone-a.test')).addresses, [ZONE_A]);
      const tcp = replied(await ask(sim, 'dev-1.zone-a.test', 'A', { transport: 'tcp' }));
      assert.equal(tcp.transport, 'tcp');
      if (!v6Here) {
        assert.equal(ipv6, undefined);
        t.diagnostic('this machine has no ::1: the server bound 127.0.0.1 alone');
        return;
      }
      // The machine has ::1, so the server must hold it: a quiet fallback is the bug P-442 found.
      assert.equal(ipv6, '::1');
      assert.equal(await udpFree('udp6', '::1', port), false);
      assert.equal(await tcpFree('::1', port), false);
      const v6 = { ...sim.target(undefined, 6) };
      assert.deepEqual(
        replied(await dnsQuery(v6, 'dev-2.zone-a.test', 'A', { timeoutMs: ANSWER_BOUND_MS }))
          .addresses,
        [ZONE_A],
      );
      const overTcp = await dnsQuery(v6, 'dev-3.zone-a.test', 'A', {
        transport: 'tcp',
        timeoutMs: ANSWER_BOUND_MS,
      });
      assert.equal(replied(overTcp).transport, 'tcp');
      const entry = await logged(sim, named('dev-2.zone-a.test'), 'the ::1 query in the log');
      assert.equal(entry.family, 6);
      assert.deepEqual(sim.serverList(undefined, 6), [`[::1]:${String(port)}`]);
    });

    it('binds another loopback and a fixed port when a row needs them', async (t) => {
      const first = await start(t);
      // A fixed port something holds fails, naming it, rather than quietly moving.
      await assert.rejects(
        DnsSimulator.start({ servers: [{ name: 'ns1', port: first.server().port }] }),
        /EADDRINUSE/u,
      );
      let sim: DnsSimulator;
      try {
        sim = await within(
          15_000,
          'the DNS simulator on 127.0.0.2',
          DnsSimulator.start({
            servers: [{ name: 'upstream', address: '127.0.0.2' }],
            zones: { 'zone-a.test': { reply: replies.addresses(ZONE_A) } },
          }),
        );
      } catch (error) {
        if (!/EADDRNOTAVAIL/u.test(String(error))) throw error;
        t.skip('127.0.0.2 is not on this machine’s loopback');
        return;
      }
      t.after(() => sim.stop());
      const { ipv4, port } = sim.server();
      assert.equal(ipv4, '127.0.0.2');
      assert.deepEqual(sim.serverList(), [`127.0.0.2:${String(port)}`]);
      assert.equal(await udpFree('udp4', '127.0.0.2', port), false);
      assert.deepEqual(replied(await ask(sim, 'dev-1.zone-a.test')).addresses, [ZONE_A]);
    });

    it('closes every socket at stop', async () => {
      const sim = await within(15_000, 'the DNS simulator to bind', DnsSimulator.start());
      const { port } = sim.server();
      await sim.stop();
      await sim.stop();
      assert.equal(await udpFree('udp4', '127.0.0.1', port), true);
      assert.equal(await tcpFree('127.0.0.1', port), true);
      await assert.rejects(sim.log(), /stopped/u);
    });
  });

  describe('what a name is answered with', () => {
    it('answers A with the IPv4 addresses, AAAA with the IPv6 ones, NODATA otherwise', async (t) => {
      const sim = await start(t, {
        names: { 'dual.zone-a.test': { reply: replies.addresses(ZONE_A, ZONE_A_V6), ttl: 120 } },
      });
      const a = replied(await ask(sim, 'DUAL.Zone-A.test.'));
      assert.equal(a.rcode, 'NOERROR');
      assert.deepEqual(a.addresses, [ZONE_A]);
      assert.equal(a.answers[0]?.ttl, 120);
      // The question comes back as it was asked: c-ares compares the two.
      assert.equal(a.message.questions[0]?.name, 'DUAL.Zone-A.test');
      assert.deepEqual(replied(await ask(sim, 'dual.zone-a.test', 'AAAA')).addresses, [ZONE_A_V6]);
      const mx = replied(await ask(sim, 'dual.zone-a.test', 'MX'));
      assert.equal(mx.rcode, 'NOERROR');
      assert.equal(mx.answers.length, 0);
      assert.equal(replied(await ask(sim, 'nowhere.test')).rcode, 'NXDOMAIN');
    });

    it('takes a name before its zone, the longest zone first, a server’s layer first', async (t) => {
      const sim = await start(t, {
        zones: {
          'zone-a.test': { reply: replies.addresses('192.0.2.1') },
          'sub.zone-a.test': { reply: replies.addresses('192.0.2.2') },
        },
        names: { 'x.sub.zone-a.test': { reply: replies.nxdomain } },
        fallback: { reply: replies.refused },
        servers: [
          { name: 'ns1' },
          { name: 'ns2', zones: { 'zone-a.test': { reply: replies.servfail } } },
        ],
      });
      const on = async (server: string, name: string): Promise<string> => {
        const result = replied(
          await dnsQuery(sim.target(server), name, 'A', { timeoutMs: ANSWER_BOUND_MS }),
        );
        return result.rcode === 'NOERROR' ? (result.addresses[0] ?? 'NODATA') : result.rcode;
      };
      assert.equal(await on('ns1', 'zone-a.test'), '192.0.2.1');
      assert.equal(await on('ns1', 'y.zone-a.test'), '192.0.2.1');
      assert.equal(await on('ns1', 'y.sub.zone-a.test'), '192.0.2.2');
      assert.equal(await on('ns1', 'x.sub.zone-a.test'), 'NXDOMAIN');
      assert.equal(await on('ns1', 'elsewhere.test'), 'REFUSED');
      assert.equal(await on('ns2', 'y.zone-a.test'), 'SERVFAIL');
      assert.equal(await on('ns2', 'y.sub.zone-a.test'), '192.0.2.2');

      await sim.silence('sub.zone-a.test', 'ns1');
      await sim.set({ name: 'x.sub.zone-a.test' }, undefined);
      await sim.set({ fallback: true }, { reply: replies.addresses('192.0.2.9') });
      assert.equal(await on('ns1', 'elsewhere.test'), '192.0.2.9');
      const silent = await dnsQuery(sim.target('ns1'), 'x.sub.zone-a.test', 'A', {
        timeoutMs: 200,
      });
      assert.equal(silent.kind, 'timeout');
      assert.equal(await on('ns2', 'x.sub.zone-a.test'), '192.0.2.2');
    });

    it('answers SERVFAIL, REFUSED, NOTIMP and FORMERR, and A beside an AAAA SERVFAIL', async (t) => {
      const sim = await start(t, {
        names: {
          'servfail.test': { reply: replies.servfail },
          'refused.test': { reply: replies.refused },
          'notimp.test': { reply: replies.notimp },
          'formerr.test': { reply: replies.formerr },
          'split.test': { reply: replies.addresses(ZONE_A, ZONE_A_V6), aaaa: replies.servfail },
        },
      });
      for (const rcode of ['SERVFAIL', 'REFUSED', 'NOTIMP', 'FORMERR']) {
        const result = replied(await ask(sim, `${rcode.toLowerCase()}.test`));
        assert.equal(result.rcode, rcode);
        assert.equal(result.answers.length, 0);
      }
      assert.deepEqual(replied(await ask(sim, 'split.test', 'A')).addresses, [ZONE_A]);
      assert.equal(replied(await ask(sim, 'split.test', 'AAAA')).rcode, 'SERVFAIL');
    });

    it('holds a reply for its delay, and never answers a silent name', async (t) => {
      const sim = await start(t, {
        zones: {
          'slow.test': { reply: replies.addresses(ZONE_A), delayMs: 150 },
          'zone-b.test': { reply: replies.silent },
        },
        names: {
          'late-fail.slow.test': { reply: { kind: 'rcode', rcode: 'SERVFAIL', delayMs: 60 } },
        },
      });
      assert.deepEqual(replied(await ask(sim, 'dev-1.slow.test')).addresses, [ZONE_A]);
      const slow = await logged(sim, named('dev-1.slow.test'), 'the slow reply');
      assert.ok(
        (slow.reply?.afterMs ?? 0) >= 148,
        `replied after ${String(slow.reply?.afterMs)} ms`,
      );
      assert.equal(replied(await ask(sim, 'late-fail.slow.test')).rcode, 'SERVFAIL');
      const fail = await logged(sim, named('late-fail.slow.test'), 'the late SERVFAIL');
      assert.ok((fail.reply?.afterMs ?? 0) >= 58, 'a reply’s own delay is used');

      const client = await sim.openClient();
      t.after(() => client.close());
      await client.send(sim.target(), 'dev-4.zone-b.test', 'A', { id: 4 });
      const silent = await logged(sim, named('dev-4.zone-b.test'), 'the silent question');
      assert.equal(silent.outcome, 'forwarded');
      assert.equal(silent.reply, undefined);
      assert.deepEqual(
        (await sim.held()).map((held) => held.qname),
        ['dev-4.zone-b.test'],
      );
    });

    it('loses the first datagrams of a question and answers the resend', async (t) => {
      const sim = await start(t, {
        names: { 'lossy.test': { reply: replies.addresses(ZONE_A), dropFirst: 1 } },
      });
      const client = await sim.openClient();
      t.after(() => client.close());
      await client.send(sim.target(), 'lossy.test', 'A', { id: 7 });
      await logged(sim, (entry) => entry.outcome === 'lost', 'the lost datagram');
      // glibc resends with the same ID; the first is gone, so the resend is a new forward.
      const resent = replied(await client.ask(sim.target(), 'lossy.test', 'A', { id: 7 }));
      assert.deepEqual(resent.addresses, [ZONE_A]);
      assert.deepEqual(
        (await sim.log()).map((entry) => entry.outcome),
        ['lost', 'forwarded'],
      );
    });

    it('starts a dropFirst count again only for the name or zone a set changes (F5)', async (t) => {
      const sim = await start(t, {
        zones: { 'zone-a.test': { reply: replies.addresses(ZONE_A), dropFirst: 1 } },
      });
      const client = await sim.openClient();
      t.after(() => client.close());
      await client.send(sim.target(), 'x.zone-a.test', 'A', { id: 1 });
      await logged(sim, (entry) => entry.outcome === 'lost', 'the lost datagram');
      // An outage starts in another zone before the resend: the resend is not lost again.
      await sim.silence('zone-b.test');
      await sim.set({ name: 'y.zone-a.test' }, { reply: replies.nxdomain });
      const resent = client.ask(sim.target(), 'x.zone-a.test', 'A', {
        id: 1,
        timeoutMs: ANSWER_BOUND_MS,
      });
      assert.deepEqual(replied(await resent).addresses, [ZONE_A]);
      // A set on its own zone starts its count again.
      await sim.set({ zone: 'zone-a.test' }, { reply: replies.addresses(ZONE_A), dropFirst: 1 });
      await client.send(sim.target(), 'x.zone-a.test', 'A', { id: 2 });
      await logged(sim, (entry) => entry.id === 2, 'the datagram after the set');
      assert.deepEqual(
        (await sim.log()).map((entry) => entry.outcome),
        ['lost', 'forwarded', 'lost'],
      );
    });

    it('drops or refuses a query carrying OPT, and answers OPT with OPT', async (t) => {
      const sim = await start(t, {
        names: {
          'deaf.test': { reply: replies.addresses(ZONE_A), onOpt: 'drop' },
          'old.test': { reply: replies.addresses(ZONE_A), onOpt: 'formerr' },
          'edns.test': { reply: replies.addresses(ZONE_A) },
        },
      });
      const client = await sim.openClient();
      t.after(() => client.close());
      await client.send(sim.target(), 'deaf.test', 'A', { id: 11, opt: true });
      const deaf = await logged(sim, named('deaf.test'), 'the OPT query to the deaf path');
      assert.equal(deaf.opt, true);
      assert.equal(deaf.outcome, 'ignored');
      assert.deepEqual(replied(await ask(sim, 'deaf.test')).addresses, [ZONE_A]);
      const old = replied(await ask(sim, 'old.test', 'A', { opt: true }));
      assert.equal(old.rcode, 'FORMERR');
      assert.equal(old.opt, false);
      assert.deepEqual(replied(await ask(sim, 'old.test')).addresses, [ZONE_A]);
      const edns = replied(await ask(sim, 'edns.test', 'A', { opt: true }));
      assert.equal(edns.opt, true);
      assert.equal(replied(await ask(sim, 'edns.test')).opt, false);
    });

    it('truncates over UDP, then answers the TCP retry, resets it or leaves it silent', async (t) => {
      const many = Array.from({ length: 70 }, (_, at) => `198.51.100.${String(at + 1)}`);
      const sim = await start(t, {
        names: {
          'big.test': { reply: replies.addresses(ZONE_A), truncate: 'tcp' },
          'reset.test': { reply: replies.addresses(ZONE_A), truncate: 'tcp-reset' },
          'mute.test': { reply: replies.addresses(ZONE_A), truncate: 'tcp-silent' },
          'seventy.test': { reply: replies.addresses(...many) },
        },
      });
      const udp = replied(await ask(sim, 'big.test', 'A', { followTruncation: false }));
      assert.equal(udp.tc, true);
      assert.equal(udp.answers.length, 0);
      const tcp = replied(await ask(sim, 'big.test'));
      assert.equal(tcp.transport, 'tcp');
      assert.deepEqual(tcp.addresses, [ZONE_A]);
      const reset = await ask(sim, 'reset.test');
      assert.equal(reset.kind === 'error' ? reset.code : reset.kind, 'ECONNRESET');
      assert.equal((await ask(sim, 'mute.test', 'A', { timeoutMs: 300 })).kind, 'timeout');
      assert.equal(
        (
          await logged(
            sim,
            (e) => e.transport === 'tcp' && e.qname === 'mute.test',
            'the silent TCP retry',
          )
        ).outcome,
        'ignored',
      );
      // Seventy addresses do not fit 512 bytes: TC over UDP, every one over TCP.
      const seventy = replied(await ask(sim, 'seventy.test'));
      assert.equal(seventy.transport, 'tcp');
      assert.equal(seventy.addresses.length, 70);
    });

    it('refuses the TCP retry with ECONNREFUSED when TCP is closed', async (t) => {
      const sim = await start(t, {
        tcp: 'closed',
        names: { 'big.test': { reply: replies.addresses(ZONE_A), truncate: 'tcp' } },
      });
      const result = await ask(sim, 'big.test');
      assert.equal(result.kind === 'error' ? result.code : result.kind, 'ECONNREFUSED');
    });

    it('follows a CNAME into a zone that answers, and into one that is silent', async (t) => {
      const sim = await start(t, {
        zones: {
          'zone-a.test': { reply: replies.addresses(ZONE_A) },
          'zone-b.test': { reply: replies.silent },
        },
        names: {
          'alias.test': { reply: replies.cname('www.zone-a.test') },
          'dark.test': { reply: replies.cname('www.zone-b.test') },
        },
      });
      const alias = replied(await ask(sim, 'alias.test'));
      assert.deepEqual(
        alias.answers.map((answer) => [answer.type, answer.data]),
        [
          [5, 'www.zone-a.test'],
          [1, ZONE_A],
        ],
      );
      assert.equal((await ask(sim, 'dark.test', 'A', { timeoutMs: 300 })).kind, 'timeout');
      assert.equal(
        (await logged(sim, named('dark.test'), 'the CNAME into silence')).reply,
        undefined,
      );
    });

    it('echoes the question as it came, a dot inside a label too (W5)', async (t) => {
      const sim = await start(t);
      const socket = createSocket('udp4');
      t.after(() => {
        socket.close();
      });
      const reply = new Promise<Buffer>((resolve) => {
        socket.once('message', resolve);
      });
      // One question: the labels `x` and `.` (RFC 2181 §11: a label may hold any octet), A, IN.
      const query = Buffer.from([
        0x12, 0x34, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0x78, 1, 0x2e, 0, 0, 1, 0, 1,
      ]);
      socket.send(query, sim.server().port, '127.0.0.1');
      const answer = await within(ANSWER_BOUND_MS, 'the reply', reply);
      assert.equal(answer.readUInt16BE(0), 0x1234);
      assert.equal(answer.readUInt16BE(4), 1);
      assert.deepEqual(answer.subarray(12, 21), query.subarray(12, 21));
      assert.equal(answer.readUInt16BE(2) & 0xf, 3);
    });

    it('answers SERVFAIL for a reply it cannot build, and keeps serving (W5)', async (t) => {
      const long = `${'a'.repeat(64)}.zone-a.test`;
      const sim = await start(t, {
        zones: { 'zone-a.test': { reply: replies.addresses(ZONE_A) } },
        names: { 'bad.test': { reply: replies.cname(long) } },
      });
      assert.equal(replied(await ask(sim, 'bad.test')).rcode, 'SERVFAIL');
      const fault = await logged(sim, named('bad.test'), 'the fault');
      assert.equal(fault.outcome, 'fault');
      assert.match(fault.fault ?? '', /label over 63 bytes/u);
      assert.equal(fault.reply?.rcode, 'SERVFAIL');
      const [gauge] = await sim.gauge();
      assert.ok(gauge);
      assert.equal(gauge.faults, 1);
      assert.equal(gauge.outcomes.forwarded, 0);
      assert.deepEqual(replied(await ask(sim, 'dev-1.zone-a.test')).addresses, [ZONE_A]);
    });

    it('answers localhost itself, as the canary needs, unless a behaviour names it', async (t) => {
      const sim = await start(t, { fallback: { reply: replies.silent } });
      const local = replied(await ask(sim, 'localhost.'));
      assert.deepEqual(local.addresses, ['127.0.0.1']);
      assert.equal((await logged(sim, named('localhost'), 'the canary')).outcome, 'local');
      assert.deepEqual(replied(await ask(sim, 'localhost', 'AAAA')).addresses, ['::1']);
      await sim.set({ name: 'localhost' }, { reply: replies.silent });
      assert.equal((await ask(sim, 'localhost', 'A', { timeoutMs: 300 })).kind, 'timeout');
    });
  });

  describe('the recursion cache', () => {
    it('answers cached names while their zone is silent, each until its own TTL ends', async (t) => {
      const sim = await start(t, {
        clock: 'manual',
        cache: true,
        zones: { 'zone-b.test': { reply: replies.addresses(ZONE_A), ttl: 30 } },
        names: { 'long.zone-b.test': { reply: replies.addresses(ZONE_A), ttl: 90 } },
      });
      assert.equal(replied(await ask(sim, 'short.zone-b.test')).answers[0]?.ttl, 30);
      assert.equal(replied(await ask(sim, 'long.zone-b.test')).answers[0]?.ttl, 90);
      await sim.set({ zone: 'zone-b.test' }, { reply: replies.silent });
      await sim.set({ name: 'long.zone-b.test' }, { reply: replies.silent });

      await sim.advance(10_000);
      const short = replied(await ask(sim, 'short.zone-b.test'));
      assert.equal(short.answers[0]?.ttl, 20);
      assert.equal(
        (await logged(sim, named('short.zone-b.test'), 'the cached answer')).outcome,
        'cache',
      );
      assert.equal(
        (await ask(sim, 'uncached.zone-b.test', 'A', { timeoutMs: 200 })).kind,
        'timeout',
      );

      await sim.advance(21_000);
      assert.equal((await ask(sim, 'short.zone-b.test', 'A', { timeoutMs: 200 })).kind, 'timeout');
      assert.deepEqual(replied(await ask(sim, 'long.zone-b.test')).addresses, [ZONE_A]);
      await sim.advance(60_000);
      assert.equal((await ask(sim, 'long.zone-b.test', 'A', { timeoutMs: 200 })).kind, 'timeout');
      assert.equal((await sim.gauge())[0]?.cached, 0);
    });

    it('is filled by prime, emptied by flush, and keeps no SERVFAIL', async (t) => {
      const sim = await start(t, {
        clock: 'manual',
        cache: true,
        zones: { 'zone-b.test': { reply: replies.silent } },
        names: { 'broken.test': { reply: replies.servfail } },
      });
      await sim.prime([{ name: 'kept.zone-b.test', addresses: [ZONE_A, ZONE_A_V6], ttl: 60 }]);
      assert.deepEqual(replied(await ask(sim, 'kept.zone-b.test')).addresses, [ZONE_A]);
      assert.deepEqual(replied(await ask(sim, 'kept.zone-b.test', 'AAAA')).addresses, [ZONE_A_V6]);
      await sim.flush({ name: 'KEPT.zone-b.test' });
      assert.equal((await ask(sim, 'kept.zone-b.test', 'A', { timeoutMs: 200 })).kind, 'timeout');
      assert.equal(replied(await ask(sim, 'broken.test')).rcode, 'SERVFAIL');
      assert.equal(replied(await ask(sim, 'broken.test')).rcode, 'SERVFAIL');
      assert.deepEqual(
        (await sim.log()).filter(named('broken.test')).map((entry) => entry.outcome),
        ['forwarded', 'forwarded'],
      );
      const uncached = await start(t);
      await assert.rejects(
        uncached.prime([{ name: 'x.test', addresses: [], ttl: 1 }]),
        /no recursion cache/u,
      );
    });
  });

  describe('the forwarder', () => {
    it('holds a slot per distinct question, drops past forwardMax, and lets go at holdMs', async (t) => {
      const sim = await start(t, {
        clock: 'manual',
        cache: true,
        forwarder: { forwardMax: 3, holdMs: 10_000 },
        zones: {
          'zone-a.test': { reply: replies.addresses(ZONE_A) },
          'zone-b.test': { reply: replies.silent },
        },
      });
      assert.deepEqual(replied(await ask(sim, 'cached.zone-a.test')).addresses, [ZONE_A]);
      const client = await sim.openClient();
      t.after(() => client.close());
      for (const device of [1, 2, 3, 4]) {
        await client.send(sim.target(), `dev-${String(device)}.zone-b.test`, 'A', { id: device });
      }
      await logged(sim, named('dev-4.zone-b.test'), 'the fourth silent question');
      const [full] = await sim.gauge();
      assert.ok(full);
      assert.equal(full.heldNow, 3);
      assert.equal(full.distinctHeld, 3);
      assert.equal(full.dropped, 1);
      assert.equal((await logged(sim, named('dev-4.zone-b.test'), 'the drop')).outcome, 'dropped');
      // A table full of silent questions refuses an answering name's new question too, as
      // dnsmasq 2.86 and later do ("table full - flags == 0, return REFUSED" in forward.c), with
      // the question echoed and OPT only if the query had it. It is counted as dropped. A cached
      // name takes no slot and is answered.
      const refused = replied(await ask(sim, 'new.zone-a.test'));
      assert.equal(refused.rcode, 'REFUSED');
      assert.deepEqual(
        refused.message.questions.map((question) => question.name),
        ['new.zone-a.test'],
      );
      assert.equal(refused.opt, false);
      assert.equal(replied(await ask(sim, 'new.zone-a.test', 'A', { opt: true })).opt, true);
      assert.equal((await logged(sim, named('new.zone-a.test'), 'the drop')).outcome, 'dropped');
      assert.equal((await sim.gauge())[0]?.dropped, 3);
      assert.deepEqual(replied(await ask(sim, 'cached.zone-a.test')).addresses, [ZONE_A]);

      await sim.advance(9_999);
      assert.equal((await sim.gauge())[0]?.heldNow, 3);
      await sim.advance(1);
      assert.equal((await sim.gauge())[0]?.heldNow, 0);
      assert.deepEqual(replied(await ask(sim, 'new.zone-a.test')).addresses, [ZONE_A]);
      assert.equal((await sim.gauge())[0]?.peakHeld, 3);
    });

    it('answers nothing past forwardMax under whenFull silent, as dnsmasq 2.85 does (W1)', async (t) => {
      const sim = await start(t, {
        forwarder: { forwardMax: 1, whenFull: 'silent' },
        zones: {
          'zone-a.test': { reply: replies.addresses(ZONE_A) },
          'zone-b.test': { reply: replies.silent },
        },
      });
      const client = await sim.openClient();
      t.after(() => client.close());
      await client.send(sim.target(), 'dev-1.zone-b.test', 'A', { id: 1 });
      await client.send(sim.target(), 'dev-1.zone-a.test', 'A', { id: 2 });
      // localhost takes no slot. Its reply goes after any the server gave the drop, so once it is
      // here a reply to the drop would be here too.
      replied(await client.ask(sim.target(), 'localhost', 'A', { id: 3 }));
      const dropped = await logged(sim, named('dev-1.zone-a.test'), 'the drop');
      assert.equal(dropped.outcome, 'dropped');
      assert.equal(dropped.reply, undefined);
      assert.equal((await inHand(client, 2)).kind, 'timeout');
      assert.equal((await sim.gauge())[0]?.dropped, 1);
    });

    it('merges an identical question from another client, or only a client’s own resend', async (t) => {
      for (const merge of ['question', 'client'] as const) {
        const sim = await start(t, {
          forwarder: { merge },
          zones: { 'zone-b.test': { reply: replies.silent } },
        });
        const one = await sim.openClient();
        const two = await sim.openClient();
        t.after(() => Promise.all([one.close(), two.close()]));
        await one.send(sim.target(), 'dev-1.zone-b.test', 'A', { id: 1 });
        const count = (n: number) => async (): Promise<boolean> => (await sim.log()).length >= n;
        await pollWithin(ANSWER_BOUND_MS, 'the first ask', count(1));
        await one.send(sim.target(), 'dev-1.zone-b.test', 'A', { id: 1 });
        await pollWithin(ANSWER_BOUND_MS, 'the resend', count(2));
        await two.send(sim.target(), 'dev-1.zone-b.test', 'A', { id: 1 });
        await pollWithin(ANSWER_BOUND_MS, 'the second client', count(3));
        const outcomes = (await sim.log()).map((entry) => entry.outcome);
        const [gauge] = await sim.gauge();
        assert.ok(gauge);
        if (merge === 'question') {
          assert.deepEqual(outcomes, ['forwarded', 'retry', 'merged']);
          assert.equal(gauge.heldNow, 1);
        } else {
          assert.deepEqual(outcomes, ['forwarded', 'retry', 'forwarded']);
          assert.equal(gauge.heldNow, 2);
        }
        assert.equal(gauge.distinctHeld, 1);
        assert.deepEqual(
          (await sim.held()).map((held) => held.waiters),
          merge === 'question' ? [2] : [1, 1],
        );
      }
    });

    it('answers every client merged on a held question when the test answers it (F3)', async (t) => {
      const sim = await start(t, { names: { 'slow.test': { reply: replies.held } } });
      const one = await sim.openClient();
      const two = await sim.openClient();
      t.after(() => Promise.all([one.close(), two.close()]));
      const first = one.ask(sim.target(), 'slow.test', 'A', { id: 21, timeoutMs: ANSWER_BOUND_MS });
      await logged(sim, (entry) => entry.client.port === one.port, 'the first ask');
      const second = two.ask(sim.target(), 'slow.test', 'A', {
        id: 22,
        timeoutMs: ANSWER_BOUND_MS,
      });
      await logged(sim, (entry) => entry.client.port === two.port, 'the second ask');
      assert.deepEqual(
        (await sim.held()).map((held) => held.waiters),
        [2],
      );
      assert.equal(await sim.answer('slow.test', replies.addresses(ZONE_A)), 2);
      assert.deepEqual(replied(await first).addresses, [ZONE_A]);
      assert.deepEqual(replied(await second).addresses, [ZONE_A]);
      assert.deepEqual(
        (await sim.log()).map((entry) => entry.outcome),
        ['forwarded', 'merged'],
      );
      const [gauge] = await sim.gauge();
      assert.ok(gauge);
      assert.equal(gauge.peakHeld, 1);
      assert.equal(gauge.heldNow, 0);
      assert.equal(await sim.answer('slow.test', replies.addresses(ZONE_A)), 0);
      await assert.rejects(sim.answer('slow.test', replies.silent), /not silent/u);
    });

    it('sends a TCP question straight upstream: no slot, no merge, never dropped (W6)', async (t) => {
      const sim = await start(t, {
        forwarder: { forwardMax: 1 },
        zones: {
          'zone-a.test': { reply: replies.addresses(ZONE_A) },
          'zone-b.test': { reply: replies.held },
        },
      });
      const client = await sim.openClient();
      t.after(() => client.close());
      await client.send(sim.target(), 'dev-1.zone-b.test', 'A', { id: 1 });
      await logged(sim, named('dev-1.zone-b.test'), 'the question holding the one slot');
      // The table is full, and a question over TCP is answered all the same.
      const tcp = replied(await ask(sim, 'dev-1.zone-a.test', 'A', { transport: 'tcp' }));
      assert.equal(tcp.transport, 'tcp');
      assert.deepEqual(tcp.addresses, [ZONE_A]);
      // The held question over TCP joins nothing and takes no slot: it waits on its own.
      const heldTcp = ask(sim, 'dev-1.zone-b.test', 'A', { transport: 'tcp' });
      await pollWithin(
        ANSWER_BOUND_MS,
        'the held question over TCP',
        async () => (await sim.log()).filter(named('dev-1.zone-b.test')).length === 2,
      );
      const [gauge] = await sim.gauge();
      assert.ok(gauge);
      assert.equal(gauge.heldNow, 1);
      assert.equal(gauge.dropped, 0);
      assert.equal(gauge.outcomes.merged, 0);
      assert.deepEqual(
        (await sim.log()).map((entry) => `${entry.transport} ${entry.outcome}`),
        ['udp forwarded', 'tcp forwarded', 'tcp forwarded'],
      );
      assert.deepEqual(
        (await sim.held()).map((held) => held.waiters),
        [1],
      );
      assert.equal(await sim.answer('dev-1.zone-b.test', replies.addresses(ZONE_A)), 2);
      assert.deepEqual(replied(await heldTcp).addresses, [ZONE_A]);
      assert.deepEqual(replied(await client.reply(1, ANSWER_BOUND_MS)).addresses, [ZONE_A]);
      assert.equal((await sim.gauge())[0]?.heldNow, 0);
    });

    it('answers its own REFUSED without TC for a truncate name, so no TCP retry follows (L2)', async (t) => {
      const sim = await start(t, {
        forwarder: { forwardMax: 1 },
        zones: { 'zone-b.test': { reply: replies.held } },
        names: { 'big.test': { reply: replies.addresses(ZONE_A), truncate: 'tcp' } },
      });
      const client = await sim.openClient();
      t.after(() => client.close());
      await client.send(sim.target(), 'dev-1.zone-b.test', 'A', { id: 1 });
      await logged(sim, named('dev-1.zone-b.test'), 'the question holding the one slot');
      const refused = replied(await ask(sim, 'big.test'));
      assert.equal(refused.rcode, 'REFUSED');
      assert.equal(refused.tc, false);
      assert.equal(refused.transport, 'udp');
      assert.equal((await logged(sim, named('big.test'), 'the drop')).outcome, 'dropped');
      assert.deepEqual(
        (await sim.log()).filter((entry) => entry.transport === 'tcp'),
        [],
      );
    });

    it('gives the TCP retry of a held answer that went truncated the same answer', async (t) => {
      const sim = await start(t, {
        names: { 'big.test': { reply: replies.held, truncate: 'tcp' } },
      });
      const asking = ask(sim, 'big.test');
      await pollWithin(
        ANSWER_BOUND_MS,
        'the held question',
        async () => (await sim.held())[0]?.waiters === 1,
      );
      assert.equal(await sim.answer('big.test', replies.addresses(ZONE_A)), 1);
      const answered = replied(await asking);
      assert.equal(answered.transport, 'tcp');
      assert.deepEqual(answered.addresses, [ZONE_A]);
      assert.deepEqual(
        (await sim.log()).map((entry) => [entry.transport, entry.outcome, entry.reply?.tc]),
        [
          ['udp', 'forwarded', true],
          ['tcp', 'forwarded', false],
        ],
      );
      // Only the retry was owed the answer: a new question over TCP is held again.
      const again = ask(sim, 'big.test', 'A', { transport: 'tcp' });
      await pollWithin(
        ANSWER_BOUND_MS,
        'the new TCP question held',
        async () => (await sim.gauge())[0]?.tcpHeld === 1,
      );
      assert.equal(await sim.answer('big.test', replies.addresses(ZONE_A)), 1);
      assert.deepEqual(replied(await again).addresses, [ZONE_A]);
    });

    it('lets go of a held TCP question whose connection closes, and answers it never (L4)', async (t) => {
      const sim = await start(t, { names: { 'slow.test': { reply: replies.held } } });
      const socket = connect(sim.server().port, '127.0.0.1');
      t.after(() => {
        socket.destroy();
      });
      await within(ANSWER_BOUND_MS, 'the TCP connection', once(socket, 'connect'));
      socket.write(frame(encodeQuery({ id: 5, name: 'slow.test', type: typeCode('A') })));
      await pollWithin(
        ANSWER_BOUND_MS,
        'the held TCP question',
        async () => (await sim.gauge())[0]?.tcpHeld === 1,
      );
      socket.destroy();
      await pollWithin(
        ANSWER_BOUND_MS,
        'the closed connection let go',
        async () => (await sim.gauge())[0]?.tcpHeld === 0,
      );
      assert.equal(await sim.answer('slow.test', replies.addresses(ZONE_A)), 0);
    });

    it('counts held slots per port class, and a background client’s slots', async (t) => {
      const sim = await start(t, { zones: { 'zone-b.test': { reply: replies.silent } } });
      const gai = await sim.openClient();
      const walk = await sim.openClient();
      t.after(() => Promise.all([gai.close(), walk.close()]));
      await sim.tagPort(gai.port, 'gai');
      await gai.send(sim.target(), 'dev-1.zone-b.test', 'A', { id: 1 });
      await gai.send(sim.target(), 'dev-2.zone-b.test', 'A', { id: 2 });
      await walk.send(sim.target(), 'dev-3.zone-b.test', 'A', { id: 3 });
      await walk.send(sim.target(), 'dev-1.zone-b.test', 'A', { id: 4 });
      await pollWithin(
        ANSWER_BOUND_MS,
        'all four questions',
        async () => (await sim.log()).length === 4,
      );
      const [gauge] = await sim.gauge();
      assert.ok(gauge);
      assert.equal(gauge.heldNow, 3);
      assert.deepEqual(gauge.peakHeldByClass, { gai: 2, other: 2 });
      assert.equal((await logged(sim, (entry) => entry.id === 1, 'gai')).portClass, 'gai');

      await sim.occupy(5);
      const [occupied] = await sim.gauge(undefined, { resetPeak: true });
      assert.ok(occupied);
      assert.equal(occupied.heldNow, 8);
      assert.equal(occupied.background, 5);
      assert.equal(occupied.peakHeld, 8);
      await sim.release();
      const [after] = await sim.gauge();
      assert.ok(after);
      assert.equal(after.heldNow, 3);
      assert.equal(after.peakHeld, 8);
      assert.equal(after.heldByClass['background'], 0);
    });

    it('takes no lapsed hold into the peak when slots are occupied (F2)', async (t) => {
      const sim = await start(t, {
        clock: 'manual',
        forwarder: { holdMs: 10_000 },
        zones: { 'zone-b.test': { reply: replies.silent } },
      });
      const client = await sim.openClient();
      t.after(() => client.close());
      for (const device of [1, 2, 3]) {
        await client.send(sim.target(), `dev-${String(device)}.zone-b.test`, 'A', { id: device });
      }
      await pollWithin(
        ANSWER_BOUND_MS,
        'all three questions',
        async () => (await sim.log()).length === 3,
      );
      await sim.advance(10_000);
      await sim.occupy(5);
      const [gauge] = await sim.gauge();
      assert.ok(gauge);
      assert.equal(gauge.heldNow, 5);
      assert.equal(gauge.peakHeld, 5);
    });
  });

  describe('the per-client limiter', () => {
    it('refuses everything from a client past its count until its window ends', async (t) => {
      const sim = await start(t, {
        clock: 'manual',
        limiter: { queries: 3, windowMs: 60_000 },
        zones: { 'zone-a.test': { reply: replies.addresses(ZONE_A) } },
      });
      for (const device of [1, 2, 3]) {
        assert.equal(replied(await ask(sim, `dev-${String(device)}.zone-a.test`)).rcode, 'NOERROR');
      }
      await sim.advance(30_000);
      assert.equal(replied(await ask(sim, 'dev-4.zone-a.test')).rcode, 'REFUSED');
      assert.equal(replied(await ask(sim, 'localhost')).rcode, 'REFUSED');
      const [trip, ...more] = await sim.trips();
      assert.deepEqual(more, []);
      assert.deepEqual(trip, {
        server: 'ns1',
        client: '127.0.0.1',
        at: 30_000,
        windowEndsAt: 60_000,
        count: 4,
      });
      assert.equal((await sim.gauge())[0]?.limited, 2);
      await sim.advance(30_000);
      assert.equal(replied(await ask(sim, 'dev-5.zone-a.test')).rcode, 'NOERROR');
    });

    it('keys its count by source address', async (t) => {
      const sim = await start(t, {
        limiter: { queries: 1, windowMs: 60_000 },
        zones: { 'zone-a.test': { reply: replies.addresses(ZONE_A) } },
      });
      assert.equal(replied(await ask(sim, 'dev-1.zone-a.test')).rcode, 'NOERROR');
      assert.equal(replied(await ask(sim, 'dev-2.zone-a.test')).rcode, 'REFUSED');
      const other = await ask(sim, 'dev-3.zone-a.test', 'A', { localAddress: '127.0.0.2' });
      if (other.kind === 'error' && other.code === 'EADDRNOTAVAIL') {
        t.skip('127.0.0.2 is not on this machine’s loopback');
        return;
      }
      assert.equal(replied(other).rcode, 'NOERROR');
    });

    it('counts a background client from the probe’s address against the same limit', async (t) => {
      const sim = await start(t, {
        clock: 'manual',
        limiter: { queries: 20, windowMs: 60_000 },
        zones: { 'zone-a.test': { reply: replies.addresses(ZONE_A) } },
      });
      const port = await sim.client('ping', 200, ['sw-1.zone-a.test', 'sw-2.zone-a.test'], {
        qtype: 'both',
      });
      await pollWithin(ANSWER_BOUND_MS, 'the ping client past its limit', async () => {
        const [stats] = await sim.clients();
        return stats !== undefined && stats.answered === 20 && stats.refused >= 5;
      });
      const stats = await sim.stopClient('ping');
      assert.equal(stats.port, port);
      assert.equal(stats.answered, 20);
      assert.equal(stats.otherRcodes, 0);
      assert.ok(stats.sent >= 25);
      const trip = (await sim.trips())[0];
      assert.ok(trip);
      assert.equal(trip.client, '127.0.0.1');
      assert.equal(trip.count, 21);
      const theirs = (await sim.log()).filter((entry) => entry.client.port === port);
      assert.ok(theirs.every((entry) => entry.portClass === 'ping'));
      assert.deepEqual(
        theirs.slice(0, 4).map((entry) => `${entry.qname} ${entry.qtype}`),
        [
          'sw-1.zone-a.test A',
          'sw-1.zone-a.test AAAA',
          'sw-2.zone-a.test A',
          'sw-2.zone-a.test AAAA',
        ],
      );
      // The probe, on the same address, is refused for the rest of the window too.
      assert.equal(replied(await ask(sim, 'dev-1.zone-a.test')).rcode, 'REFUSED');
      await assert.rejects(sim.stopClient('ping'), /no client ping/u);
    });
  });

  describe('servers that are dead', () => {
    it('a dead first nameserver: silent, then with nothing bound, then back', async (t) => {
      const sim = await start(t, {
        zones: { 'zone-a.test': { reply: replies.addresses(ZONE_A) } },
        servers: [{ name: 'ns1', dead: 'silent' }, { name: 'ns2' }],
      });
      const first = sim.target('ns1');
      assert.equal(
        (await dnsQuery(first, 'dev-1.zone-a.test', 'A', { timeoutMs: 300, avoid: sim.ports }))
          .kind,
        'timeout',
      );
      assert.equal(
        (await logged(sim, (entry) => entry.server === 'ns1', 'the dead server’s datagram'))
          .outcome,
        'ignored',
      );
      const second = await dnsQuery(sim.target('ns2'), 'dev-1.zone-a.test', 'A', {
        timeoutMs: ANSWER_BOUND_MS,
      });
      assert.deepEqual(replied(second).addresses, [ZONE_A]);
      assert.deepEqual(sim.serverList(), [
        `127.0.0.1:${String(sim.server('ns1').port)}`,
        `127.0.0.1:${String(sim.server('ns2').port)}`,
      ]);

      await sim.setDead('ns1', 'refused');
      const refused = await dnsQuery(first, 'dev-1.zone-a.test', 'A', {
        timeoutMs: ANSWER_BOUND_MS,
        avoid: sim.ports,
      });
      assert.equal(refused.kind === 'error' ? refused.code : refused.kind, 'ECONNREFUSED');
      const overTcp = await dnsQuery(first, 'dev-1.zone-a.test', 'A', {
        transport: 'tcp',
        timeoutMs: ANSWER_BOUND_MS,
      });
      assert.equal(overTcp.kind === 'error' ? overTcp.code : overTcp.kind, 'ECONNREFUSED');

      await sim.setDead('ns1', false);
      const back = await dnsQuery(first, 'dev-1.zone-a.test', 'A', {
        timeoutMs: ANSWER_BOUND_MS,
        avoid: sim.ports,
      });
      assert.deepEqual(replied(back).addresses, [ZONE_A]);
    });

    it('starts with nothing bound for a server that is dead refused', async (t) => {
      const sim = await start(t, { servers: [{ name: 'gone', dead: 'refused' }] });
      const result = await dnsQuery(sim.target('gone'), 'x.test', 'A', {
        timeoutMs: ANSWER_BOUND_MS,
        avoid: sim.ports,
      });
      assert.equal(result.kind === 'error' ? result.code : result.kind, 'ECONNREFUSED');
    });

    it('names the port when it was taken while the server was dead (F4)', async (t) => {
      const sim = await start(t, { servers: [{ name: 'gone', dead: 'refused' }] });
      const { port } = sim.server('gone');
      const squatter = createSocket('udp4');
      t.after(() => {
        squatter.close();
      });
      await new Promise<void>((resolve, reject) => {
        squatter.once('error', reject);
        squatter.bind(port, '127.0.0.1', resolve);
      });
      await assert.rejects(
        sim.setDead('gone', false),
        new RegExp(`port ${String(port)} was taken while the server was dead`, 'u'),
      );
    });

    it('draws a client port again when it is a server’s, and closes the draws after (F4)', async (t) => {
      const draws = [5300, 5301, 5302];
      const closed: number[] = [];
      const chosen = await avoidingPorts(
        () => Promise.resolve(draws.shift() ?? assert.fail('drew too often')),
        (port) => port,
        (port) => {
          closed.push(port);
          return Promise.resolve();
        },
        [5300, 5301],
      );
      assert.equal(chosen, 5302);
      assert.deepEqual(closed, [5300, 5301]);
      await assert.rejects(
        avoidingPorts(
          () => Promise.resolve(5300),
          (port) => port,
          () => Promise.resolve(),
          [5300],
          3,
        ),
        /no ephemeral port outside 5300 in 3 tries/u,
      );
      const sim = await start(t, { servers: [{ name: 'gone', dead: 'refused' }, { name: 'ns2' }] });
      const client = await sim.openClient();
      t.after(() => client.close());
      assert.ok(!sim.ports.includes(client.port));
    });

    it('gives every client’s draw its avoid list, the servers’ ports added (F4)', async (t) => {
      const sim = await start(t, { servers: [{ name: 'ns1' }, { name: 'gone', dead: 'refused' }] });
      const gone = sim.server('gone').port;
      const every = Array.from({ length: 65_535 }, (_, at) => at + 1);
      // One short of every port: only the servers' own, added by the simulator, make it every one.
      const others = every.filter((port) => port !== gone);
      const exhausted = /no ephemeral port outside 65535 avoided ports in 32 tries/u;
      await assert.rejects(DnsClient.open({ avoid: every }), exhausted);
      await assert.rejects(sim.openClient({ avoid: others }), exhausted);
      await assert.rejects(sim.client('ping', 10, ['x.test'], { avoid: others }), exhausted);
      const asked = await dnsQuery(sim.target('ns1'), 'x.test', 'A', {
        timeoutMs: ANSWER_BOUND_MS,
        avoid: every,
      });
      assert.match(asked.kind === 'error' ? asked.message : asked.kind, exhausted);
      assert.deepEqual(await sim.clients(), []);
    });

    it('binds every server before a refused one lets its port go (L1)', async () => {
      // A port free now, on 127.0.0.1, for both servers to ask for.
      const probe = createSocket('udp4');
      await new Promise<void>((resolve) => {
        probe.bind(0, '127.0.0.1', resolve);
      });
      const { port } = probe.address();
      await new Promise<void>((resolve) => {
        probe.close(resolve);
      });
      // The refused server still holds its port while the next binds, so the next cannot have it.
      await assert.rejects(
        DnsSimulator.start({
          servers: [
            { name: 'gone', dead: 'refused', port },
            { name: 'ns2', port },
          ],
        }),
        new RegExp(`EADDRINUSE 127\\.0\\.0\\.1:${String(port)}`, 'u'),
      );
    });
  });

  describe('the query log', () => {
    it('records each datagram’s question, client, outcome and answer time', async (t) => {
      const sim = await start(t, {
        zones: { 'zone-a.test': { reply: replies.addresses(ZONE_A) } },
      });
      const client = await sim.openClient();
      t.after(() => client.close());
      const before = await sim.now();
      const cookie = { code: 10, data: Buffer.alloc(8, 7) };
      const answered = replied(
        await client.ask(sim.target(), 'Dev-1.zone-a.test', 'AAAA', {
          id: 0x1234,
          opt: { options: [cookie] },
        }),
      );
      assert.equal(answered.opt, true);
      const [entry, ...rest] = await sim.log();
      assert.deepEqual(rest, []);
      assert.ok(entry);
      assert.equal(entry.server, 'ns1');
      assert.equal(entry.family, 4);
      assert.equal(entry.transport, 'udp');
      assert.deepEqual(entry.client, { address: '127.0.0.1', port: client.port });
      assert.equal(entry.portClass, undefined);
      assert.equal(entry.id, 0x1234);
      assert.equal(entry.qname, 'Dev-1.zone-a.test');
      assert.equal(entry.qtype, 'AAAA');
      assert.equal(entry.opt, true);
      assert.deepEqual(entry.ednsOptions, [10]);
      assert.equal(entry.outcome, 'forwarded');
      assert.ok(entry.at >= before);
      assert.ok(entry.reply);
      assert.equal(entry.reply.rcode, 'NOERROR');
      assert.equal(entry.reply.answers, 0);
      assert.equal(entry.reply.tc, false);
      assert.ok(entry.reply.at >= entry.at);

      replied(await client.ask(sim.target(), 'dev-2.zone-a.test', 'A'));
      assert.deepEqual(
        (await sim.log({ since: entry.seq })).map((later) => later.qname),
        ['dev-2.zone-a.test'],
      );
      // Answered at once, neither question was ever held across a turn: no peak.
      assert.equal((await sim.gauge())[0]?.peakHeld, 0);
      await sim.clearLog();
      assert.deepEqual(await sim.log(), []);
      assert.equal(await sim.logDropped(), 0);
    });

    it('answers a malformed query FORMERR and keeps serving', async (t) => {
      const sim = await start(t, {
        zones: { 'zone-a.test': { reply: replies.addresses(ZONE_A) } },
      });
      const socket = createSocket('udp4');
      t.after(() => {
        socket.close();
      });
      const reply = new Promise<Buffer>((resolve) => {
        socket.once('message', resolve);
      });
      // A header that promises one question, and a label that runs past the end.
      const broken = Buffer.from([0xab, 0xcd, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 9, 0x61]);
      socket.send(broken, sim.server().port, '127.0.0.1');
      const formerr = await within(ANSWER_BOUND_MS, 'the FORMERR', reply);
      assert.equal(formerr.readUInt16BE(0), 0xabcd);
      assert.equal(formerr.readUInt16BE(2) & 0xf, 1);
      assert.deepEqual(replied(await ask(sim, 'dev-1.zone-a.test')).addresses, [ZONE_A]);
    });
  });

  describe('in its worker', () => {
    it('answers while the main thread is blocked: the reply waits in the socket (F1)', async (t) => {
      const sim = await start(t, {
        names: {
          'fast.test': { reply: replies.addresses(ZONE_A) },
          'later.test': { reply: replies.addresses(ZONE_A), delayMs: 600 },
          'held.test': { reply: replies.held },
        },
      });
      const client = await sim.openClient();
      t.after(() => client.close());
      for (const [name, id] of [
        ['fast.test', 31],
        ['later.test', 32],
      ] as const) {
        const before = sim.repliesSent;
        const blockedAt = performance.now();
        await client.send(sim.target(), name, 'A', { id });
        await turn();
        // This thread never yields from here: whatever the worker answers waits in the socket.
        assert.equal(sim.waitForReplies(before + 1, ANSWER_BOUND_MS), true);
        const blockedMs = performance.now() - blockedAt;
        if (name === 'later.test') assert.ok(blockedMs >= 590, `blocked ${String(blockedMs)} ms`);
        // One poll phase reads it: a count that ran ahead of the datagram finds nothing here.
        await turn();
        assert.deepEqual(replied(await inHand(client, id)).addresses, [ZONE_A]);
      }
      // Many clients merged on one question are answered in one go. The first reply counts only
      // once its datagram is out, not while the rest are still being built.
      const ids = Array.from({ length: 200 }, (_, at) => 100 + at);
      for (const id of ids) await client.send(sim.target(), 'held.test', 'A', { id });
      await pollWithin(
        ANSWER_BOUND_MS,
        'every merged question',
        async () => (await sim.held())[0]?.waiters === ids.length,
      );
      const before = sim.repliesSent;
      await turn();
      const answering = sim.answer('held.test', replies.addresses(ZONE_A));
      assert.equal(sim.waitForReplies(before + 1, ANSWER_BOUND_MS), true);
      await turn();
      assert.deepEqual(replied(await inHand(client, 100)).addresses, [ZONE_A]);
      assert.equal(await answering, ids.length);
      assert.equal(sim.waitForReplies(before + ids.length, ANSWER_BOUND_MS), true);
      assert.equal(sim.waitForReplies(sim.repliesSent + 1, 50), false);
    });

    it('is read by c-ares as Node’s own Resolver asks', async (t) => {
      const sim = await start(t, {
        zones: { 'zone-a.test': { reply: replies.addresses(ZONE_A, ZONE_A_V6) } },
        names: {
          'nodata.zone-a.test': { reply: replies.nodata },
          'servfail.test': { reply: replies.servfail },
          'refused.test': { reply: replies.refused },
          'silent.test': { reply: replies.silent },
          'big.test': { reply: replies.addresses(ZONE_A), truncate: 'tcp' },
        },
      });
      // One try each: a long one for every name that answers, a short one only for silence (F3).
      const resolver = new Resolver({ timeout: ANSWER_BOUND_MS, tries: 1 });
      const quick = new Resolver({ timeout: 400, tries: 1 });
      const bound = 2 * ANSWER_BOUND_MS;
      for (const each of [resolver, quick]) {
        each.setServers(sim.serverList());
        t.after(() => {
          each.cancel();
        });
      }
      assert.deepEqual(await within(bound, 'resolve4', resolver.resolve4('dev-1.zone-a.test')), [
        ZONE_A,
      ]);
      assert.deepEqual(await within(bound, 'resolve6', resolver.resolve6('dev-1.zone-a.test')), [
        ZONE_A_V6,
      ]);
      const failing: [string, string][] = [
        ['nowhere.test', 'ENOTFOUND'],
        ['nodata.zone-a.test', 'ENODATA'],
        ['servfail.test', 'ESERVFAIL'],
        ['refused.test', 'EREFUSED'],
      ];
      for (const [name, code] of failing) {
        await assert.rejects(within(bound, name, resolver.resolve4(name)), { code });
      }
      await assert.rejects(within(bound, 'silent.test', quick.resolve4('silent.test')), {
        code: 'ETIMEOUT',
      });
      assert.deepEqual(await within(bound, 'the TCP retry', resolver.resolve4('big.test')), [
        ZONE_A,
      ]);
      const asked = await sim.log();
      assert.deepEqual(
        asked.filter(named('big.test')).map((entry) => entry.transport),
        ['udp', 'tcp'],
      );
      // Node's c-ares sends no OPT at all (W2): every query it asked reads so.
      assert.ok(asked.length >= 9, `${String(asked.length)} queries logged`);
      assert.deepEqual(
        asked.filter((entry) => entry.opt || entry.ednsOptions.length > 0),
        [],
      );
    });
  });
});
