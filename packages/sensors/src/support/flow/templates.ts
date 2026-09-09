/**
 * The template cache NetFlow v9 and IPFIX cannot be decoded without (`B-03`).
 *
 * **This is the whole difficulty of flow collection.** v5 carried its layout in the specification;
 * v9 and IPFIX carry it on the wire, out of band, in template records the exporter sends on its
 * own schedule. A data record is a run of bytes with no self-description whatsoever — without the
 * template that names its fields and their widths it cannot even be split into fields, let alone
 * read. A collector is therefore stateful in a way a v5 collector never was, and everything that
 * can go wrong here is a consequence of that.
 *
 * **Keyed by exporter, observation domain and template id, all three.** Template id 256 from one
 * switch has nothing to do with template id 256 from another, and the same switch may export
 * several observation domains whose ids are independent. Keying on the id alone is the mistake
 * that decodes one device's flows with another's layout and produces confident, wrong numbers
 * rather than an error — which is far worse than dropping them.
 *
 * **A template may be redefined under a live id**, and the last definition wins. Exporters reuse
 * ids after a configuration change, so a cache that refused to overwrite would decode new data
 * with an old layout for as long as the process lived.
 *
 * **Templates expire.** An exporter re-sends them periodically; one that stops has been
 * reconfigured, rebooted or removed, and holding its layout for ever means a cache that only
 * grows and a stale layout waiting to mis-decode something. Expiry is by wall clock since the
 * template was last *seen*, not since it was first learnt, so a live exporter's templates never
 * age out.
 */

/** One field in a template: what it is, and how many bytes it occupies in a data record. */
export interface TemplateField {
  /** IANA Information Element id, or an enterprise-specific id when `enterprise` is set. */
  readonly id: number;
  /** Bytes in the data record. `VARIABLE_LENGTH` means the record carries its own length. */
  readonly length: number;
  /** IPFIX only: the private enterprise number when the element is vendor-specific. */
  readonly enterprise?: number;
}

export interface Template {
  readonly templateId: number;
  readonly fields: readonly TemplateField[];
  /**
   * Bytes one data record occupies, or `undefined` when any field is variable-length.
   *
   * Precomputed because it is needed once per record on the hot path, and a template is written
   * far less often than it is read.
   */
  readonly recordBytes: number | undefined;
  /** When this template was last seen on the wire, for expiry. */
  readonly seenAt: number;
  /** Options templates describe metadata about the export, not traffic (`B-04` may ignore them). */
  readonly kind: 'data' | 'options';
}

/** IPFIX §7: a field length of 65535 means the record carries its own length prefix. */
export const VARIABLE_LENGTH = 0xffff;

export interface TemplateCacheOptions {
  /**
   * How long an unrefreshed template is kept.
   *
   * Thirty minutes because that is Cisco's default template refresh *timeout*, so anything
   * shorter would expire templates from a correctly configured exporter between refreshes and
   * make the collector drop a burst of records every interval for no reason.
   */
  readonly ttlMs?: number;
  /**
   * A ceiling on templates held, across all exporters.
   *
   * **Bounded because the key is attacker-influenced.** Nothing authenticates a flow datagram, so
   * anything that can reach the port can mint templates under invented observation domains until
   * the process dies. Past the ceiling the oldest-seen is evicted, which is also the right answer
   * for the honest case of an exporter cycling through ids.
   */
  readonly maxTemplates?: number;
  readonly now?: () => number;
}

const DEFAULT_TTL_MS = 30 * 60 * 1_000;
const DEFAULT_MAX_TEMPLATES = 10_000;

export interface TemplateCacheStats {
  readonly held: number;
  /** Templates replaced by a new definition under the same key. */
  readonly redefined: number;
  /** Templates dropped because they went unrefreshed for `ttlMs`. */
  readonly expired: number;
  /** Templates dropped to stay under `maxTemplates`. */
  readonly evicted: number;
}

/** What a lookup is keyed by. An id alone is not enough — see the note on the class. */
export interface TemplateKey {
  readonly exporter: string;
  readonly observationDomain: number;
  readonly templateId: number;
}

function keyOf(key: TemplateKey): string {
  return `${key.exporter}|${String(key.observationDomain)}|${String(key.templateId)}`;
}

export class TemplateCache {
  readonly #templates = new Map<string, Template>();
  readonly #ttlMs: number;
  readonly #max: number;
  readonly #now: () => number;
  #redefined = 0;
  #expired = 0;
  #evicted = 0;

  constructor(options: TemplateCacheOptions = {}) {
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#max = Math.max(1, options.maxTemplates ?? DEFAULT_MAX_TEMPLATES);
    this.#now = options.now ?? Date.now;
  }

  /**
   * Records a template, replacing any previous definition under the same key.
   *
   * Re-sending an *identical* template is the normal case and not a redefinition — exporters do
   * it every refresh interval — so only a changed field list counts, or the statistic would
   * report every healthy exporter as constantly reconfiguring itself.
   */
  learn(
    key: TemplateKey,
    fields: readonly TemplateField[],
    kind: 'data' | 'options' = 'data',
  ): Template {
    const id = keyOf(key);
    const existing = this.#templates.get(id);
    if (existing !== undefined && !sameFields(existing.fields, fields)) this.#redefined += 1;

    const template: Template = {
      templateId: key.templateId,
      fields,
      recordBytes: fields.some((field) => field.length === VARIABLE_LENGTH)
        ? undefined
        : fields.reduce((total, field) => total + field.length, 0),
      seenAt: this.#now(),
      kind,
    };
    this.#templates.set(id, template);
    this.#evictIfFull();
    return template;
  }

  /** The template for this key, or `undefined` if it was never seen or has expired. */
  get(key: TemplateKey): Template | undefined {
    const id = keyOf(key);
    const template = this.#templates.get(id);
    if (template === undefined) return undefined;
    if (this.#now() - template.seenAt > this.#ttlMs) {
      this.#templates.delete(id);
      this.#expired += 1;
      return undefined;
    }
    return template;
  }

  /**
   * Drops every template an exporter holds.
   *
   * For a reboot: a device that restarts may reuse ids for different layouts, and its old
   * templates decoding its new data is the silent-corruption case this whole module is arranged
   * to avoid.
   */
  forget(exporter: string): number {
    let dropped = 0;
    for (const [id, template] of this.#templates) {
      if (id.startsWith(`${exporter}|`)) {
        this.#templates.delete(id);
        void template;
        dropped += 1;
      }
    }
    return dropped;
  }

  stats(): TemplateCacheStats {
    return {
      held: this.#templates.size,
      redefined: this.#redefined,
      expired: this.#expired,
      evicted: this.#evicted,
    };
  }

  /** Oldest-seen first, which is both the anti-flood answer and the right one for id churn. */
  #evictIfFull(): void {
    while (this.#templates.size > this.#max) {
      let oldestId: string | undefined;
      let oldestAt = Infinity;
      for (const [id, template] of this.#templates) {
        if (template.seenAt < oldestAt) {
          oldestAt = template.seenAt;
          oldestId = id;
        }
      }
      if (oldestId === undefined) return;
      this.#templates.delete(oldestId);
      this.#evicted += 1;
    }
  }
}

function sameFields(a: readonly TemplateField[], b: readonly TemplateField[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((field, i) => {
    const other = b[i];
    return (
      other !== undefined &&
      field.id === other.id &&
      field.length === other.length &&
      field.enterprise === other.enterprise
    );
  });
}
