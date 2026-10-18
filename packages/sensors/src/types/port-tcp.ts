import type { ChannelDef, CheckContext, CheckExecution, SensorType } from '../contract.js';
import {
  checkedTarget,
  connectFailure,
  familyOf,
  guardOf,
  lookupFor,
  socketUnresolved,
} from '../support/checked-target.js';
import { PhasedError } from '../support/phased-error.js';

/**
 * A TCP connect, timed (`P-10`).
 *
 * **The cheapest check that proves something is actually serving**, which ICMP does not: a host
 * answers ping while the daemon on it has been dead for an hour. One socket, one handshake, and
 * the time it took.
 *
 * **The connect time is the reading, and it is not the round-trip time.** A TCP handshake is one
 * and a half round trips plus whatever the listener's accept queue is doing, so this number sits
 * above an ICMP time to the same host and *should*. A backlog filling up shows here and nowhere
 * else — which is the whole reason to run this alongside a ping rather than instead of it.
 *
 * **The banner is matched as text, never as a regular expression, and that is deliberate.** An
 * operator-supplied pattern against remote-supplied bytes is the ReDoS hazard `T-03` had to put
 * a `node:vm` watchdog behind; a banner check is "does this still say OpenSSH_9", for which a
 * substring is enough. `T-14` can lift the sandboxed matcher when HTTP content genuinely needs
 * one.
 */

/** Enough of a banner to identify a service. Nothing sane sends more before it is spoken to. */
const MAX_BANNER_BYTES = 1_024;

