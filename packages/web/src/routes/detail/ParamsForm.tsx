import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, problemPath, send } from '../../api/client';
import type { ChannelRecord, ObjectDetail, SensorTypeSummary } from '../../api/types';
import { CorrelationId } from '../../components/Panels';
import { MappingPreview } from '../../forms/MappingPreview';
import { SchemaForm } from '../../forms/SchemaForm';
import { fieldsOf, readAt, type JsonSchema } from '../../forms/schema';
import { allProblems, type FieldProblem } from '../../forms/validate';
import { useKeptChannels } from './kept-channels';
import { modeChangesOf, type ModeChange } from './model';

/**
 * A sensor's parameters, edited through the form its type's schema generates (`U-08`).
 *
 * **Saving sends only the parameters, and only ever the ones it can see.** A write-only
 * parameter the operator did not touch is absent from the patch and the core carries the stored
 * value forward — the mirror of redaction, and the reason a generated form can exist at all
 * without deleting every credential on its first save.
 *
 * The form validates against the schema for immediate feedback, but the core is the validator:
 * it runs the same schema through Ajv and its refusal names the path, which is shown against the
 * field it names.
 */
export function ParamsForm({
  detail,
  type,
  channels,
  onSaved,
}: {
  detail: ObjectDetail;
  /** Absent when the catalogue does not know this sensor's type. */
  type: SensorTypeSummary | undefined;
  /**
   * The sensor's channel rows, where the page has them (`U-40`): what holds a column put back
   * after an earlier edit took it out to what its kept channel stores. Without them nothing is
   * asked, and such a column is the core's 409 to refuse.
   */
  channels?: readonly ChannelRecord[] | null;
  onSaved: () => void;
}): React.JSX.Element {
  const stored = useMemo(() => detail.params ?? {}, [detail.params]);
  const redacted = useMemo(() => detail.redactedParams ?? [], [detail.redactedParams]);

  const [values, setValues] = useState<Record<string, unknown>>(stored);
  const [replacing, setReplacing] = useState<ReadonlySet<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<ApiError | null>(null);
  const [serverProblems, setServerProblems] = useState<readonly FieldProblem[]>([]);
  /**
   * What the status line under the buttons says: an accepted save, or the changes discarded.
   * Emptied by any change and by the next save.
   */
  const [said, setSaid] = useState<'saved' | 'discarded' | null>(null);
  /**
   * An accepted save, or a discard, owes focus to the status line once the form shows what the
   * core holds (`U-23` review). The button pressed is disabled then, with nothing changed, and a
   * browser drops the focus a disabled control held to the page.
   */
  const [owedFocus, setOwedFocus] = useState(false);
  const status = useRef<HTMLDivElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  const discardButton = useRef<HTMLButtonElement>(null);
  /** What the last accepted save's reply said it left alone (`U-36`). */
  const [lookupsKept, setLookupsKept] = useState<readonly string[]>([]);

  // **A saved edit is a new version of the sensor, and the form starts again from it.** The page
  // keeps this form mounted through the re-read a save asks for (`U-36`), so what was typed has
  // to be put back to what the core now holds — a value the core normalised, a secret now
  // stored — or the form would call itself changed the moment it was saved. Set while rendering,
  // as React's guide has a prop-derived reset done, so no render shows the stale values.
  //
  // **Only after this form's save, or when the parameters themselves moved** (`U-82`). A
  // channel's lookup set in the table above moves the sensor's version and nothing here, and
  // starting again from that threw away whatever had been typed. Keeping it cannot save over an
  // edit this form did not see: the next save is held to the new version, and parameters that
  // moved start the form again.
  const [basis, setBasis] = useState(detail.version);
  const [basisParams, setBasisParams] = useState(() => JSON.stringify([stored, redacted]));
  /** This form's own save, read back: the version it moves starts the form again. */
  const [readingBack, setReadingBack] = useState(false);
  if (basis !== detail.version) {
    const now = JSON.stringify([stored, redacted]);
    setBasis(detail.version);
    setBasisParams(now);
    setReadingBack(false);
    if (readingBack || now !== basisParams) {
      setValues(stored);
      setReplacing(new Set());
    }
  }

  // Memoised on the type rather than derived inline: a fresh `{}` every render would rebuild the
  // field models, and with them the identities the form's own memos hang off.
  const schema = useMemo(() => (type?.paramsSchema ?? {}) as JsonSchema, [type]);
  const fields = useMemo(() => fieldsOf(schema), [schema]);
  const problems = useMemo(() => allProblems(fields, values, readAt, fieldsOf), [fields, values]);
  const keptFor = useKeptChannels(type?.id, schema, stored, values, channels);
  const dirty = JSON.stringify(values) !== JSON.stringify(stored) || replacing.size > 0;

  // Only from the button that was pressed, or from the page it fell to: an operator who pressed
  // Enter in a field, or moved on while the save was out, is left where they are. A change made
  // before the form shows what is stored empties `said`, and the debt goes with it.
  useEffect(() => {
    if (!owedFocus) return;
    if (said === null) {
      setOwedFocus(false);
      return;
    }
    if (dirty) return;
    setOwedFocus(false);
    const at = document.activeElement;
    const pressed = at === saveButton.current || at === discardButton.current;
    if (at === null || at === document.body || pressed) status.current?.focus();
  }, [owedFocus, said, dirty]);

  const onReplace = useCallback((path: string, on: boolean) => {
    setReplacing((held) => {
      const next = new Set(held);
      if (on) next.add(path);
      else next.delete(path);
      return next;
    });
  }, []);

  if (type === undefined) {
    return (
      <p className="text-sm text-text-muted">
        <code className="font-mono">{detail.sensorType}</code> is not a registered sensor type, so
        there is no schema to build a form from. The stored parameters are intact — registering the
        type makes them editable again.
      </p>
    );
  }

  const modeChanges = failed === null ? null : modeChangesOf(failed);

  const save = (): void => {
    // Pressed again, or Enter in a field, while the save is out: *Save parameters* only says it is
    // unavailable (below), so this is what keeps it to one request.
    if (saving) return;
    setSaving(true);
    setFailed(null);
    setServerProblems([]);
    setSaid(null);
    setOwedFocus(false);
    setLookupsKept([]);

    // `If-Match` is required on PATCH, and it is required for a reason: two operators with this
    // form open is the realistic collision, and under last-write-wins the second save silently
    // reverts the first. The tag is the version this form was built from.
    send<ObjectDetail>(
      'PATCH',
      `/objects/${String(detail.id)}`,
      { kind: 'sensor', params: values },
      { 'if-match': `W/"${String(detail.version)}"` },
    )
      .then((reply) => {
        setReplacing(new Set());
        setLookupsKept(reply.lookupsKept ?? []);
        setSaid('saved');
        setOwedFocus(true);
        setReadingBack(true);
        onSaved();
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError) {
          setFailed(error);
          // The core names the path it refused. Putting the message on that field beats a banner
          // saying "params are not valid" above twelve inputs.
          const named = (error.details.problems ?? [])
            .map((problem) => ({
              path: problemPath(problem),
              message: problem.message ?? 'was refused',
            }))
            .filter((problem) => problem.path !== '');
          setServerProblems(named);
        } else {
          setFailed(new ApiError(0, 'UNKNOWN', error instanceof Error ? error.message : 'failed'));
        }
      })
      .finally(() => {
        setSaving(false);
      });
  };

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      {/* **Not disabled while saving** (`U-23` review), as the template form's settings are not
          (`U-78`): Enter in a parameter's box saves, and disabling the box it was pressed in took
          the focus it held to the page, with *Save* and *Discard* disabled beside it. */}
      <SchemaForm
        schema={schema}
        values={values}
        redacted={redacted}
        onChange={(next) => {
          setValues(next);
          setSaid(null);
        }}
        replacing={replacing}
        onReplace={onReplace}
        serverProblems={serverProblems}
        existing={stored}
        keptFor={keptFor}
      />

      {type.hasPreview && <MappingPreview typeId={type.id} params={values} />}

      {/* The buttons and the refusal under them are one block, the form's last child: the refusal
          is always there, and `space-y-4` gives every child but the last a margin, so as a child
          of its own it would put that margin under the buttons while it says nothing (`U-52`). */}
      <div>
        <div className="flex flex-wrap items-center gap-3">
          {/* **Unavailable while the save is out, not `disabled`** (`U-23` review, as `U-73` made
              the template form's): a button disabled while it has focus loses it to the page, so
              a refusal came back to focus on nothing. It keeps focus, says *Saving…*, and a press
              sends nothing more. Nothing to save is still `disabled`: an accepted save is the one
              time focus is on it then, and the status line takes it (above). */}
          <button
            ref={saveButton}
            type="submit"
            disabled={!dirty || problems.length > 0}
            aria-disabled={saving}
            className="border border-accent bg-accent px-3 py-1 text-sm font-medium text-accent-contrast disabled:opacity-50 aria-disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save parameters'}
          </button>
          {/* Unavailable the same way while the save is out, so the form is not put back under
              it. **Discarding moves focus to the status line, which says so**: the button has
              nothing left to discard, and is disabled from the render that discards. */}
          <button
            ref={discardButton}
            type="button"
            disabled={!dirty && !saving}
            aria-disabled={saving}
            onClick={() => {
              if (saving) return;
              setValues(stored);
              setReplacing(new Set());
              setServerProblems([]);
              setFailed(null);
              setSaid('discarded');
              setOwedFocus(true);
            }}
            className="border border-control px-3 py-1 text-sm text-text-muted hover:text-text disabled:opacity-50 aria-disabled:opacity-50"
          >
            Discard changes
          </button>
          {problems.length > 0 && (
            <span className="text-xs text-text-muted">
              {problems.length} {problems.length === 1 ? 'field needs' : 'fields need'} attention
            </span>
          )}
        </div>

        {/* **An accepted save, in a region always there and empty until one** (`U-36`), for the
          reason the refusal's is (`U-41`): the line used to be added with its text in it, which is
          not reliably said. Polite, since nothing went wrong; said whole, by the status role's own
          atomicity. Emptied by the next save and by any change. **Focusable, and where focus goes
          after an accepted save or a discard** (`U-23` review): the button pressed has nothing
          left to do and is disabled, and this says what it did. */}
        <div ref={status} role="status" tabIndex={-1} className="mt-2 text-xs empty:mt-0">
          {said === 'saved' && !dirty && (
            <>
              <p className="text-up-fg">
                Saved. The probe picks the change up on its next configuration push.
              </p>
              {lookupsKept.length > 0 && <LookupsKept channels={lookupsKept} />}
            </>
          )}
          {said === 'discarded' && !dirty && (
            <p className="text-text">
              Discarded. The form shows the parameters as they are stored.
            </p>
          )}
        </div>

        {/* **A refused save, in a region always there and empty until a refusal** (`U-54`, as
          `U-48` and `U-52` did): focus is where the save was made from when the core refuses —
          *Save parameters*, or the box Enter was pressed in, neither of them disabled while it is
          out — nothing moves it, and a region added with its text already in it is not reliably
          announced (`U-41`). One region
          for both shapes of refusal, so the one that comes is said whichever it is. `save` and
          *Discard changes* empty it, so a second refusal in the same words is a change again.
          No space while it says nothing (`empty:mt-0`, `U-45`). */}
        <div role="alert" className="mt-4 empty:mt-0">
          {failed !== null && modeChanges !== null && (
            <ModeRefusal error={failed} changes={modeChanges} />
          )}
          {failed !== null && modeChanges === null && (
            <p className="text-xs text-down-fg">
              {failed.message}
              {failed.status === 412 &&
                ' — somebody else changed this sensor since this form was opened. Reload to see' +
                  ' their change before saving over it.'}
              <CorrelationId id={failed.correlationId} />
            </p>
          )}
        </div>
      </div>
    </form>
  );
}

