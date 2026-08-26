import { Ajv, type ValidateFunction } from 'ajv';
import { AppError } from '@ms/shared';
import type { SensorState } from '../state/tables.js';

/**
 * What kinds of trigger exist, and what each one needs (`N-01`).
 *
 * Declared the way sensor types are declared, and for the same reasons: the JSON Schema
 * generates the form, validates the API and documents the field in one place, so adding
 * `[V2]`'s speed, volume and change triggers is a one-file job rather than a migration and a
 * column set. Nothing here decides *when* a trigger fires — that is `N-02` and `N-03`; this is
 * the shape the storage keeps and the boundary refuses bad input at.
 */
export interface TriggerKind {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** JSON Schema for `notification_trigger.settings`. */
  readonly settingsSchema: Record<string, unknown>;
  /** Which template fields the settings carry, so `N-05` can find references without parsing. */
  readonly templateFields: readonly string[];
  /** One line an operator reads on the trigger tab, built from the settings. */
  describe(settings: Record<string, unknown>): string;
}

/**
 * Settings that failed their kind's schema, or a kind this build does not have.
 *
 * `problems` is its own field rather than something handed to `AppError`: that constructor
 * takes a scalar-only `context` and nothing else, so a `details` bag passed to it is silently
 * dropped — and a validation error whose reasons vanish is a form that just refuses.
 * `ObjectError` carries its own `details` for the same reason.
 */
export class TriggerError extends AppError {
  readonly details: Readonly<{ problems: string[] }>;

  constructor(message: string, context: Record<string, string | number>, problems?: string[]) {
    super('TRIGGER_INVALID', message, { context });
    this.name = 'TriggerError';
    this.details = { problems: problems ?? [] };
  }
}

/**
 * One settings value as text.
 *
 * Narrowed rather than `String()`d: `settings` is `unknown`-valued by construction, and an
 * object reaching a summary line renders as `[object Object]` — a sentence on the trigger tab
 * that says nothing and looks like a bug in the trigger rather than in the description. A
 * validated setting is always a string or a number; anything else means the schema let it
 * through, and `?` says so plainly.
 */
function text(value: unknown, fallback = '?'): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : fallback;
}

/** A template reference, or none. `N-05` is what makes an id resolve to anything. */
const templateRef = { type: ['integer', 'null'], minimum: 1 } as const;

/**
 * The states a trigger can be configured for.
 *
 * `CAPABILITIES.MD §5.1`'s list, minus the two marked `[V2]`: `unusual` and `down_partial` are
 * states nothing in v1 reaches, and a form field for a trigger that could never fire is worse
 * than a missing one — it looks configured.
 *
 * It is deliberately *not* `V1_STATES`. Two of those are reachable and still not offered here.
 * `paused` is a state an operator puts a sensor into on purpose, so a notification about it is a
 * notification about one's own action. `down_acknowledged` is stranger still: acknowledging is
 * how an operator *stops* being told, and a trigger on it would notify about the suppression of
 * a notification. Neither is in the contract, and `N-16` is where the question goes if anyone
 * ever wants them. The engine still has to know about `down_acknowledged` — a `down` trigger
 * must not re-fire when the Down is acknowledged — but that is `N-02`'s problem, not a setting.
 */
export const TRIGGERABLE_STATES = [
  'down',
  'warning',
  'up',
  'unknown',
] as const satisfies readonly SensorState[];

/**
 * The state trigger (`CAPABILITIES.MD §5.1`).
 *
 * Six settings, and the shape of a whole escalation chain: notify after the state has held for
 * the initial latency, escalate if it is still holding later, repeat while it holds, and say so
 * when it recovers. `WORKFLOW.MD §6`'s "a 30-second blip on a five-minute latency produces no
 * notification at all" is a statement about `initialLatencySeconds` and nothing else.
 */
export const STATE_TRIGGER: TriggerKind = {
  id: 'state',
  name: 'State trigger',
  description: 'Notifies when a sensor enters a state and stays in it.',
  templateFields: ['initialTemplateId', 'escalationTemplateId', 'recoveryTemplateId'],
  settingsSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['state'],
    properties: {
      state: { enum: [...TRIGGERABLE_STATES] },
      /** Seconds the state must hold before anything is sent. Zero is immediate. */
      initialLatencySeconds: { type: 'integer', minimum: 0, maximum: 86_400, default: 0 },
      initialTemplateId: templateRef,
      /** Zero means no escalation, which is why it is not `null` — it is a duration. */
      escalationLatencySeconds: { type: 'integer', minimum: 0, maximum: 604_800, default: 0 },
      escalationTemplateId: templateRef,
      /** Minutes between repeats while the state holds. Zero means send once. */
      repeatMinutes: { type: 'integer', minimum: 0, maximum: 10_080, default: 0 },
      recoveryTemplateId: templateRef,
    },
  },
  describe(settings) {
    const state = text(settings['state']);
    const latency = Number(settings['initialLatencySeconds'] ?? 0);
    const held = latency === 0 ? 'immediately' : `after ${String(latency)}s`;
    const escalation = Number(settings['escalationLatencySeconds'] ?? 0);
    const repeat = Number(settings['repeatMinutes'] ?? 0);
    return [
      `when ${state}, notify ${held}`,
      escalation > 0 ? `escalate after ${String(escalation)}s` : null,
      repeat > 0 ? `repeat every ${String(repeat)}m` : null,
    ]
      .filter((part): part is string => part !== null)
      .join('; ');
  },
};

