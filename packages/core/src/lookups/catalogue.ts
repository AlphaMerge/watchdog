import { Ajv, type ValidateFunction } from 'ajv';
import {
  AppError,
  patternMessageKeyword,
  patternMessageOf,
  unsaidPatternProblem,
} from '@ms/shared';
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
  /** Whether *this* entry is a built-in, as opposed to an id that has one somewhere (`P-100`). */
  readonly builtIn: boolean;
}

// `verbose` puts a failed pattern's schema on its error, which is where its `x-patternMessage` is
// read (`P-377`); it puts the value there too, and `register` reads only the path and the message.
const ajv = new Ajv({
  allErrors: true,
  strict: false,
  verbose: true,
  keywords: [patternMessageKeyword()],
});

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
  readonly #validate: ValidateFunction;
  #sealed = false;

  /**
   * `definitionSchema` is what a definition is held to: `lookupDefinitionSchema`, always, outside
   * the test that a schema with a pattern and no sentence is refused here (`P-377`). Refused by
   * throwing, unlike a bad definition: that is this build's own mistake, not an operator's file.
   */
  constructor(definitionSchema: object = lookupDefinitionSchema) {
    // As the sensor catalogue and the method registry refuse one (`U-53`, `P-372`): a lookup
    // file refused by a pattern would be told the expression in `problems()`.
    const unsaid = unsaidPatternProblem(definitionSchema, 'the lookup schema', 'a definition');
    if (unsaid !== undefined) throw new LookupError(unsaid, {});
    this.#validate = ajv.compile(definitionSchema);
  }

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
            // A pattern's own sentence (`P-377`), read from the schema and never from `data`.
            `${error.instancePath === '' ? 'the definition' : error.instancePath} ${
              patternMessageOf(error) ?? error.message ?? 'is invalid'
            }`,
        ),
      );
    }
    problems.push(...validateLookup(definition));

    if (problems.length > 0) {
      this.#problems.push({ id: definition.id, source, problems });
      return false;
    }

    const replacing = this.#held.get(definition.id);
    // **What is being refused is a second *custom* file, not a second registration** (`P-100`).
    // This used to ask `!this.#builtInIds.has(definition.id)`, which is a question about the id
    // rather than about what currently holds it — and `#builtInIds` is never cleared, so for
    // any id this build ships the guard was permanently disabled. Two operator files claiming
    // `ms.snmp.if-oper-status` were silently resolved by directory order, and renaming a file
    // changed which one judged every interface sensor in the installation. The same mistake on
    // an id with no built-in was correctly refused, which is what made it invisible.
    if (replacing !== undefined && !builtIn && !replacing.builtIn) {
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
      builtIn,
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