/**
 * The edit was saved, but a lookup it declares was not applied (`U-36`, `P-311`).
 *
 * The sensor's type cannot say what its stored parameters declared — they were written by an
 * older build, say — so a lookup set by hand on the channel cannot be told from the one the type
 * set, and the core leaves the lookup as it is rather than overwrite an operator's choice. Said
 * after *Saved*, in text and not by colour alone, naming each channel, with the way forward: the
 * operator who made the edit is the one who knows whether the kept lookup is still right. The
 * Channels table above is where a channel's lookup is set (`U-82`), so it says so.
 */
function LookupsKept({ channels }: { channels: readonly string[] }): React.JSX.Element {
  const one = channels.length === 1;
  return (
    <div className="mt-1 text-text">
      <p>
        {one
          ? 'One channel kept its lookup'
          : `${String(channels.length)} channels kept their lookup`}
        : this sensor’s stored parameters can no longer be read by its type, so a lookup chosen by
        hand could not be told from the one the type set, and the edit left {one ? 'it' : 'them'} as{' '}
        {one ? 'it was' : 'they were'}. The Channels table shows the lookup{' '}
        {one ? 'it has' : 'each has'}, and is where an account that may change this sensor sets
        another, or none.
      </p>
      <ul className="mt-1 list-disc pl-5">
        {channels.map((key) => (
          <li key={key}>
            Channel <code className="font-mono">{key}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The core refused an edit that would turn a channel from a counter into a gauge or back
 * (`P-303`, `U-34`).
 *
 * **Said in full, not as a line of small red text under the buttons.** The refusal is not a typo
 * to correct: the edit cannot be made to this sensor at all, and the way forward is a different
 * action — put the value back, or add a new sensor. So it names each channel and direction, and
 * keeps the core's own sentence, which says why. Said by the form's refusal region, which is an
 * alert because it appears after a submit, away from where focus is, and nothing else would tell a
 * screen reader the save did not happen; not an alert of its own, since it is added with its text
 * and would not be reliably announced (`U-54`).
 */
function ModeRefusal({
  error,
  changes,
}: {
  error: ApiError;
  changes: readonly ModeChange[];
}): React.JSX.Element {
  return (
    <div className="space-y-2 border border-down-border bg-down-bg p-3 text-sm">
      <p className="font-medium text-down-fg">
        Not saved: this edit would change what{' '}
        {changes.length > 1 ? 'these channels store' : 'a channel stores'}.
      </p>
      {changes.length > 0 && (
        <ul className="list-disc space-y-1 pl-5 text-text">
          {changes.map((change) => (
            <li key={change.key}>
              Channel <code className="font-mono">{change.key}</code>: a {change.from} cannot become
              a {change.to}.
            </li>
          ))}
        </ul>
      )}
      {/* The id after the core's sentence and a space, in `CorrelationId` as every other refusal
          line has it (`U-65`, `U-70`): in a paragraph of its own it was said as a line by itself. */}
      <p className="text-text">
        {error.message}
        <CorrelationId id={error.correlationId} size="text-xs" />
      </p>
    </div>
  );
}
