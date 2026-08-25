import { Ajv, type ValidateFunction } from 'ajv';
import { AppError } from '@ms/shared';
import { lookupDefinitionSchema, validateLookup, type LookupDefinition } from './definition.js';

export class LookupError extends AppError {
  constructor(message: string, context: Record<string, string | number>) {
    super('LOOKUP_INVALID', message, { context });
    this.name = 'LookupError';
  }
}

/** A definition that could not be used, and why. Kept so the API can report it. */
export interface LookupProblem {
  /** The id if it could be read, or the file it came from. */
  readonly id: string;
  readonly source: string;
  readonly problems: readonly string[];
}

/** What the UI needs to show a lookup without evaluating anything. */
export interface LookupSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly type: LookupDefinition['type'];
  readonly undefinedState: LookupDefinition['undefinedState'];
  readonly entryCount: number;
  /** True when an operator's file replaced a definition this build ships. */
  readonly overridesBuiltIn: boolean;
  readonly source: string;
}

interface Held {
  readonly definition: LookupDefinition;
  readonly source: string;
  readonly overridesBuiltIn: boolean;
}

const ajv = new Ajv({ allErrors: true, strict: false });

/**
 * Every lookup this installation can use (`M-06`).
 *
 * Built-ins first, then whatever an operator dropped in `<dataDir>/lookups` — a custom
 * definition with the same id replaces the shipped one, which is `CAPABILITIES.MD §1.2`'s
 * "`\lookups\custom` overriding built-ins by matching `id`" without the XML.
 *
 * **A bad definition is refused, not repaired.** It is recorded in `problems()` with the reason,
 * and the API serves that list, because the failure mode this avoids is silent: a lookup that
 * fails to load leaves its channels judged by nothing at all, and a sensor that reads Up because
 * its status lookup never loaded is worse than one that reads Unknown.
 */
export class LookupCatalogue {
  readonly #held = new Map<string, Held>();
  readonly #problems: LookupProblem[] = [];
  readonly #builtInIds = new Set<string>();
  readonly #validate: ValidateFunction = ajv.compile(lookupDefinitionSchema);
  #sealed = false;

  /**
   * Adds a definition, or records why it could not be added.
   *
   * Returns whether it was taken. Never throws for bad *content* — the loader is walking a
   * directory an operator controls, and one unusable file must not stop the other twenty.
   */
  register(definition: LookupDefinition, source: string, builtIn = false): boolean {
    if (this.#sealed) {
      throw new LookupError('the lookup catalogue is sealed', { id: definition.id });
    }

    const problems: string[] = [];
    if (!this.#validate(definition)) {
      problems.push(
        ...(this.#validate.errors ?? []).map(
          (error) =>
            `${error.instancePath === '' ? 'the definition' : error.instancePath} ${error.message ?? 'is invalid'}`,
        ),
      );
    }
    problems.push(...validateLookup(definition));

    if (problems.length > 0) {
      this.#problems.push({ id: definition.id, source, problems });
      return false;
    }

    const replacing = this.#held.get(definition.id);
    if (replacing !== undefined && !builtIn && !this.#builtInIds.has(definition.id)) {
      // Two custom files claiming one id. Which one wins would be directory order, which is not
      // a decision anybody made.
      this.#problems.push({
        id: definition.id,
        source,
        problems: [`another definition already claims this id (${replacing.source})`],
      });
      return false;
    }

    if (builtIn) this.#builtInIds.add(definition.id);
    this.#held.set(definition.id, {
      definition,
      source,
      overridesBuiltIn: !builtIn && this.#builtInIds.has(definition.id),
    });
    return true;
  }

  /**
   * Records a definition that never got as far as being one — a file that is not JSON, say.
   *
   * Separate from `register` because there is nothing to validate: the failure happened before
   * a definition existed. It still belongs in `problems()`, because an operator debugging a
   * lookup should find it beside the ones that loaded rather than in the journal.
   */
  refuse(id: string, source: string, problems: readonly string[]): void {
    this.#problems.push({ id, source, problems: [...problems] });
  }

  /** No further registration, so a lookup appearing later cannot change a live sensor's state. */
  seal(): this {
    this.#sealed = true;
    return this;
  }

  get sealed(): boolean {
    return this.#sealed;
  }

  has(id: string): boolean {
    return this.#held.has(id);
  }

  get(id: string): LookupDefinition | undefined {
    return this.#held.get(id)?.definition;
  }

  ids(): readonly string[] {
    return [...this.#held.keys()].sort();
  }

  problems(): readonly LookupProblem[] {
    return this.#problems;
  }

  summaries(): readonly LookupSummary[] {
    return [...this.#held.values()]
      .map((held) => ({
        id: held.definition.id,
        name: held.definition.name,
        description: held.definition.description ?? '',
        type: held.definition.type,
        undefinedState: held.definition.undefinedState,
        entryCount: held.definition.entries.length,
        overridesBuiltIn: held.overridesBuiltIn,
        source: held.source,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }
}
