import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  existingEntry,
  existingWithin,
  FIXED_REASON,
  fieldsOf,
  fixedChangedReason,
  fixedState,
  isMultiline,
  newEntryFor,
  readAt,
  removeAt,
  scalarEntryOf,
  writeAt,
  type Existing,
  type FieldModel,
  type JsonSchema,
} from './schema';
import { ProblemRegion, SchemaControl } from './Control';
import { problemsFor, type FieldProblem } from './validate';

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
  /**
   * The stored parameters of the sensor being edited; absent when adding one (`U-34`).
   *
   * What decides whether a field marked `x-createOnly` is shown read-only. Not `values`, which
   * move as the operator types: an entry they add to an array is new however long it has been on
   * the screen, and only what is stored says which entries the sensor already has.
   */
  readonly existing?: Record<string, unknown>;
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
  existing,
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
          existing={existing}
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
  /** What the sensor already has around this field (`U-34`); `existingWithin` says how. */
  existing: Existing;
}

function Field(props: FieldProps): React.JSX.Element {
  const { field } = props;
  if (field.kind === 'array' && field.items !== undefined) {
    return <ArrayField {...props} items={field.items} />;
  }
  if (field.kind === 'object') {
    const within = existingWithin(props.existing, field.name);
    return (
      <fieldset className="border border-border px-3 pb-3 pt-1">
        <legend className="px-1 text-xs font-medium uppercase tracking-wide text-text-muted">
          {field.label}
        </legend>
        {field.description !== undefined && (
          <p className="mb-2 text-xs text-text-muted">{field.description}</p>
        )}
        <div className="space-y-4">
          {field.children.map((child) => (
            <Field key={child.path} {...props} field={child} existing={within} />
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
  existing,
}: FieldProps): React.JSX.Element {
  const id = useId();
  const value = readAt(values, field.path);
  const isSet = redacted.includes(field.path);
  const beingReplaced = replacing.has(field.path);
  const fixed = fixedState(field, existing, value);

  const problems = [
    ...serverProblems.filter((problem) => problem.path === field.path),
    ...(touched.has(field.path) ? problemsFor(field, value) : []),
  ];
  const describedBy = [
    field.description === undefined ? null : `${id}-hint`,
    fixed.kind === 'open' ? null : `${id}-fixed`,
    problems.length > 0 ? `${id}-problem` : null,
  ]
    .filter((entry) => entry !== null)
    .join(' ');

  // **A cleared entry holds `''`** (`U-41`). A control emptied says "absent", and an entry of an
  // array cannot be absent: removing it is its array's Remove, which `removeAt` leaves to it, so
  // the clear used to be ignored and the box put the text back under the caret. `''` is what the
  // empty box shows, so the form holds what the operator sees; whether `''` may be saved is the
  // schema's to say (`minLength`), and the check before submit says it at this entry.
  const set = (next: unknown): void => {
    if (next !== undefined) onChange(writeAt(values, field.path, next));
    else if (field.entry) onChange(writeAt(values, field.path, ''));
    else onChange(removeAt(values, field.path));
  };

  // **Focus stays on the field when putting it back locks it** (`U-34`, WCAG 2.4.3). A `changed`
  // field set back to what is stored turns from a select into a read-only box, and the select
  // that had focus is gone: without this, focus falls to the page and a screen reader user never
  // hears that the field is now fixed. Only when the change came from this control while it had
  // focus — a column key retyped elsewhere in the entry can lock this field too, and must not
  // pull focus away from the key being typed.
  const wrapper = useRef<HTMLDivElement>(null);
  const refocus = useRef(false);
  useLayoutEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    if (fixed.kind !== 'locked') return;
    const control = document.getElementById(id);
    if (control !== null && document.activeElement !== control) control.focus();
  });

  return (
    <div ref={wrapper}>
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
          <SchemaControl
            id={id}
            field={field}
            value={fixed.kind === 'locked' ? fixed.value : value}
            disabled={disabled}
            describedBy={describedBy}
            invalid={problems.length > 0}
            readOnly={fixed.kind === 'locked'}
            onValue={(next) => {
              refocus.current = wrapper.current?.contains(document.activeElement) ?? false;
              set(next);
            }}
            onBlur={() => {
              markTouched(field.path);
            }}
          />
        )}

        {fixed.kind !== 'open' && (
          // Polite live region as well as a description: going from `changed` to `locked` keeps this
          // element and changes its sentence, which is announced even where moving focus onto the
          // read-only box does not read its description again.
          <p id={`${id}-fixed`} className="text-xs text-text-muted" aria-live="polite">
            {fixed.kind === 'locked' ? FIXED_REASON : fixedChangedReason(fixed.stored)}
          </p>
        )}
      </div>

      {/* **Always there, and a polite live region** (`U-41`, WCAG 4.1.3). A problem appears when
          the field is left, by which time focus is on the next control and the description tied
          to this one is not read again. Named by `aria-describedby` only while it says
          something. Outside the `space-y-1` stack above, which would give it a gap while empty
          (`U-45`); `ProblemRegion` says why it is never hidden. */}
      <ProblemRegion id={`${id}-problem`} problems={problems} />
    </div>
  );
}

