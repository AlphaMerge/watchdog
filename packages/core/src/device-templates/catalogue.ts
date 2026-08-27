import { AppError, type Fingerprint } from '@ms/shared';
import {
  applicableSensors,
  matchTemplates,
  validateTemplate,
  type DeviceTemplate,
  type SensorSpec,
  type TemplateMatchResult,
} from './definition.js';

export class DeviceTemplateError extends AppError {
  constructor(message: string, context: Record<string, string | number>) {
    super('DEVICE_TEMPLATE_INVALID', message, { context });
    this.name = 'DeviceTemplateError';
  }
}

/** A template that could not be used, and why. Kept so the API can report it. */
export interface TemplateProblem {
  readonly id: string;
  readonly source: string;
  readonly problems: readonly string[];
}

export interface TemplateSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly sensorCount: number;
  readonly overridesBuiltIn: boolean;
  readonly source: string;
}

interface Held {
  readonly template: DeviceTemplate;
  readonly source: string;
  readonly overridesBuiltIn: boolean;
}

/**
 * Every device template this installation can use (`D-03`).
 *
 * The same shape as the lookup catalogue and for the same reasons: built-ins register first, an
 * operator's file with the same id replaces one, and **a bad template is refused rather than
 * repaired** — recorded in `problems()` with the reason, which the API serves. The failure this
 * avoids is silent: a template that half-loaded would create some of the sensors it names and
 * nobody would notice which ones were missing until the day one of them mattered.
 */
export class DeviceTemplateCatalogue {
  readonly #held = new Map<string, Held>();
  readonly #problems: TemplateProblem[] = [];
  readonly #knownSensorType: (id: string) => boolean;
  #sealed = false;

  constructor(knownSensorType: (id: string) => boolean) {
    this.#knownSensorType = knownSensorType;
  }

  get sealed(): boolean {
    return this.#sealed;
  }

  /** Refuses a bad template and records why. Throws only for a rule this file cannot recover from. */
  register(template: DeviceTemplate, source: string): void {
    if (this.#sealed) {
      throw new DeviceTemplateError('the template catalogue is sealed', { id: template.id });
    }
    const problems = validateTemplate(template, this.#knownSensorType);
    if (problems.length > 0) {
      this.#problems.push({ id: template.id, source, problems });
      return;
    }
    this.#held.set(template.id, {
      template,
      source,
      overridesBuiltIn: this.#held.has(template.id),
    });
  }

  seal(): this {
    this.#sealed = true;
    return this;
  }

  get(id: string): DeviceTemplate | null {
    return this.#held.get(id)?.template ?? null;
  }

  all(): DeviceTemplate[] {
    return [...this.#held.values()].map((one) => one.template);
  }

  problems(): readonly TemplateProblem[] {
    return this.#problems;
  }

  summaries(): TemplateSummary[] {
    return [...this.#held.values()]
      .map((one) => ({
        id: one.template.id,
        name: one.template.name,
        description: one.template.description,
        sensorCount: one.template.sensors.length,
        overridesBuiltIn: one.overridesBuiltIn,
        source: one.source,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Every template that applies to this fingerprint, most specific first. */
  match(fingerprint: Fingerprint): TemplateMatchResult[] {
    return matchTemplates(fingerprint, this.all());
  }

  /**
   * The sensors every matching template would create, deduplicated.
   *
   * **Deduplicated by type *and* parameters**, because a device is genuinely several things at
   * once and two templates naming `icmp.ping` mean one Ping sensor, while two naming
   * `http.request` on different paths mean two. Deduplicating by type alone would silently drop
   * the second, and deduplicating by nothing would create two identical Ping sensors on every
   * Linux web server in the estate.
   *
   * The most specific template wins a tie, because it went first and the first spelling of a key
   * is the one kept — so a vendor template's `snmp.cpu` with the right OIDs beats the generic
   * one's.
   */
  plan(
    fingerprint: Fingerprint,
    availableCredentials: ReadonlySet<string> = new Set(),
  ): { sensors: SensorSpec[]; templates: TemplateMatchResult[]; tags: string[] } {
    const matched = this.match(fingerprint);
    const sensors: SensorSpec[] = [];
    const seen = new Set<string>();
    const tags = new Set<string>();

    for (const { template } of matched) {
      for (const tag of template.tags ?? []) tags.add(tag);
      for (const spec of applicableSensors(template, fingerprint, availableCredentials)) {
        const key = `${spec.type}:${stableJson(spec.params ?? {})}`;
        if (seen.has(key)) continue;
        seen.add(key);
        sensors.push(spec);
      }
    }
    return { sensors, templates: matched, tags: [...tags].sort() };
  }
}

/**
 * JSON with its keys in order, so two specs that differ only in key order are one spec.
 *
 * `JSON.stringify` preserves insertion order, and two templates written by two people will not
 * agree on it — so without this, `{scheme, port}` and `{port, scheme}` would be two sensors on
 * every device both templates matched.
 */
function stableJson(value: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))),
  );
}
