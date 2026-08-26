import { useState } from 'react';
import type { FieldModel } from './schema';

/**
 * One control for one schema-described value (`U-08`).
 *
 * Extracted so the generated sensor-parameter form and `U-09`'s inheritable settings render the
 * same controls from the same rules. Two places deciding what an `integer` with a `minimum` looks
 * like is two places to fix when one of them is wrong.
 */

/**
 * An enum entry as an option's value.
 *
 * A schema may in principle enumerate objects, and `String({})` is `[object Object]` — which
 * would give every such entry the same option value and make the select unusable rather than
 * merely ugly. JSON keeps them distinct, and the choice is matched back to the schema's own
 * entry anyway, so nothing depends on this being readable in that case.
 */
function optionOf(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'symbol' || typeof value === 'function') return '';
  // Only a string, number, boolean or bigint reaches here, by the checks above — which is
  // exactly the case String() is for, and the one the rule is not about.
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  return String(value);
}

const INPUT_CLASS =
  'rounded border bg-surface px-2 py-1 text-sm text-text focus:outline-none focus-visible:ring-2 focus-visible:ring-accent';

export function SchemaControl({
  id,
  field,
  value,
  disabled,
  describedBy,
  invalid,
  onValue,
  onBlur,
}: {
  id: string;
  field: FieldModel;
  value: unknown;
  disabled: boolean;
  describedBy: string;
  invalid: boolean;
  onValue: (next: unknown) => void;
  onBlur: () => void;
}): React.JSX.Element {
  const border = invalid ? 'border-down-border' : 'border-border';
  const shared = {
    id,
    disabled,
    onBlur,
    'aria-describedby': describedBy === '' ? undefined : describedBy,
    'aria-invalid': invalid ? true : undefined,
  };

  if (field.kind === 'boolean') {
    return (
      <input
        {...shared}
        type="checkbox"
        checked={value === true}
        onChange={(event) => {
          onValue(event.target.checked);
        }}
        className="h-4 w-4"
      />
    );
  }

  if (field.kind === 'enum') {
    return (
      <select
        {...shared}
        value={optionOf(value)}
        onChange={(event) => {
          // Matched back to the schema's own entry rather than parsed: an enum of `[1, 2]` must
          // save the number 1, and `String(1)` is not it.
          const chosen = field.schema.enum?.find((entry) => optionOf(entry) === event.target.value);
          onValue(chosen);
        }}
        className={`w-64 ${INPUT_CLASS} ${border}`}
      >
        {!field.required && <option value="">—</option>}
        {(field.schema.enum ?? []).map((entry) => (
          <option key={optionOf(entry)} value={optionOf(entry)}>
            {optionOf(entry)}
          </option>
        ))}
      </select>
    );
  }

  if (field.kind === 'integer' || field.kind === 'number') {
    return (
      <input
        {...shared}
        type="number"
        inputMode={field.kind === 'integer' ? 'numeric' : 'decimal'}
        step={field.kind === 'integer' ? 1 : 'any'}
        min={field.schema.minimum}
        max={field.schema.maximum}
        value={typeof value === 'number' ? String(value) : ''}
        onChange={(event) => {
          const raw = event.target.value;
          // An empty box means "not set", not zero. `Number('')` is 0, which would quietly write
          // a parameter the operator was in the middle of clearing.
          if (raw === '') {
            onValue(undefined);
            return;
          }
          const parsed = Number(raw);
          onValue(Number.isNaN(parsed) ? raw : parsed);
        }}
        className={`w-40 tabular-nums ${INPUT_CLASS} ${border}`}
      />
    );
  }

  if (field.kind === 'json') {
    return <JsonBox {...shared} value={value} border={border} onValue={onValue} />;
  }

  return (
    <input
      {...shared}
      type="text"
      value={typeof value === 'string' ? value : ''}
      onChange={(event) => {
        onValue(event.target.value === '' ? undefined : event.target.value);
      }}
      className={`w-full max-w-md ${INPUT_CLASS} ${border}`}
    />
  );
}

/**
 * The fallback for a parameter these controls cannot draw.
 *
 * Its existence is the point: `params` is replaced wholesale on save, so a form that rendered
 * nothing for an array or a free-form object would delete it the moment somebody pressed Save.
 * The operator gets the value and can edit it; unparseable text is left in the box rather than
 * discarded, so a half-finished edit is not thrown away by a re-render.
 */
function JsonBox({
  value,
  border,
  onValue,
  ...shared
}: {
  value: unknown;
  border: string;
  onValue: (next: unknown) => void;
} & Record<string, unknown>): React.JSX.Element {
  const [text, setText] = useState(() =>
    value === undefined ? '' : JSON.stringify(value, null, 2),
  );
  const [broken, setBroken] = useState(false);

  return (
    <div className="space-y-1">
      <textarea
        {...shared}
        rows={4}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          if (event.target.value.trim() === '') {
            setBroken(false);
            onValue(undefined);
            return;
          }
          try {
            onValue(JSON.parse(event.target.value));
            setBroken(false);
          } catch {
            setBroken(true);
          }
        }}
        className={`w-full max-w-md font-mono ${INPUT_CLASS} ${border}`}
      />
      <p className="text-xs text-text-muted">
        {broken ? (
          <span className="text-down-fg">Not valid JSON — the last valid value will be saved.</span>
        ) : (
          'Edited as JSON: this parameter is a shape the generated controls do not cover.'
        )}
      </p>
    </div>
  );
}
