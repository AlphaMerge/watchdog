import {
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { InlineMarkdown } from '../components/InlineMarkdown';
import {
  existingEntry,
  existingWithin,
  fieldsOf,
  fixedReason,
  fixedState,
  isMultiline,
  movedPaths,
  newEntryFor,
  readAt,
  removeAt,
  scalarEntryOf,
  writeAt,
  type Existing,
  type FieldModel,
  type JsonSchema,
  type Kept,
} from './schema';
import { ProblemRegion, SchemaControl } from './Control';
import { movedProblems, problemsFor, type FieldProblem } from './validate';

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
  /**
   * Problems the server reported, keyed by the path it named — about the values it was sent.
   *
   * **Pass a new array for each refusal and keep it while it stands** (`U-50`). The form shows
   * these where their entries have gone since (a Move or a Remove), and starts again from what is
   * passed whenever a different array is: so a new refusal, or `[]` as the next attempt starts,
   * replaces what is shown, and an array rebuilt on every render would undo every Move.
   */
  readonly serverProblems?: readonly FieldProblem[];
  /**
   * The stored parameters of the sensor being edited; absent when adding one (`U-34`).
   *
   * What decides whether a field marked `x-createOnly` is shown read-only. Not `values`, which
   * move as the operator types: an entry they add to an array is new however long it has been on
   * the screen, and only what is stored says which entries the sensor already has.
   */
  readonly existing?: Record<string, unknown>;
  /**
   * The channels an array entry the stored parameters do not name lands on, where the sensor kept
   * them from an earlier edit (`U-40`); asked of the entry at `array` as the form holds it. Absent,
   * as when adding a sensor, nothing is kept. `ParamsForm` says how it knows.
   */
  readonly keptFor?: (array: string, entry: unknown) => Kept;
}