export const portTcp: SensorType = {
  id: 'port.tcp',
  category: 'Availability',
  costHint: 'light',

  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['port'],
    properties: {
      port: {
        type: 'integer',
        minimum: 1,
        maximum: 65_535,
        title: 'Port',
        description: 'The TCP port to connect to on this device.',
      },
      timeoutMs: {
        type: 'integer',
        minimum: 100,
        maximum: 120_000,
        default: 5_000,
        title: 'Timeout',
        description:
          'How long to wait for the connection to complete. A filtered port — one a firewall ' +
          'drops rather than refuses — takes this long every scan, where a refused one comes ' +
          'back immediately.',
      },
      banner: {
        type: 'string',
        maxLength: 200,
        default: '',
        title: 'Expected banner',
        description:
          'Optional. After connecting, wait briefly for the service to say something and check ' +
          'it contains this text — “OpenSSH”, “220 mail.example.com”. Matched as plain text ' +
          'ignoring case, not as a regular expression. Leave empty to check only that the port ' +
          'accepts a connection.',
      },
      bannerTimeoutMs: {
        type: 'integer',
        minimum: 100,
        maximum: 30_000,
        default: 3_000,
        title: 'Banner wait',
        description:
          'How long to wait for the service to speak first. Only some do — HTTP does not — so ' +
          'a banner check against a silent protocol will always fail, and that is what it is ' +
          'telling you rather than a fault.',
      },
    },
  },

  // Every reading is keyed by a channel `channels(params)` names for the same parameters, so one
  // an edit no longer names is retired (`P-310`).
  declaresEveryChannel: true,

  channels(params: Readonly<Record<string, unknown>>): readonly ChannelDef[] {
    const banner = typeof params['banner'] === 'string' ? params['banner'].trim() : '';
    return [
      { key: 'connectTime', name: 'Connect time', unit: 'ms', isPrimary: true },
      // Only when a banner was asked for: a channel that is always 1 is a line on a graph that
      // never says anything.
      ...(banner === ''
        ? []
        : [{ key: 'bannerMatched', name: 'Banner matched', unit: '' } satisfies ChannelDef]),
    ];
  },

  async execute(context: CheckContext): Promise<CheckExecution> {
    const { connect } = await import('node:net');

    const host = context.target.host;
    if (host === '') throw new Error('the device has no host to connect to');
    const port = Number(context.params['port'] ?? 0);
    if (!Number.isInteger(port) || port < 1) throw new Error('this sensor names no port');

    const timeoutMs = Number(context.params['timeoutMs'] ?? 5_000);
    const bannerRaw = context.params['banner'];
    const wanted = typeof bannerRaw === 'string' ? bannerRaw.trim() : '';
    const bannerTimeoutMs = Number(context.params['bannerTimeoutMs'] ?? 3_000);
    // Over the device's IP version (`A-85`): the guard is asked for that family alone, and the
    // socket is never told it, so that it still walks every address of it (`lookupFor`).
    const family = familyOf(context.target.ipVersion);

    // The clock starts before the name is resolved, as it did when the socket resolved it: the
    // connect time has always included the lookup.
    const started = process.hrtime.bigint();
    // **Resolved once and checked against the probe's target policy** (`A-57`); the socket's
    // lookup then answers with the checked addresses and the name is not resolved again. A name
    // that did not resolve is said in the guard's words, as every other transport says it
    // (`A-85`): of the device's family where it names one, in the `resolve` phase.
    const checked = await checkedTarget({
      ...guardOf(context.target),
      family,
      timeoutMs,
      signal: context.signal,
      verb: 'connect to',
      doing: `connecting to ${host}:${String(port)}`,
    });

    return new Promise<CheckExecution>((resolve, reject) => {
      let connectedAt: bigint | null = null;
      let banner = '';
      let settled = false;

      const socket = connect({ host, port, ...lookupFor(host, checked, family) });
      socket.setNoDelay(true);

      const finish = (outcome: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        if (bannerTimer !== undefined) clearTimeout(bannerTimer);
        context.signal.removeEventListener('abort', onAbort);
        socket.destroy();
        outcome();
      };

      /** Fails the check; in `phase`, at the device, where it is the connect's (`P-406`). */
      const fail = (message: string, phase?: 'connect', cause?: unknown): void => {
        finish(() => {
          reject(
            phase === undefined
              ? new Error(message)
              : new PhasedError(message, { phase, host }, cause),
          );
        });
      };

      const done = (): void => {
        const elapsed = connectedAt === null ? 0 : Number(connectedAt - started) / 1e6;
        const connectTime = Math.round(elapsed * 100) / 100;
        const matched = wanted === '' || banner.toLowerCase().includes(wanted.toLowerCase());

        if (wanted !== '' && !matched && banner === '') {
          // Distinguished from a mismatch because the fix is different: a silent protocol was
          // asked for a banner it never sends, which is a misconfigured sensor, not a fault.
          fail(
            `${host}:${String(port)} accepted a connection in ${String(connectTime)} ms but said ` +
              `nothing within ${String(bannerTimeoutMs)} ms — this service does not announce ` +
              'itself, so there is no banner to match',
          );
          return;
        }

        finish(() => {
          resolve({
            channels: [
              { key: 'connectTime', value: connectTime },
              ...(wanted === '' ? [] : [{ key: 'bannerMatched', value: matched ? 1 : 0 }]),
            ],
            message:
              `connected in ${String(connectTime)} ms` +
              (wanted === ''
                ? ''
                : matched
                  ? `; banner contains "${wanted}"`
                  : `; banner does not contain "${wanted}" — it said "${clip(banner)}"`),
          });
        });
      };

      const onAbort = (): void => {
        fail(`the check was cancelled while connecting to ${host}:${String(port)}`);
      };
      context.signal.addEventListener('abort', onAbort, { once: true });

      // **The lookup and the connect share the one timeout**, as they did when the socket made
      // the lookup: what the lookup took is taken from what the connect has.
      const spentMs = Number(process.hrtime.bigint() - started) / 1e6;
      const connectTimer = setTimeout(
        () => {
          fail(
            `${host}:${String(port)} did not accept a connection within ${String(timeoutMs)} ms — ` +
              'a port a firewall drops behaves exactly like this, where a closed one is refused ' +
              'immediately',
            'connect',
          );
        },
        Math.max(1, timeoutMs - spentMs),
      );
      connectTimer.unref();

      let bannerTimer: NodeJS.Timeout | undefined;

      socket.on('connect', () => {
        connectedAt = process.hrtime.bigint();
        if (wanted === '') {
          done();
          return;
        }
        bannerTimer = setTimeout(done, bannerTimeoutMs);
        bannerTimer.unref();
      });

      socket.on('data', (chunk: Buffer) => {
        banner += chunk.toString('utf8');
        // A banner is a *line* — SSH, SMTP, FTP, POP3 and IMAP all end theirs with CRLF — so
        // the newline is the signal that it is complete. Waiting out the full banner timeout
        // after it has already arrived would put three seconds on every scan of every port
        // sensor with a banner, for nothing.
        if (banner.includes('\n') || banner.length >= MAX_BANNER_BYTES) done();
      });

      socket.on('error', (error: NodeJS.ErrnoException) => {
        // The code is the diagnosis: refused means nothing is listening, and the alternatives
        // are a filtered port and a name that does not resolve. That one is the socket's own
        // lookup, where nothing checked the name (`none`), and is said as the guard says it.
        // A name whose every address failed is diagnosed by the one that got furthest, and
        // names each (`connectFailure`): its own error says nothing.
        const failure = connectFailure(error);
        const unresolved = socketUnresolved(
          failure.code,
          family,
          `connecting to ${host}:${String(port)}`,
        );
        if (unresolved !== undefined) {
          finish(() => {
            reject(new PhasedError(unresolved, { phase: 'resolve', host }, error));
          });
          return;
        }
        // **Once connected, it is not the connect that failed** (`A-85`'s third check): a reset
        // while the banner is awaited is said as what it is, and in no phase, as before.
        if (connectedAt !== null) {
          fail(
            `${host}:${String(port)} accepted the connection and then failed before its banner ` +
              `was read — ${failure.message}`,
          );
          return;
        }
        const reason =
          failure.code === 'ECONNREFUSED' ? 'nothing is listening on that port' : failure.message;
        fail(
          `could not connect to ${host}:${String(port)} — ${reason}${failure.tried}`,
          'connect',
          error,
        );
      });

      socket.on('end', () => {
        // The service closed after speaking, which is what a banner-and-hang-up protocol does.
        if (connectedAt !== null) done();
      });
    });
  },
};

/** A banner is bytes from the network and a message is read by a person. */
function clip(text: string, limit = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}
