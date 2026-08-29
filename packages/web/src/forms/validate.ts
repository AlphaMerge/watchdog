import type { FieldModel, JsonSchema } from './schema';

export interface FieldProblem {
  readonly path: string;
  readonly message: string;
}

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

  const missing =
    value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
  if (missing) {
    // A write-only field left alone is not missing: the value is on the server, where this form
    // is never allowed to see it.
    if (field.required && !field.writeOnly) add('required');
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
    const items = field.items;
    entries.forEach((_entry, index) => {
      problems.push(
        ...allProblems(fieldsFor(items, `${field.path}.${String(index)}`), values, read, fieldsFor),
      );
    });
  }
  return problems;
}