/**
 * The threshold trigger (`CAPABILITIES.MD §5.1`).
 *
 * Deliberately not the same thing as a channel limit (`M-04`). A limit decides the sensor's
 * *state* — it is what makes a sensor Down — and everyone who looks at the sensor sees it. A
 * threshold trigger decides who gets *told*, without changing what the sensor is. An operator
 * who wants "page me at 80% but do not call the disk Down until 95%" needs both, and conflating
 * them would make one of those impossible.
 */
export const THRESHOLD_TRIGGER: TriggerKind = {
  id: 'threshold',
  name: 'Threshold trigger',
  description: 'Notifies when a channel crosses a value, without changing the sensor’s state.',
  templateFields: ['triggerTemplateId', 'clearTemplateId'],
  settingsSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['channelKey', 'condition', 'value'],
    properties: {
      channelKey: { type: 'string', minLength: 1, maxLength: 100 },
      condition: { enum: ['above', 'below', 'equal', 'notEqual'] },
      value: { type: 'number' },
      latencySeconds: { type: 'integer', minimum: 0, maximum: 86_400, default: 0 },
      triggerTemplateId: templateRef,
      clearTemplateId: templateRef,
    },
  },
  describe(settings) {
    const symbols: Record<string, string> = {
      above: '>',
      below: '<',
      equal: '=',
      notEqual: '≠',
    };
    const condition = text(settings['condition']);
    const latency = Number(settings['latencySeconds'] ?? 0);
    const held = latency === 0 ? '' : ` for ${String(latency)}s`;
    const channel = text(settings['channelKey']);
    return `when ${channel} ${symbols[condition] ?? condition} ${text(settings['value'])}${held}`;
  },
};

const KINDS: readonly TriggerKind[] = [STATE_TRIGGER, THRESHOLD_TRIGGER];

const ajv = new Ajv({ allErrors: true, strict: false, useDefaults: true });

/**
 * The kinds this build knows, and the one place a trigger's settings are checked.
 *
 * Sealed at module load rather than registered at runtime: a kind appearing later would mean two
 * halves of the system disagreeing about what a stored trigger means.
 */
class Registry {
  /**
   * Kind and validator in one entry, deliberately.
   *
   * Two maps keyed the same way would admit a state neither half could handle — a kind whose
   * validator is missing — and the only honest thing to do about it would be to assert it away.
   */
  readonly #entries = new Map<string, { kind: TriggerKind; validate: ValidateFunction }>();

  constructor(kinds: readonly TriggerKind[]) {
    for (const kind of kinds) {
      if (this.#entries.has(kind.id)) throw new Error(`duplicate trigger kind ${kind.id}`);
      this.#entries.set(kind.id, { kind, validate: ajv.compile(kind.settingsSchema) });
    }
  }

  get ids(): string[] {
    return [...this.#entries.keys()];
  }

  all(): TriggerKind[] {
    return [...this.#entries.values()].map((entry) => entry.kind);
  }

  get(id: string): TriggerKind {
    return this.#entry(id).kind;
  }

  #entry(id: string): { kind: TriggerKind; validate: ValidateFunction } {
    const entry = this.#entries.get(id);
    if (entry === undefined) {
      throw new TriggerError(`no trigger kind "${id}"`, { kind: id }, [
        `known kinds: ${this.ids.join(', ')}`,
      ]);
    }
    return entry;
  }

  /**
   * Validates settings against their kind, filling in the schema's defaults.
   *
   * Returns a *copy*: `useDefaults` mutates, and a caller handing in a frozen literal or reusing
   * an object across two triggers should not have it quietly grow fields.
   */
  validate(kindId: string, settings: Record<string, unknown>): Record<string, unknown> {
    const { validate } = this.#entry(kindId);
    const copy: Record<string, unknown> = { ...settings };
    if (!validate(copy)) {
      const problems = (validate.errors ?? []).map(
        (error) =>
          `${error.instancePath === '' ? 'settings' : error.instancePath} ${
            error.message ?? 'is invalid'
          }`,
      );
      throw new TriggerError(`this ${kindId} trigger cannot be saved`, { kind: kindId }, problems);
    }
    return copy;
  }

  /** Every template this trigger references, so `N-05` can refuse to delete one in use. */
  templatesIn(kindId: string, settings: Record<string, unknown>): number[] {
    const kind = this.get(kindId);
    const found: number[] = [];
    for (const field of kind.templateFields) {
      const value = settings[field];
      if (typeof value === 'number') found.push(value);
    }
    return found;
  }
}

export const triggerKinds = new Registry(KINDS);