/**
 * A repeating parameter — an array whose entries the schema describes (`U-12`).
 *
 * **This replaces a textarea holding raw JSON**, which is what `U-08`'s fallback gave these and
 * is why the fallback exists: it round-trips correctly and deletes nothing. What it does not do
 * is let anybody configure `http.transaction.steps` without typing JSON by hand — and since
 * `T-04`, `T-15` and `T-16`, an array of objects is the shape of every new sensor type's *most
 * important* parameter rather than an edge case.
 *
 * **Entries are rendered through the same `Field` as everything else**, at paths carrying their
 * index (`steps.0.method`). Three things fall out of that rather than being built: nesting works,
 * because an entry containing an array is just another `ArrayField`; server problems land on the
 * right control, because the core reports Ajv's `instancePath` and that is the same path; and
 * write-only entries keep their behaviour, which a bespoke editor would have had to reimplement.
 *
 * **Reordering is by one position at a time, not drag-and-drop.** Order is meaningful in every
 * one of these — a transaction's steps run in order — so it has to be changeable; and buttons are
 * reachable from a keyboard, which `U-11`'s WCAG pass requires and a drag target is not.
 */
function ArrayField({ items, ...props }: FieldProps & { items: JsonSchema }): React.JSX.Element {
  const { field, values, onChange, disabled } = props;
  // **The entry's own noun, where the item schema gives one.** The fieldset is named for the
  // parameter — "Steps" — and an entry inside it wants the singular. Nothing here can derive one
  // from the other without guessing at English plurals, so `items.title` is the hook: a type
  // author writes `title: 'Step'` on the item and gets "Step 2" instead of "Steps 2".
  const entryLabel = items.title ?? field.label;
  const raw = readAt(values, field.path);
  const entries: unknown[] = Array.isArray(raw) ? (raw as unknown[]) : [];

  const replace = (next: unknown[]): void => {
    // An array emptied back to nothing is removed rather than saved as `[]`: the schema tells
    // those two apart, and `params` is replaced wholesale on save.
    onChange(
      next.length === 0 && !field.required
        ? removeAt(values, field.path)
        : writeAt(values, field.path, next),
    );
  };

  /**
   * Swaps an entry with its neighbour.
   *
   * No bounds check: the first entry's "up" and the last one's "down" are *disabled*, which is
   * the mechanism rather than a hint, and a guard here would be a branch nothing can reach —
   * which is a branch no test can hold to account.
   */
  const move = (from: number, to: number): void => {
    const next: unknown[] = [...entries];
    const held = next.splice(from, 1);
    next.splice(to, 0, ...held);
    replace(next);
  };

  const atLimit = field.schema.maxItems !== undefined && entries.length >= field.schema.maxItems;

  return (
    <fieldset className="border border-border px-3 pb-3 pt-1">
      <legend className="px-1 text-xs font-medium uppercase tracking-wide text-text-muted">
        {field.label}
      </legend>
      {field.description !== undefined && (
        <p className="mb-2 text-xs text-text-muted">{field.description}</p>
      )}

      {entries.length === 0 ? (
        <p className="mb-2 text-xs text-text-muted">Nothing here yet.</p>
      ) : (
        <ol className="mb-2 space-y-3">
          {entries.map((_entry, index) => (
            <li
              // Position, deliberately: these entries have no identity of their own, and a key
              // derived from their contents would remount a control on every keystroke — which
              // takes the caret with it.
              key={index}
              className="border border-border-subtle p-2"
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-text-muted">
                  {entryLabel} {String(index + 1)}
                </span>
                <div className="flex gap-1">
                  <EntryButton
                    label={`Move ${entryLabel} ${String(index + 1)} up`}
                    text="↑"
                    disabled={disabled || index === 0}
                    onClick={() => {
                      move(index, index - 1);
                    }}
                  />
                  <EntryButton
                    label={`Move ${entryLabel} ${String(index + 1)} down`}
                    text="↓"
                    disabled={disabled || index === entries.length - 1}
                    onClick={() => {
                      move(index, index + 1);
                    }}
                  />
                  <EntryButton
                    label={`Remove ${entryLabel} ${String(index + 1)}`}
                    text="Remove"
                    disabled={disabled}
                    onClick={() => {
                      replace(entries.filter((_value, at) => at !== index));
                    }}
                  />
                </div>
              </div>
              <Entry {...props} items={items} index={index} />
            </li>
          ))}
        </ol>
      )}

      <button
        type="button"
        disabled={disabled || atLimit}
        onClick={() => {
          replace([...entries, newEntryFor(items)]);
        }}
        className="border border-control px-2 py-1 text-xs text-text-muted hover:text-text disabled:opacity-50"
      >
        Add {entryLabel.toLowerCase()}
      </button>
      {atLimit && (
        <span className="ml-2 text-xs text-text-muted">
          {String(field.schema.maxItems)} is the most this parameter takes.
        </span>
      )}
    </fieldset>
  );
}

