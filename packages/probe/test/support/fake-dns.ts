import type { DnsAsker, DnsChannel, DnsReplyKind } from '../../src/resolver/dns-check.js';
import type { Family } from '../../src/resolver/name-resolver.js';
import {
  candidatesOf,
  typesFor,
  type NameClass,
  type PolicyView,
  type QType,
  type ResolvConf,
} from '../../src/resolver/system-names.js';
import { StubPolicy } from './fake-helper.js';

/**
 * What the name check asks DNS with, played by a test (`P-432` S6): each question answered as the
 * test's rule says, at once, after a real delay, or never (`silent`), until the test answers it
 * by hand (`release`). Every question asked is kept, with its server.
 */

/** What one question gets: a reply, a reply after a real delay, or nothing until released. */
export type ScriptedReply =
  DnsReplyKind | 'silent' | { readonly reply: DnsReplyKind; readonly delayMs: number };

export interface AskedQuestion {
  readonly server: string;
  readonly name: string;
  readonly type: QType;
  /** Answers a silent question now. */
  readonly release: (reply: DnsReplyKind) => void;
  replied: DnsReplyKind | undefined;
}

export class ScriptedAsker implements DnsAsker {
  rule: (server: string, name: string, type: QType) => ScriptedReply = () => 'answer';
  readonly asked: AskedQuestion[] = [];
  channels = 0;
  closed = 0;

  channel(server: string): DnsChannel {
    this.channels += 1;
    return {
      ask: (name, type) =>
        new Promise<DnsReplyKind>((resolve) => {
          const question: AskedQuestion = {
            server,
            name,
            type,
            replied: undefined,
            release: (reply) => {
              if (question.replied !== undefined) return;
              question.replied = reply;
              resolve(reply);
            },
          };
          this.asked.push(question);
          const said = this.rule(server, name, type);
          if (said === 'silent') return;
          if (typeof said === 'string') {
            question.release(said);
            return;
          }
          setTimeout(() => {
            question.release(said.reply);
          }, said.delayMs).unref();
        }),
      close: () => {
        this.closed += 1;
      },
    };
  }

  /** The questions asked for a name, by any server. */
  askedFor(name: string): AskedQuestion[] {
    return this.asked.filter((question) => question.name === name);
  }

  /** The names asked, in order, the canary left out. */
  names(): string[] {
    return this.asked.filter((q) => q.name !== 'localhost.').map((q) => `${q.name} ${q.type}`);
  }
}

export const CONF: ResolvConf = {
  servers: ['10.0.0.53'],
  search: [],
  searchFrom: 'none',
  options: { ndots: 1, timeout: 5, attempts: 2, rotate: false, edns0: false, trustAd: false },
};

/**
 * A name policy whose check is on: every name the test does not call local is walked, with the
 * candidates `candidatesOf` gives under the test's resolv.conf.
 */
export class WalkPolicy extends StubPolicy {
  conf: ResolvConf = CONF;

  constructor() {
    super();
    this.off = undefined;
  }

  override classify(host: string, family: Family): NameClass {
    if (this.local(host, family)) return { kind: 'local', via: 'hosts' };
    if (this.off !== undefined) return { kind: 'off', reason: this.off };
    const candidates = candidatesOf(host, this.conf);
    if (candidates === undefined) return { kind: 'cannotVouch', reason: 'candidate' };
    return { kind: 'walk', candidates, types: typesFor(family) };
  }

  override view(): PolicyView {
    return { ...super.view(), conf: this.conf, line: 'files dns' };
  }
}
