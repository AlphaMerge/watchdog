import { useCallback, useId, useMemo, useState } from 'react';
import {
  defaultFor,
  fieldsOf,
  readAt,
  removeAt,
  writeAt,
  type FieldModel,
  type JsonSchema,
} from './schema';
import { allProblems, problemsFor, type FieldProblem } from './validate';

export interface SchemaFormProps {
  readonly schema: JsonSchema;
  /** What is stored, minus anything write-only — the API never returns those. */
  readonly values: Record<string, unknown>;
  /** Paths the API reported as set-but-withheld. */
  readonly redacted: readonly string[];
  readonly onChange: (values: Record<string, unknown>) => void;
  /** Paths of write-only fields the operator has chosen to replace. */
  readonly replacing: ReadonlySet<string>;
  readonly onReplace: (path: string, replacing: boolean) => void;
  readonly disabled?: boolean;
  /** Problems the server reported, keyed by the path it named. */
  readonly serverProblems?: readonly FieldProblem[];
}

/**
 * A form built from a sensor type's `paramsSchema` (`U-08`).
 *
 * **There is no per-type frontend work, and that is the whole point.** `paramsSchema` already
 * validates the API and marks the secrets; generating the form from it makes a third use of one
 * declaration instead of a second thing to keep in step. Adding a sensor type stays the one-file
 * job `docs/adding-a-sensor-type.md` promises.
 *
 * **A field this cannot render becomes a JSON box, never nothing.** `params` is replaced
 * wholesale on save, so a control that silently skipped an unsupported parameter would delete it
 * the first time somebody pressed Save. The catalogue permits schemas richer than these controls
 * cover, and the honest response to one is to hand the operator the value and let them edit it.
 */
export function SchemaForm({
  schema,
  values,
  redacted,
  onChange,
  replacing,
  onReplace,
  disabled = false,
  serverProblems = [],
}: SchemaFormProps): React.JSX.Element {
  const fields = useMemo(() => fieldsOf(schema), [schema]);
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());

  const markTouched = useCallback((path: string) => {
    setTouched((held) => new Set(held).add(path));
  }, []);

  if (fields.length === 0) {
    return <p className="text-sm text-text-muted">This sensor type takes no parameters.</p>;
  }

  return (
    <div className="space-y-4">
      {fields.map((field) => (
        <Field
          key={field.path}
          field={field}
          values={values}
          redacted={redacted}
          onChange={onChange}
          replacing={replacing}
          onReplace={onReplace}
          disabled={disabled}
          touched={touched}
          markTouched={markTouched}
          serverProblems={serverProblems}
        />
      ))}
    </div>
  );
}

interface FieldProps {
  field: FieldModel;
  values: Record<string, unknown>;
  redacted: readonly string[];
  onChange: (values: Record<string, unknown>) => void;
  replacing: ReadonlySet<string>;
  onReplace: (path: string, replacing: boolean) => void;
  disabled: boolean;
  touched: ReadonlySet<string>;
  markTouched: (path: string) => void;
  serverProblems: readonly FieldProblem[];
}

function Field(props: FieldProps): React.JSX.Element {
  const { field } = props;
  if (field.kind === 'object') {
    return (
      <fieldset className="rounded border border-border px-3 pb-3 pt-1">
        <legend className="px-1 text-xs font-medium uppercase tracking-wide text-text-muted">
          {field.label}
        </legend>
        {field.description !== undefined && (
          <p className="mb-2 text-xs text-text-muted">{field.description}</p>
        )}
        <div className="space-y-4">
          {field.children.map((child) => (
            <Field key={child.path} {...props} field={child} />
          ))}
        </div>
      </fieldset>
    );
  }
  return <Control {...props} />;
}

