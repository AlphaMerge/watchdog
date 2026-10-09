import { useState } from 'react';
import type { FieldModel } from './schema';
import type { FieldProblem } from './validate';

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

const INPUT_CLASS = 'border bg-surface px-2 py-1 text-sm text-text';

/** A value as a read-only box shows it: what its own control would have shown, as text. */
function displayOf(field: FieldModel, value: unknown): string {
  if (field.kind === 'boolean') return value === true ? 'Yes' : 'No';
  if (field.kind === 'json') return value === undefined ? '' : JSON.stringify(value);
  return optionOf(value);
}

export function SchemaControl({
  id,
  field,
  value,
  disabled,
  describedBy,
  invalid,
  onValue,
  onBlur,
  readOnly = false,
}: {
  id: string;
  field: FieldModel;
  value: unknown;
  disabled: boolean;
  describedBy: string;
  invalid: boolean;
  onValue: (next: unknown) => void;
  onBlur: () => void;
  /** Shown and announced, never changed (`U-34`). The caller says why, through `describedBy`. */
  readOnly?: boolean;
}): React.JSX.Element {
  if (readOnly) {
    // **A read-only text box, whatever the kind**, rather than the kind's own control disabled.
    // A disabled control leaves the tab order and some screen readers skip it, so the reason tied
    // to it by `aria-describedby` is never read; and a `<select>` has no read-only state at all —
    // `readonly` on one is ignored and the value still changes. A text box with `readOnly` is
    // focusable, announced as read-only with its label and its reason, and cannot be changed.
    return (
      <input
        id={id}
        type="text"
        readOnly
        value={displayOf(field, value)}
        aria-describedby={describedBy === '' ? undefined : describedBy}
        className="w-64 border border-control bg-surface-muted px-2 py-1 text-sm text-text"
      />
    );
  }
  // `-fg` and not `-border` for the invalid case: the pale border tint is 1.7:1 on the light
  // surface, and an error outline is a state indicator, which WCAG 1.4.11 holds to 3:1. The
  // message underneath and `aria-invalid` carry it too — this is the one a sighted mouse user
  // sees first.
  const border = invalid ? 'border-down-fg' : 'border-control';
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
        // 24 square, which is WCAG 2.5.8's minimum. The checkboxes elsewhere sit inside their
        // own label and inherit its target; this one is labelled from outside by `SchemaForm`,
        // so the box is all there is to hit.
        className="h-6 w-6"
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
    return (
      <JsonBox {...shared} value={value} entry={field.entry} border={border} onValue={onValue} />
    );
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
 * A control's problem: always there, a polite live region, taking no space while it says nothing
 * (`U-41`, `U-45`). Shared by the parameter form and the inheritable settings (`U-46`).
 *
 * **Always there.** A problem appears when the field is left, or as a setting is typed, and a
 * live region is announced only if it existed before its text changed (WCAG 4.1.3) — so it is
 * rendered empty rather than not at all. The caller names it in the control's `aria-describedby`
 * and sets `aria-invalid` only while it holds a problem.
 *
 * **Empty, it takes no space.** Its own `mt-1`, which `empty:mt-0` takes away while it has no
 * children at all (React renders no text node for `''`), and an empty block has no line box. The
 * caller puts it **outside** any `space-y-*` stack: Tailwind 4 gives every child of one but the
 * last a bottom margin, which would bring the gap back. Never `hidden` or `display: none`: either
 * takes it out of the accessibility tree, and a live region must be in it before its text changes.
 */
export function ProblemRegion({
  id,
  problems,
}: {
  id: string;
  problems: readonly FieldProblem[];
}): React.JSX.Element {
  return (
    <p id={id} className="mt-1 text-xs text-down-fg empty:mt-0" aria-live="polite">
      {problems.map((problem) => problem.message).join('; ')}
    </p>
  );
}

/**
 * A JSON box's text for a value it is given (`U-47`).
 *
 * **In an entry, `''` is an emptied box and is shown as one.** A cleared entry holds `''` (`U-41`)
 * because an entry cannot be absent, and serialising it would show `""`, which nobody typed.
 * The JSON string `""` typed into an entry stores that same `''`: an entry cannot hold it apart
 * from a clear, and `U-44` already judges an entry's `''` as emptied ("cannot be empty"), so
 * showing it as empty is showing it as the form treats it. **Anywhere else `''` is only ever the
 * string**, since clearing a box that is not an entry removes the value (`undefined`), so it is
 * shown as `""`.
 */
function jsonTextOf(value: unknown, entry: boolean): string {
  if (value === undefined || (entry && value === '')) return '';
  return JSON.stringify(value, null, 2);
}

/** The same value for a JSON box's purposes: the same reference, or the same JSON. */
function sameJson(a: unknown, b: unknown): boolean {
  return Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The fallback for a parameter these controls cannot draw.
 *
 * Its existence is the point: `params` is replaced wholesale on save, so a form that rendered
 * nothing for an array or a free-form object would delete it the moment somebody pressed Save.
 * The operator gets the value and can edit it; unparseable text is left in the box rather than
 * discarded, so a half-finished edit is not thrown away by a re-render.
 *
 * **The text follows the value whenever the value changes from outside** (`U-47`). The box keeps
 * its own text — what was typed, in the operator's spelling, valid or not — for as long as the
 * value it was given is the one that text stands for. A different value came from somewhere else
 * — a reload, a reset — and a box that kept its text would show one value while the form saved
 * another. An entry of an array keeps one box for its life, wherever Move takes it, because
 * `ArrayField` keys entries by identity rather than position; a box handed a JSON-equal
 * neighbour's place would otherwise keep text the value cannot tell apart (`U-47` review).
 */
function JsonBox({
  value,
  entry,
  border,
  onValue,
  ...shared
}: {
  value: unknown;
  /** An entry of an array (`FieldModel.entry`), whose `''` is a cleared box (`U-41`). */
  entry: boolean;
  border: string;
  onValue: (next: unknown) => void;
} & Record<string, unknown>): React.JSX.Element {
  const [text, setText] = useState(() => jsonTextOf(value, entry));
  const [broken, setBroken] = useState(false);
  // The value `text` stands for: what it was built from, or what it last parsed to.
  const [stands, setStands] = useState<unknown>(value);
  if (!sameJson(stands, value)) {
    // React's adjust-state-while-rendering pattern: the render this happens in is thrown away
    // and redone with the new text, so the box never paints the old entry's text over the value.
    setStands(value);
    setText(jsonTextOf(value, entry));
    setBroken(false);
  }

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
            // What the form will hold, not what is handed to it: an entry's empty box is `''`
            // (`U-41`), and standing for `undefined` would read that `''` as a different value and
            // rebuild the text — taking every space or line break typed into an emptied entry.
            setStands(entry ? '' : undefined);
            onValue(undefined);
            return;
          }
          try {
            const parsed: unknown = JSON.parse(event.target.value);
            setStands(parsed);
            onValue(parsed);
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
