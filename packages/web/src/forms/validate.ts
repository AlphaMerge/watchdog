import { hasScalarEntries, scalarEntryOf, type FieldModel, type JsonSchema } from './schema';

export interface FieldProblem {
  readonly path: string;
  readonly message: string;
}

/** What a cleared entry the schema will not take is told (`U-41`, `U-44`). */
const EMPTY_ENTRY = 'cannot be empty: type a value, or remove the entry';

/**
 * Checks a value against the constraints its schema declares.
 *
 * **This is a convenience, not the validator.** The core validates every write against the same
 * schema with Ajv and is the authority; `CLAUDE.md` puts validation at the boundary and this is
 * not the boundary. What it buys is that an operator who typed 70000 into a port learns so
 * before they submit, rather than reading a 400 that names a path.
 *
 * It deliberately checks *less* than Ajv rather than differently. Two validators that disagree
 * are worse than one, so anything subtle — combinators, formats, conditional schemas — is left
 * to the server, which will refuse it with a message naming the path.
 */
export function problemsFor(field: FieldModel, value: unknown): FieldProblem[] {
  const problems: FieldProblem[] = [];
  const add = (message: string): void => {
    problems.push({ path: field.path, message });
  };

  // **A string entry's `''` is a value, not a gap** (`U-41`). An entry cleared holds it, and Ajv
  // judges it as any other string: `exe.script`'s and the program method's `args` declare no
  // `minLength`, so an empty argument is an argument and is passed as one, while `dns.blocklist`'s
  // zones, `windows.volume`'s drives and a credential set's targets and host keys refuse it. So
  // here it is checked against the same keywords, and "required" — which an entry always is,
  // being unable to be absent — never stands in for them.
  const stringEntry = field.entry && field.kind === 'string' && typeof value === 'string';
  const missing =
    value === undefined ||
    value === null ||
    (typeof value === 'string' && value.trim() === '' && !stringEntry);
  if (missing) {
    // A write-only field left alone is not missing: the value is on the server, where this form
    // is never allowed to see it.
    //
    // **A cleared entry is told what to do, not that it is "required"** (`U-44`). A number or
    // JSON entry emptied holds `''` (`U-41`), which is no number and no JSON; "required" is true
    // of every entry and says nothing to someone who has just emptied the box, while the entry's
    // own Remove sits above it. The same sentence a cleared string entry gets.
    if (field.required && !field.writeOnly) {
      add(field.entry && value === '' ? EMPTY_ENTRY : 'required');
    }
    return problems;
  }

  const { schema } = field;

  if (field.kind === 'integer' || field.kind === 'number') {
    if (typeof value !== 'number' || Number.isNaN(value)) {
      add('must be a number');
      return problems;
    }
    if (field.kind === 'integer' && !Number.isInteger(value)) add('must be a whole number');
    if (schema.minimum !== undefined && value < schema.minimum) {
      add(`must be ${String(schema.minimum)} or more`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      add(`must be ${String(schema.maximum)} or less`);
    }
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
      add(`must be more than ${String(schema.exclusiveMinimum)}`);
    }
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) {
      add(`must be less than ${String(schema.exclusiveMaximum)}`);
    }
  }

  if (field.kind === 'string' && typeof value === 'string') {
    // Said as what it is and what to do: the entry's own Remove sits above it, and "must be at
    // least 3 characters" for a box the operator has just emptied reads as a complaint about
    // something they did not type.
    if (stringEntry && value === '' && (schema.minLength ?? 0) > 0) {
      add(EMPTY_ENTRY);
      return problems;
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      add(`must be at least ${String(schema.minLength)} characters`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      add(`must be at most ${String(schema.maxLength)} characters`);
    }
    if (schema.pattern !== undefined && !matches(schema.pattern, value)) {
      add(`does not match ${schema.pattern}`);
    }
  }

  if (field.kind === 'enum' && schema.enum !== undefined && !schema.enum.includes(value)) {
    add('is not one of the allowed values');
  }

  if (field.kind === 'array' && Array.isArray(value)) {
    // The count only. What is *in* each entry is checked as its own field, at its own path, by
    // the same walk that checks everything else — a second opinion here would report the same
    // fault twice, once against a control and once against the fieldset around it.
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      add(`needs at least ${String(schema.minItems)}`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      add(`takes at most ${String(schema.maxItems)}`);
    }
  }

  return problems;
}

/**
 * A schema `pattern` is an ECMA-262 regex, which is what this engine speaks — but it arrives
 * from a sensor type's declaration and an unparseable one must not take the form down with it.
 * An unusable pattern is left to the server, which has the same string and Ajv's own opinion.
 */
function matches(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern, 'u').test(value);
  } catch {
    return true;
  }
}

/** Every problem across a field tree, so a form can refuse to submit and say why. */
export function allProblems(
  fields: readonly FieldModel[],
  values: Record<string, unknown>,
  read: (values: Record<string, unknown>, path: string) => unknown,
  fieldsFor: (schema: JsonSchema, prefix: string) => FieldModel[] = () => [],
): FieldProblem[] {
  const problems: FieldProblem[] = [];
  for (const field of fields) {
    if (field.kind === 'object') {
      problems.push(...allProblems(field.children, values, read, fieldsFor));
      continue;
    }
    problems.push(...problemsFor(field, read(values, field.path)));

    // **Into each entry, at the path the form gave it** (`U-12`). Without this a form would
    // submit an array whose entries are missing required properties and learn so from a 400 —
    // which is exactly the round trip this convenience exists to save, and it would be missing
    // for the one parameter shape that is hardest to type correctly.
    const entries = read(values, field.path);
    if (field.kind !== 'array' || field.items === undefined || !Array.isArray(entries)) continue;
    //
    // **An entry of scalars too** (`U-41`), as the one field the form renders for it. These were
    // never checked before submit, so a cleared blocklist zone went to the core and came back as
    // a 400; now its `''` is judged here, at the entry's path, by the same rules as its control.
    const items = field.items;
    const array = field;
    entries.forEach((_entry, index) => {
      const entryFields = hasScalarEntries(items)
        ? [scalarEntryOf(items, array, index)]
        : fieldsFor(items, `${field.path}.${String(index)}`);
      problems.push(...allProblems(entryFields, values, read, fieldsFor));
    });
  }
  return problems;
}