/** The default, one array for every render: a fresh `[]` would start the problems again. */
const NO_PROBLEMS: readonly FieldProblem[] = [];

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
  serverProblems = NO_PROBLEMS,
  existing,
  keptFor,
}: SchemaFormProps): React.JSX.Element {
  const fields = useMemo(() => fieldsOf(schema), [schema]);
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());

  const markTouched = useCallback((path: string) => {
    setTouched((held) => new Set(held).add(path));
  }, []);

  // **What the core refused moves with its entry too** (`U-50`). It named a path in the values it
  // was sent, and a Move or a Remove since has put that entry somewhere else: kept by position, a
  // 400 on `steps.1.path` stayed on Step 2 after Step 2 moved up, on a path the operator had not
  // been told about. Held here and not by each caller, because this is where the arrays
  // rearrange and `touched` is already remapped: a callback would have every caller repeat one
  // line, and one that forgot would bring the bug back. Started again from the caller's array
  // whenever it passes a different one (React's adjust-state-while-rendering pattern).
  const [shown, setShown] = useState({ from: serverProblems, problems: serverProblems });
  let problems = shown.problems;
  if (shown.from !== serverProblems) {
    problems = serverProblems;
    setShown({ from: serverProblems, problems });
  }

  // **What has been left moves with its entry** (`U-49`). `touched` is keyed by path, the key
  // every check and every server problem already uses, and an array that rearranges its entries
  // says how, so the paths are remapped there rather than given a second, position-free identity.
  const moveTouched = useCallback((array: string, order: readonly number[]) => {
    setTouched((held) => movedPaths(held, array, order));
    setShown((held) => ({ from: held.from, problems: movedProblems(held.problems, array, order) }));
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
          moveTouched={moveTouched}
          serverProblems={problems}
          existing={existing}
          keptFor={keptFor}
          kept={undefined}
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
  /**
   * The array at `array` rearranged: `order[j]` is where the entry now at `j` was. What has been
   * left (`U-49`) and what the core refused (`U-50`) go with their entries.
   */
  moveTouched: (array: string, order: readonly number[]) => void;
  /** What the core refused, at the paths its entries are at now (`U-50`). */
  serverProblems: readonly FieldProblem[];
  /** What the sensor already has around this field (`U-34`); `existingWithin` says how. */
  existing: Existing;
  /** `SchemaForm`'s, for the entries of every array below (`U-40`). */
  keptFor: ((array: string, entry: unknown) => Kept) | undefined;
  /** The kept channels the entry this field is in lands on (`U-40`); `undefined` outside one. */
  kept: Kept;
}

function Field(props: FieldProps): React.JSX.Element {
  const { field } = props;
  if (field.kind === 'array' && field.items !== undefined) {
    // **A list that is a secret is kept, replaced or cleared whole** (`U-23` review), as the core
    // keeps it: it never returns the entries, so "Nothing here yet." was a list it would not show,
    // and an entry added there replaced every stored one without a word.
    return field.writeOnly ? (
      <SecretList {...props} items={field.items} />
    ) : (
      <ArrayField {...props} items={field.items} />
    );
  }
  // An object that is a secret is one value the core never returns, not fields to lay out: it is
  // drawn as the JSON box a free-form object gets, inside the secret's keep, replace and clear.
  if (field.kind === 'object' && !field.writeOnly) {
    const within = existingWithin(props.existing, field.name);
    return (
      <fieldset className="border border-border px-3 pb-3 pt-1">
        <legend className="px-1 text-xs font-medium uppercase tracking-wide text-text-muted">
          {field.label}
        </legend>
        {field.description !== undefined && (
          <p className="mb-2 text-xs text-text-muted">
            <InlineMarkdown text={field.description} />
          </p>
        )}
        <div className="space-y-4">
          {field.children.map((child) => (
            // By name, not path: inside an entry the path carries the entry's position, and a
            // key that changed with it would remount the control on every Move (`U-47` review).
            <Field key={child.name} {...props} field={child} existing={within} />
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
  kept,
}: FieldProps): React.JSX.Element {
  const id = useId();
  const value = readAt(values, field.path);
  const isSet = redacted.includes(field.path);
  const beingReplaced = replacing.has(field.path);
  const fixed = fixedState(field, existing, value, kept);
  const reason = fixedReason(fixed);

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
  //
  // **Held until the lock comes, not one render** (`U-40`). A field held to a kept channel locks
  // when the core answers for the value it was set to, a round trip after the change, by which
  // time the render the change made is long gone. So the intent stays while focus is still here,
  // or fell to the page with the select the lock took away, and goes once focus is anywhere else:
  // a lock that comes after the operator moved on must not pull them back.
  const wrapper = useRef<HTMLDivElement>(null);
  const refocus = useRef(false);
  useLayoutEffect(() => {
    if (!refocus.current) return;
    const at = document.activeElement;
    const fell = at === null || at === document.body;
    if (!fell && !(wrapper.current?.contains(at) ?? false)) {
      refocus.current = false;
      return;
    }
    if (fixed.kind !== 'locked') return;
    refocus.current = false;
    const control = document.getElementById(id);
    if (control !== null && at !== control) control.focus();
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
          // Markdown, as the catalogue writes it (`U-89`): `SELECT` as code, not in backticks.
          <p id={`${id}-hint`} className="text-xs text-text-muted">
            <InlineMarkdown text={field.description} />
          </p>
        )}

        {field.writeOnly ? (
          <WriteOnly
            id={id}
            field={field}
            isSet={isSet}
            replacing={beingReplaced}
            value={value}
            disabled={disabled}
            describedBy={describedBy}
            invalid={problems.length > 0}
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
      </div>

      {field.createOnly && (
        // **Always there for a fixed field, a polite live region** (`U-34`, `U-40`), as the problem
        // below is (`U-41`). Going from `changed` to `locked` changes its sentence in place, which
        // is announced even where moving focus onto the read-only box does not read its
        // description again; and a field held to a kept channel is open while the core is asked,
        // so its sentence comes into a region that was there, empty, before it. Outside the stack
        // above and taking no space while empty, for `ProblemRegion`'s reasons (`U-45`).
        <p
          id={`${id}-fixed`}
          className="mt-1 text-xs text-text-muted empty:mt-0"
          aria-live="polite"
        >
          {reason}
        </p>
      )}

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
function ArrayField({
  items,
  after,
  ...props
}: FieldProps & {
  items: JsonSchema;
  /** Drawn in the list's fieldset after *Add*: a secret list's *Keep the current ones*. */
  after?: ReactNode;
}): React.JSX.Element {
  const { field, values, onChange, disabled, moveTouched } = props;
  // **The entry's own noun, where the item schema gives one.** The fieldset is named for the
  // parameter — "Steps" — and an entry inside it wants the singular. Nothing here can derive one
  // from the other without guessing at English plurals, so `items.title` is the hook: a type
  // author writes `title: 'Step'` on the item and gets "Step 2" instead of "Steps 2".
  const entryLabel = items.title ?? field.label;
  const raw = readAt(values, field.path);
  const entries: unknown[] = Array.isArray(raw) ? (raw as unknown[]) : [];

  // **Each entry keeps one identity for its life** (`U-47` review). Entries have none of their
  // own, and a key derived from their contents would remount a control on every keystroke, which
  // takes the caret with it; so this keeps a key per entry and moves it with the entry on Move
  // and Remove. Keyed by position instead, a Move or a Remove handed each mounted control another
  // entry's value, and whatever a control holds beside the value — a JSON box's half-typed text,
  // its "not valid JSON" — stayed behind with the position, on an entry never touched. Values
  // changed from outside (a reload) keep the keys and only grow or shrink them to fit.
  const [held, setHeld] = useState<readonly number[]>(() => keysFor([], entries.length));
  let keys = held;
  if (keys.length !== entries.length) {
    keys = keysFor(keys, entries.length);
    setHeld(keys);
  }

  // **Focus follows the entry** after a Move or a Remove (WCAG 2.4.3). The entry's own buttons
  // move with it now, so one that held focus can be taken out of the DOM and put back, which
  // drops focus, or land where it is disabled; and a Remove takes its button away. Only when
  // focus was in this list, so a change made elsewhere never pulls focus here.
  const list = useRef<HTMLOListElement>(null);
  const add = useRef<HTMLButtonElement>(null);
  const follow = useRef<{ index: number; action: EntryAction } | null>(null);
  const keepFocus = (index: number, action: EntryAction): void => {
    follow.current = list.current?.contains(document.activeElement) ? { index, action } : null;
  };
  useLayoutEffect(() => {
    const wanted = follow.current;
    if (wanted === null) return;
    follow.current = null;
    const target = entryButton(list.current, wanted.index, wanted.action) ?? add.current;
    if (target !== null && document.activeElement !== target) target.focus();
  });

  const replace = (next: unknown[], nextKeys: readonly number[]): void => {
    // An array emptied back to nothing is removed rather than saved as `[]`: the schema tells
    // those two apart, and `params` is replaced wholesale on save.
    onChange(
      next.length === 0 && !field.required
        ? removeAt(values, field.path)
        : writeAt(values, field.path, next),
    );
    setHeld(nextKeys);
  };

  /**
   * Swaps an entry with its neighbour.
   *
   * No bounds check: the first entry's "up" and the last one's "down" are *disabled*, which is
   * the mechanism rather than a hint, and a guard here would be a branch nothing can reach —
   * which is a branch no test can hold to account.
   */
  const move = (from: number, to: number): void => {
    keepFocus(to, to < from ? 'up' : 'down');
    replace(movedIn(entries, from, to), movedIn(keys, from, to));
    moveTouched(field.path, movedIn(positions(entries), from, to));
  };

  const remove = (index: number): void => {
    keepFocus(index, 'remove');
    const kept = (_value: unknown, at: number): boolean => at !== index;
    replace(entries.filter(kept), keys.filter(kept));
    moveTouched(field.path, positions(entries).filter(kept));
  };

  const atLimit = field.schema.maxItems !== undefined && entries.length >= field.schema.maxItems;

  return (
    <fieldset className="border border-border px-3 pb-3 pt-1">
      <legend className="px-1 text-xs font-medium uppercase tracking-wide text-text-muted">
        {field.label}
      </legend>
      {field.description !== undefined && (
        <p className="mb-2 text-xs text-text-muted">
          <InlineMarkdown text={field.description} />
        </p>
      )}

      {entries.length === 0 ? (
        <p className="mb-2 text-xs text-text-muted">Nothing here yet.</p>
      ) : (
        <ol ref={list} className="mb-2 space-y-3">
          {entries.map((_entry, index) => (
            // The hairline (`U-23`). It named `border-subtle`, which is no token, so Tailwind made
            // no rule and the box was drawn in the text colour: black on paper, white on charcoal.
            <li key={keys[index]} className="border border-border p-2">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-text-muted">
                  {entryLabel} {String(index + 1)}
                </span>
                <div className="flex gap-1">
                  <EntryButton
                    action="up"
                    label={`Move ${entryLabel} ${String(index + 1)} up`}
                    text="↑"
                    disabled={disabled || index === 0}
                    onClick={() => {
                      move(index, index - 1);
                    }}
                  />
                  <EntryButton
                    action="down"
                    label={`Move ${entryLabel} ${String(index + 1)} down`}
                    text="↓"
                    disabled={disabled || index === entries.length - 1}
                    onClick={() => {
                      move(index, index + 1);
                    }}
                  />
                  <EntryButton
                    action="remove"
                    label={`Remove ${entryLabel} ${String(index + 1)}`}
                    text="Remove"
                    disabled={disabled}
                    onClick={() => {
                      remove(index);
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
        ref={add}
        type="button"
        data-entry-add=""
        disabled={disabled || atLimit}
        onClick={() => {
          replace([...entries, newEntryFor(items)], keysFor(keys, entries.length + 1));
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
      {after}
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
      <Field
        {...props}
        existing={undefined}
        kept={undefined}
        field={scalarEntryOf(items, props.field, index)}
      />
    );
  }

  // The stored entry this one *is*, by its key and not its position (`U-34`): an entry the
  // operator added, or one whose key they changed to something the sensor does not have, is new.
  const entry = readAt(props.values, path);
  const existing = existingEntry(items, entry, props.existing?.[props.field.name]);
  // Unless the sensor kept the channel it lands on from an earlier edit (`U-40`).
  const kept = existing === undefined ? props.keptFor?.(props.field.path, entry) : undefined;

  return (
    <div className="space-y-4">
      {children.map((child) => (
        // By name, not path, which carries this entry's position (`U-47` review).
        <Field key={child.name} {...props} field={child} existing={existing} kept={kept} />
      ))}
    </div>
  );
}

type EntryAction = 'up' | 'down' | 'remove';

/**
 * `keys` grown or shrunk to `length` (`U-47` review): the first ones kept, new ones never used by
 * any key still here. A key freed by a Remove may come back, which is harmless: its entry is gone.
 */
function keysFor(keys: readonly number[], length: number): readonly number[] {
  if (keys.length >= length) return keys.slice(0, length);
  const next = keys.reduce((highest, key) => Math.max(highest, key), -1) + 1;
  return [...keys, ...Array.from({ length: length - keys.length }, (_unused, at) => next + at)];
}

/** Each entry's position, `0` to `length - 1`: the order a rearrangement is described from. */
function positions(list: readonly unknown[]): number[] {
  return list.map((_entry, at) => at);
}

/** `list` with the item at `from` taken out and put back at `to`. */
function movedIn<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  const held = next.splice(from, 1);
  next.splice(to, 0, ...held);
  return next;
}

/**
 * Where focus goes after a Move or a Remove: the same button of the entry now at `index` — the
 * entry moved, or the one that took a removed entry's place, or the last if it was the last — or
 * its first enabled one when that button is disabled there (moved to the top, "up" is). `null`
 * when the list has no entries left, and the caller falls back to Add.
 */
function entryButton(
  list: HTMLOListElement | null,
  index: number,
  action: EntryAction,
): HTMLButtonElement | null {
  const items = list?.children;
  if (items === undefined || items.length === 0) return null;
  // The entry's own header, which comes first: an entry holding an array has buttons of its own
  // further down, for its own entries.
  const header = items[Math.min(index, items.length - 1)]?.firstElementChild;
  const buttons = [
    ...(header?.querySelectorAll<HTMLButtonElement>('button[data-entry-action]') ?? []),
  ].filter((button) => !button.disabled);
  return (
    buttons.find((button) => button.getAttribute('data-entry-action') === action) ??
    buttons[0] ??
    null
  );
}

function EntryButton({
  action,
  label,
  text,
  disabled,
  onClick,
}: {
  action: EntryAction;
  label: string;
  text: string;
  disabled: boolean;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-entry-action={action}
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

/** The part of a credential's control that focus goes to once the control has changed shape. */
type WriteOnlyPart = 'box' | 'replace' | 'clear' | 'keep';

const WRITE_ONLY_BUTTON = 'border border-control px-2 py-1 text-xs text-text-muted hover:text-text';

/** A secret's buttons, and the one focus is owed to once the control has changed shape. */
interface OwedFocus {
  readonly owe: (part: WriteOnlyPart) => void;
  readonly replace: RefObject<HTMLButtonElement | null>;
  readonly clear: RefObject<HTMLButtonElement | null>;
  readonly keep: RefObject<HTMLButtonElement | null>;
}

/**
 * Where focus goes after one of a secret's buttons (`U-23`): owed as the button is pressed, and
 * given once the control has its new shape. `box` is what a Replace opens.
 */
function useOwedFocus(box: () => HTMLElement | null): OwedFocus {
  const next = useRef<WriteOnlyPart | null>(null);
  const replace = useRef<HTMLButtonElement>(null);
  const clear = useRef<HTMLButtonElement>(null);
  const keep = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const wanted = next.current;
    if (wanted === null) return;
    next.current = null;
    const parts: Record<WriteOnlyPart, HTMLElement | null> = {
      box: box(),
      replace: replace.current,
      clear: clear.current,
      keep: keep.current,
    };
    parts[wanted]?.focus();
  });
  const owe = useCallback((part: WriteOnlyPart) => {
    next.current = part;
  }, []);
  return { owe, replace, clear, keep };
}

/**
 * A credential.
 *
 * **Never populated, and never sent unless it was deliberately changed.** The API does not return
 * the value — that is `CLAUDE.md`'s write-only rule — so an input pre-filled with anything would
 * be pre-filled with a lie, and a form that submitted its empty box would replace the stored
 * secret with nothing. Leaving it alone omits the key, and the core carries the stored value
 * forward.
 *
 * **Each of its buttons changes what the control is, and says where focus goes next** (`U-23`,
 * WCAG 2.4.3). The button pressed is taken away, or its node is kept by React for whichever button
 * now stands in its place: walked with a keyboard, Replace left focus on *Keep the current one*,
 * the button that undoes it, with the box to type in behind. Replace now goes to the box, Keep to
 * Replace, Clear to the Keep that undoes it, and that Keep back to Clear. Each button has a key of
 * its own, so none is handed another's focus by accident and the order above is the only one.
 *
 * **A secret cleared says so where it was cleared** (`U-23`). Clear used to change nothing at the
 * control: it still read "set, write-only", with the same two buttons, and only a sentence at the
 * foot of the form said the secret would go. It now reads "removed on save", and offers to keep
 * the stored one instead.
 *
 * **Replace after Clear starts from keeping** (`U-23` review). It took the "removed on save" away
 * and left the `null` behind, so an empty box that looked like every other Replace, which keeps
 * the stored secret, removed it on save. An empty box keeps it, wherever it was opened from.
 *
 * **Each button is named for its field as well as what it does** (`U-90`). By their text alone,
 * SNMP's three secrets gave three buttons called "Replace" and three called "Clear", which is all
 * a list of buttons or a voice command has to go on. The name starts with the text shown, so the
 * words a reader sees are the words that press it (WCAG 2.5.3), and the field's label follows.
 *
 * **A secret that is an object is typed as JSON** (`U-23` review): the webhook's `secretHeaders`.
 * It was drawn as a password box, which stored what was typed as a string the core refuses, with
 * nothing to say what it wanted. And **a secret in error is marked as every other field is**
 * (WCAG 3.3.1): `aria-invalid`, and the edge in the error colour.
 */
function WriteOnly({
  id,
  field,
  isSet,
  replacing,
  value,
  disabled,
  describedBy,
  invalid,
  onReplace,
  onValue,
  onClear,
}: {
  id: string;
  field: FieldModel;
  isSet: boolean;
  replacing: boolean;
  /** What the form holds: `null` is the stored secret to be removed on save. */
  value: unknown;
  disabled: boolean;
  describedBy: string;
  /** The field has a problem, said in the region `describedBy` names. */
  invalid: boolean;
  onReplace: (path: string, replacing: boolean) => void;
  onValue: (next: unknown) => void;
  onClear: () => void;
}): React.JSX.Element {
  const focus = useOwedFocus(() => document.getElementById(id));
  const keepName = `Keep the current one, ${field.label}`;

  if (!isSet || replacing) {
    const edge = invalid ? 'border-down-fg' : 'border-control';
    const text = typeof value === 'string' ? value : '';
    const shared = {
      id,
      disabled,
      autoComplete: 'off',
      'aria-describedby': describedBy === '' ? undefined : describedBy,
      'aria-invalid': invalid ? true : undefined,
    } as const;
    const typed = (next: string): void => {
      onValue(next === '' ? undefined : next);
    };
    return (
      <div className="flex flex-wrap items-start gap-2">
        {field.kind === 'json' || field.kind === 'object' ? (
          // The JSON box a free-form parameter gets, with what it wants said under it (3.3.2): an
          // object parsed as it is typed, and an emptied box keeping the stored one.
          <div className="w-full max-w-md">
            <SchemaControl
              id={id}
              field={{ ...field, kind: 'json' }}
              value={value === null ? undefined : value}
              disabled={disabled}
              describedBy={describedBy}
              invalid={invalid}
              hint={jsonHintOf(field)}
              onValue={onValue}
              onBlur={() => undefined}
            />
          </div>
        ) : isMultiline(field.schema) ? (
          // **A box that keeps line breaks, for a secret that has them** (`U-21`). A password
          // input strips them from a paste, which turns a private key into something no server
          // accepts. What is typed here is visible while it is typed and never afterwards: once
          // saved the core returns it to nobody, and this box is not filled from a read.
          <textarea
            {...shared}
            rows={6}
            autoCapitalize="off"
            spellCheck={false}
            value={text}
            onChange={(event) => {
              typed(event.target.value);
            }}
            className={`w-full max-w-xl border bg-surface px-2 py-1 font-mono text-xs text-text ${edge}`}
          />
        ) : (
          <input
            {...shared}
            type="password"
            autoComplete="new-password"
            value={text}
            onChange={(event) => {
              typed(event.target.value);
            }}
            className={`w-64 border bg-surface px-2 py-1 text-sm text-text ${edge}`}
          />
        )}
        {isSet && (
          <button
            key="keep"
            ref={focus.keep}
            type="button"
            disabled={disabled}
            aria-label={keepName}
            onClick={() => {
              focus.owe('replace');
              onValue(undefined);
              onReplace(field.path, false);
            }}
            className={WRITE_ONLY_BUTTON}
          >
            Keep the current one
          </button>
        )}
      </div>
    );
  }

  return (
    <StoredSecret
      id={id}
      field={field}
      cleared={value === null}
      disabled={disabled}
      focus={focus}
      keepText="Keep the current one"
      onReplace={() => {
        // From "removed on save", the `null` goes with the marker: the box opens empty, and an
        // empty box keeps the stored secret, as it does from "set, write-only".
        if (value === null) onValue(undefined);
        onReplace(field.path, true);
      }}
      onKeep={() => {
        onValue(undefined);
      }}
      onClear={onClear}
    />
  );
}

/** What a secret's JSON box says it wants (WCAG 3.3.2), where its schema says it is an object. */
function jsonHintOf(field: FieldModel): string | undefined {
  const type = field.schema.type;
  const object = type === 'object' || (Array.isArray(type) && type.includes('object'));
  return object
    ? 'Typed as JSON: an object of names and values, such as {"name": "value"}.'
    : undefined;
}

/**
 * A stored secret: "set, write-only" or "removed on save", with Replace and Clear or Keep.
 * `WriteOnly`'s and `SecretList`'s, which own the focus each press owes.
 */
function StoredSecret({
  id,
  field,
  cleared,
  disabled,
  focus,
  keepText,
  onReplace,
  onKeep,
  onClear,
}: {
  id: string;
  field: FieldModel;
  /** The form holds `null` for it: it is removed on save. */
  cleared: boolean;
  disabled: boolean;
  focus: OwedFocus;
  keepText: string;
  onReplace: () => void;
  onKeep: () => void;
  onClear: () => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span
        className={
          cleared
            ? 'border border-down-border bg-down-bg px-1.5 py-0.5 text-xs font-medium text-down-fg'
            : 'border border-ack-border bg-ack-bg px-1.5 py-0.5 text-xs font-medium text-ack-fg'
        }
        id={id}
      >
        {cleared ? 'removed on save' : 'set, write-only'}
      </span>
      <button
        key="replace"
        ref={focus.replace}
        type="button"
        disabled={disabled}
        aria-label={`Replace ${field.label}`}
        onClick={() => {
          focus.owe('box');
          onReplace();
        }}
        className={WRITE_ONLY_BUTTON}
      >
        Replace
      </button>
      {cleared ? (
        <button
          key="keep"
          ref={focus.keep}
          type="button"
          disabled={disabled}
          aria-label={`${keepText}, ${field.label}`}
          aria-describedby={id}
          onClick={() => {
            focus.owe('clear');
            onKeep();
          }}
          className={WRITE_ONLY_BUTTON}
        >
          {keepText}
        </button>
      ) : (
        !field.required && (
          <button
            key="clear"
            ref={focus.clear}
            type="button"
            disabled={disabled}
            aria-label={`Clear ${field.label}`}
            onClick={() => {
              focus.owe('keep');
              onClear();
            }}
            className={WRITE_ONLY_BUTTON}
          >
            Clear
          </button>
        )
      )}
    </div>
  );
}

/**
 * A list that is a secret: the program method's `secretArgs` (`U-23` review).
 *
 * **Kept, replaced or cleared whole**, as `WriteOnly` does a single secret, because that is what
 * the core does with it: it returns none of the entries, and one sent replaces them all. The list
 * was drawn as any other, so a stored one read "Nothing here yet.", and an entry added there, in
 * a box that showed what was typed, replaced every stored one on save without a word.
 *
 * **Replace opens the list empty**, its entries in password boxes, says that what is listed
 * replaces the stored ones, and offers to keep them instead. A list left empty keeps them, as an
 * empty box does. Focus moves as `WriteOnly`'s does, Replace to *Add*.
 */
function SecretList({ items, ...props }: FieldProps & { items: JsonSchema }): React.JSX.Element {
  const { field, values, redacted, replacing, onChange, onReplace, disabled } = props;
  const id = useId();
  const isSet = redacted.includes(field.path);
  const cleared = readAt(values, field.path) === null;
  const list = useRef<HTMLDivElement>(null);
  const focus = useOwedFocus(
    () => list.current?.querySelector<HTMLElement>(':scope > fieldset > [data-entry-add]') ?? null,
  );
  const keepText = 'Keep the current ones';
  const keep = (): void => {
    onChange(removeAt(values, field.path));
  };

  if (!isSet || replacing.has(field.path)) {
    return (
      <div ref={list}>
        <ArrayField
          {...props}
          items={items}
          after={
            isSet && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="text-xs text-text-muted">
                  What is listed here replaces every stored one on save.
                </span>
                <button
                  key="keep"
                  ref={focus.keep}
                  type="button"
                  disabled={disabled}
                  aria-label={`${keepText}, ${field.label}`}
                  onClick={() => {
                    focus.owe('replace');
                    keep();
                    onReplace(field.path, false);
                  }}
                  className={WRITE_ONLY_BUTTON}
                >
                  {keepText}
                </button>
              </div>
            )
          }
        />
      </div>
    );
  }

  return (
    <fieldset className="border border-border px-3 pb-3 pt-1">
      <legend className="px-1 text-xs font-medium uppercase tracking-wide text-text-muted">
        {field.label}
      </legend>
      {field.description !== undefined && (
        <p className="mb-2 text-xs text-text-muted">
          <InlineMarkdown text={field.description} />
        </p>
      )}
      <StoredSecret
        id={id}
        field={field}
        cleared={cleared}
        disabled={disabled}
        focus={focus}
        keepText={keepText}
        onReplace={() => {
          if (cleared) keep();
          onReplace(field.path, true);
        }}
        onKeep={keep}
        onClear={() => {
          // `null` is the API's unset, as for a single secret; an absent key keeps the list.
          onChange(writeAt(values, field.path, null));
        }}
      />
    </fieldset>
  );
}
