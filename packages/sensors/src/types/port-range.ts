import type { connect as netConnect, LookupFunction } from 'node:net';
import type { ChannelDef, CheckContext, CheckExecution, SensorType } from '../contract.js';
import { checkedTarget, guardOf, lookupFor } from '../support/checked-target.js';

/**
 * How many of a set of ports are open (`T-22`).
 *
 * **Two jobs, and they are opposites.** "These five ports must all be open" is a service check
 * across a set — a load balancer's back ends, a cluster's members — where a Port sensor each
 * would be five sensors and five alarms for one outage. "This range must stay closed" is the
 * other: a canary for a firewall rule that got removed or a service that started listening on
 * something it should not.
 *
 * **Bounded, and deliberately not a port scanner.** Sixty-four ports is enough for either job
 * and small enough that this cannot become the thing that trips somebody's intrusion detection
 * every sixty seconds. A real scan is `nmap`, run by a person, once.
 *
 * **The primary channel is `open`, and what it should be is the operator's to say.** Set a lower
 * limit for "all of these must be up"; set an upper limit of zero for "none of these may be".
 * The same sensor does both, which is why it counts rather than deciding.
 */

/** Enough for a back-end pool or a firewall canary, and not enough to be a scanner. */
const MAX_PORTS = 64;

/**
 * `22,80,443` and `8000-8010`, in any mix.
 *
 * Exported for its own tests: a spec that silently parsed to fewer ports than it looks like
 * would be a sensor quietly watching less than an operator believes.
 */
export function parsePorts(spec: string): number[] {
  const ports: number[] = [];
  const seen = new Set<number>();

  for (const part of spec.split(',')) {
    const entry = part.trim();
    if (entry === '') continue;

    const range = /^(\d{1,5})\s*-\s*(\d{1,5})$/.exec(entry);
    if (range !== null) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (from < 1 || to > 65_535 || to < from) {
        throw new Error(`"${entry}" is not a port range — ports run from 1 to 65535, low first`);
      }
      for (let port = from; port <= to; port += 1) {
        if (!seen.has(port)) {
          seen.add(port);
          ports.push(port);
        }
      }
      continue;
    }

    if (!/^\d{1,5}$/.test(entry)) {
      throw new Error(`"${entry}" is not a port or a range like 8000-8010`);
    }
    const port = Number(entry);
    if (port < 1 || port > 65_535) {
      throw new Error(`"${entry}" is not a port — ports run from 1 to 65535`);
    }
    if (!seen.has(port)) {
      seen.add(port);
      ports.push(port);
    }
  }

  if (ports.length === 0) throw new Error('this sensor names no ports');
  if (ports.length > MAX_PORTS) {
    throw new Error(
      `this sensor names ${String(ports.length)} ports and the limit is ${String(MAX_PORTS)} — ` +
        'this is a service check across a known set, not a port scanner, and a scan is `nmap` ' +
        'run by a person rather than a probe every sixty seconds',
    );
  }
  return ports;
}