function Control({
  field,
  values,
  redacted,
  onChange,
  replacing,
  onReplace,
  disabled,
  touched,
  markTouched,
  serverProblems,
}: FieldProps): React.JSX.Element {
  const id = useId();
  const value = readAt(values, field.path);
  const isSet = redacted.includes(field.path);
  const beingReplaced = replacing.has(field.path);

  const problems = [
    ...serverProblems.filter((problem) => problem.path === field.path),
    ...(touched.has(field.path) ? problemsFor(field, value) : []),
  ];
  const describedBy = [
    field.description === undefined ? null : `${id}-hint`,
    problems.length > 0 ? `${id}-problem` : null,
  ]
    .filter((entry) => entry !== null)
    .join(' ');

  const set = (next: unknown): void => {
    onChange(next === undefined ? removeAt(values, field.path) : writeAt(values, field.path, next));
  };

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-baseline gap-2">
        <label htmlFor={id} className="text-sm font-medium text-text">
          {field.label}
        </label>
        {field.required && (
          <span className="text-xs text-text-muted" aria-hidden="true">
            required
          </span>
        )}
        <span className="font-mono text-xs text-text-muted">{field.path}</span>
      </div>

      {field.description !== undefined && (
        <p id={`${id}-hint`} className="text-xs text-text-muted">
          {field.description}
        </p>
      )}

      {field.writeOnly ? (
        <WriteOnly
          id={id}
          field={field}
          isSet={isSet}
          replacing={beingReplaced}
          value={typeof value === 'string' ? value : ''}
          disabled={disabled}
          describedBy={describedBy}
          onReplace={onReplace}
          onValue={(next) => {
            set(next);
            markTouched(field.path);
          }}
          onClear={() => {
            // `null` is the API's explicit unset. Omitting the key would instead keep the stored
            // secret, which is the opposite of what "clear" means.
            set(null);
            markTouched(field.path);
          }}
        />
      ) : (
        <Input
          id={id}
          field={field}
          value={value}
          disabled={disabled}
          describedBy={describedBy}
          invalid={problems.length > 0}
          onValue={(next) => {
            set(next);
          }}
          onBlur={() => {
            markTouched(field.path);
          }}
        />
      )}

      {problems.length > 0 && (
        <p id={`${id}-problem`} className="text-xs text-down-fg">
          {problems.map((problem) => problem.message).join('; ')}
        </p>
      )}
    </div>
  );
}

/**
 * A credential.
 *
 * **Never populated, and never sent unless it was deliberately changed.** The API does not return
 * the value — that is `CLAUDE.md`'s write-only rule — so an input pre-filled with anything would
 * be pre-filled with a lie, and a form that submitted its empty box would replace the stored
 * secret with nothing. Leaving it alone omits the key, and the core carries the stored value
 * forward.
 */
function WriteOnly({
  id,
  field,
  isSet,
  replacing,
  value,
  disabled,
  describedBy,
  onReplace,
  onValue,
  onClear,
}: {
  id: string;
  field: FieldModel;
  isSet: boolean;
  replacing: boolean;
  value: string;
  disabled: boolean;
  describedBy: string;
  onReplace: (path: string, replacing: boolean) => void;
  onValue: (next: unknown) => void;
  onClear: () => void;
}): React.JSX.Element {
  if (!isSet || replacing) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <input
          id={id}
          type="password"
          autoComplete="new-password"
          value={value}
          disabled={disabled}
          aria-describedby={describedBy === '' ? undefined : describedBy}
          onChange={(event) => {
            onValue(event.target.value === '' ? undefined : event.target.value);
          }}
          className="w-64 rounded border border-border bg-surface px-2 py-1 text-sm text-text"
        />
        {isSet && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              onValue(undefined);
              onReplace(field.path, false);
            }}
            className="rounded border border-border px-2 py-1 text-xs text-text-muted hover:text-text focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            Keep the current one
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span
        className="rounded border border-ack-border bg-ack-bg px-1.5 py-0.5 text-xs font-medium text-ack-fg"
        id={id}
      >
        set, write-only
      </span>
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          onReplace(field.path, true);
        }}
        className="rounded border border-border px-2 py-1 text-xs text-text-muted hover:text-text focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        Replace
      </button>
      {!field.required && (
        <button
          type="button"
          disabled={disabled}
          onClick={onClear}
          className="rounded border border-border px-2 py-1 text-xs text-text-muted hover:text-text focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          Clear
        </button>
      )}
    </div>
  );
}

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

function Input({
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

export { allProblems, defaultFor, fieldsOf };
export type { FieldModel, FieldProblem, JsonSchema };