/** One entry: the item schema's own fields, at a path carrying this entry's index. */
function Entry({
  items,
  index,
  ...props
}: FieldProps & { items: JsonSchema; index: number }): React.JSX.Element {
  const path = `${props.field.path}.${String(index)}`;
  const children = useMemo(() => fieldsOf(items, path), [items, path]);

  // An array *of scalars* has no properties to lay out, so the entry is one control at the entry's
  // own path. Nothing in it is fixed (`U-34`), so nothing is existing either.
  if (children.length === 0) {
    return (
      <Field {...props} existing={undefined} field={scalarEntryOf(items, props.field, index)} />
    );
  }

  // The stored entry this one *is*, by its key and not its position (`U-34`): an entry the
  // operator added, or one whose key they changed to something the sensor does not have, is new.
  const existing = existingEntry(
    items,
    readAt(props.values, path),
    props.existing?.[props.field.name],
  );

  return (
    <div className="space-y-4">
      {children.map((child) => (
        <Field key={child.path} {...props} field={child} existing={existing} />
      ))}
    </div>
  );
}

function EntryButton({
  label,
  text,
  disabled,
  onClick,
}: {
  label: string;
  text: string;
  disabled: boolean;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="border border-control px-1.5 py-0.5 text-xs text-text-muted hover:text-text disabled:opacity-40"
    >
      {text}
    </button>
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
        {isMultiline(field.schema) ? (
          // **A box that keeps line breaks, for a secret that has them** (`U-21`). A password
          // input strips them from a paste, which turns a private key into something no server
          // accepts. What is typed here is visible while it is typed and never afterwards: once
          // saved the core returns it to nobody, and this box is not filled from a read.
          <textarea
            id={id}
            rows={6}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            value={value}
            disabled={disabled}
            aria-describedby={describedBy === '' ? undefined : describedBy}
            onChange={(event) => {
              onValue(event.target.value === '' ? undefined : event.target.value);
            }}
            className="w-full max-w-xl border border-control bg-surface px-2 py-1 font-mono text-xs text-text"
          />
        ) : (
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
            className="w-64 border border-control bg-surface px-2 py-1 text-sm text-text"
          />
        )}
        {isSet && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              onValue(undefined);
              onReplace(field.path, false);
            }}
            className="border border-control px-2 py-1 text-xs text-text-muted hover:text-text"
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
        className="border border-ack-border bg-ack-bg px-1.5 py-0.5 text-xs font-medium text-ack-fg"
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
        className="border border-control px-2 py-1 text-xs text-text-muted hover:text-text"
      >
        Replace
      </button>
      {!field.required && (
        <button
          type="button"
          disabled={disabled}
          onClick={onClear}
          className="border border-control px-2 py-1 text-xs text-text-muted hover:text-text"
        >
          Clear
        </button>
      )}
    </div>
  );
}