export const portRange: SensorType = {
  id: 'port.range',
  category: 'Availability',
  // Up to sixty-four sockets, a few at a time.
  costHint: 'medium',

  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['ports'],
    properties: {
      ports: {
        type: 'string',
        minLength: 1,
        maxLength: 500,
        title: 'Ports',
        description:
          'A list, a range, or both — “22,80,443” or “8000-8010” or “22,8000-8010”. At most ' +
          '64 in total.',
      },
      timeoutMs: {
        type: 'integer',
        minimum: 100,
        maximum: 60_000,
        default: 3_000,
        title: 'Timeout per port',
        description:
          'A port a firewall *drops* takes this long; a port that is closed is refused ' +
          'immediately. A range of dropped ports therefore costs about this much in total, ' +
          'since they are tried a few at a time.',
      },
      concurrency: {
        type: 'integer',
        minimum: 1,
        maximum: 16,
        default: 8,
        title: 'At once',
        description:
          'How many ports to try simultaneously. Higher finishes sooner and looks more like a ' +
          'scan to anything watching the far end.',
      },
    },
  },

  // Every reading is keyed by a channel `channels()` names, on every path: a channel a later
  // build drops is retired (`P-320`).
  declaresEveryChannel: true,

  channels(): readonly ChannelDef[] {
    return [
      // Counted rather than judged: a lower limit says "all of these must be up", an upper limit
      // of zero says "none of these may be", and the same sensor does both.
      { key: 'open', name: 'Open ports', unit: '' },
      { key: 'closed', name: 'Closed ports', unit: '' },
      { key: 'openPercent', name: 'Open', unit: '%', isPrimary: true },
    ];
  },

  async execute(context: CheckContext): Promise<CheckExecution> {
    const { connect } = await import('node:net');

    const host = context.target.host;
    if (host === '') throw new Error('the device has no host to connect to');
    const spec = context.params['ports'];
    const ports = parsePorts(typeof spec === 'string' ? spec : '');
    const timeoutMs = Number(context.params['timeoutMs'] ?? 3_000);
    const concurrency = Math.max(1, Number(context.params['concurrency'] ?? 8));
    const family =
      context.target.ipVersion === 'v6' ? 6 : context.target.ipVersion === 'v4' ? 4 : 0;

    // **Resolved once for the whole scan and checked against the probe's target policy**
    // (`A-57`). Every port's socket is answered with the checked addresses: a name that
    // resolved differently for each port would be a different device for each.
    const lookupStarted = process.hrtime.bigint();
    const { lookup } = lookupFor(
      host,
      await checkedTarget({
        ...guardOf(context.target),
        family,
        timeoutMs,
        signal: context.signal,
        verb: 'scan',
        doing: `scanning ${host}`,
      }),
    );

    // **The lookup shares a port's timeout, as it did when each socket made its own.** What
    // it took is taken from the first port each worker tries, the ones that would have waited
    // for it, so the scan never takes longer than it could before.
    const lookupMs = Number(process.hrtime.bigint() - lookupStarted) / 1e6;

    const open: number[] = [];
    const queue = [...ports];

    const worker = async (): Promise<void> => {
      let within = Math.max(1, timeoutMs - lookupMs);
      for (;;) {
        const port = queue.shift();
        if (port === undefined) return;
        if (context.signal.aborted) {
          throw new Error(`the check was cancelled while scanning ${host}`);
        }
        if (await isOpen(connect, host, port, family, within, context.signal, lookup)) {
          open.push(port);
        }
        within = timeoutMs;
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, ports.length) }, worker));

    open.sort((a, b) => a - b);
    const openPercent = Math.round((open.length / ports.length) * 10_000) / 100;

    return {
      channels: [
        { key: 'open', value: open.length },
        { key: 'closed', value: ports.length - open.length },
        { key: 'openPercent', value: openPercent },
      ],
      message:
        `${String(open.length)} of ${String(ports.length)} open` +
        (open.length === 0
          ? ''
          : `: ${open.slice(0, 12).join(', ')}${open.length > 12 ? ', …' : ''}`),
    };
  },
};

/** One connect attempt. Resolves rather than throwing: a closed port is a result, not an error. */
function isOpen(
  connect: typeof netConnect,
  host: string,
  port: number,
  family: number,
  timeoutMs: number,
  signal: AbortSignal,
  lookup: LookupFunction | undefined,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = connect({
      host,
      port,
      ...(family === 0 ? {} : { family }),
      ...(lookup === undefined ? {} : { lookup }),
    });
    let settled = false;

    const finish = (opened: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      socket.destroy();
      resolve(opened);
    };

    const onAbort = (): void => {
      finish(false);
    };
    signal.addEventListener('abort', onAbort, { once: true });

    const timer = setTimeout(() => {
      // A port a firewall drops looks exactly like this. Counted as closed, because from the
      // outside it is: nothing will connect to it.
      finish(false);
    }, timeoutMs);
    timer.unref();

    socket.once('connect', () => {
      finish(true);
    });
    socket.once('error', () => {
      finish(false);
    });
  });
}
