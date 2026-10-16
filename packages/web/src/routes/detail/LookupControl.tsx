import { useState } from 'react';
import { ApiError, send } from '../../api/client';
import type { ChannelRecord, LookupSummary } from '../../api/types';
import { CorrelationId } from '../../components/Panels';
import { lookupOptions } from './lookup-model';

/** What the channel table needs to set a channel's lookup (`U-82`). Absent, it only shows them. */
export interface LookupEditing {
  readonly sensorId: number;
  /**
   * The sensor's version, sent as `If-Match`: a channel's lookup is part of its sensor, and the
   * write moves the sensor's version.
   */
  readonly version: number;
  /**
   * The page is reading the sensor or its channels again. A set made now would be held to the
   * version before the last set, which has moved it, and refused as somebody else's change.
   */
  readonly pending: boolean;
  /** After a lookup is set: the page reads the channels and the sensor again. */
  readonly onSaved: () => void;
}

/**
 * Sets or clears one channel's lookup, under what judges it in the channel table (`U-82`).
 *
 * Until `U-82` the table showed a channel's lookup and setting one took
 * `PATCH /objects/{id}/channels/{key}`. **Offered only to a caller who may write the sensor**: the
 * page decides, and the core holds every write to `write` on the sensor whatever it decided.
 *
 * **A button, not a save on change.** A lookup decides the channel's state from its next reading,
 * and one that maps a value to Down turns the sensor Down; arrow keys on a closed list change its
 * value in some browsers, and a keyboard user walking the choices would set each in turn.
 */
export function LookupControl({
  channel,
  lookups,
  editing,
}: {
  channel: ChannelRecord;
  lookups: readonly LookupSummary[] | null;
  editing: LookupEditing;
}): React.JSX.Element {
  const [choice, setChoice] = useState(channel.lookupId ?? '');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<ApiError | null>(null);
  const [done, setDone] = useState<string | null>(null);
  // **Taken again from the channel when its lookup moves** (as `TargetPolicyException` takes the
  // device's): the list read after a save, or after somebody else's, says what it now is.
  const [basis, setBasis] = useState(channel.lookupId);
  if (basis !== channel.lookupId) {
    setBasis(channel.lookupId);
    setChoice(channel.lookupId ?? '');
  }

  const changed = choice !== (channel.lookupId ?? '');
  // **Unavailable, not `disabled`** (`U-73`): pressed, the button has focus, and a disabled one
  // drops it to the page while the request is out, and again after it, when the list read back
  // leaves nothing to set. A press while it is unavailable sends nothing.
  const unavailable = busy || !changed || editing.pending;

  const set = (): void => {
    if (unavailable) return;
    const wanted = choice === '' ? null : choice;
    setBusy(true);
    setFailed(null);
    setDone(null);
    send<ChannelRecord>(
      'PATCH',
      `/objects/${String(editing.sensorId)}/channels/${encodeURIComponent(channel.key)}`,
      { lookupId: wanted },
      { 'if-match': `W/"${String(editing.version)}"` },
    )
      .then(() => {
        setDone(
          wanted === null
            ? 'Cleared. Its limits judge it from its next reading.'
            : `Set. ${wanted} judges it from its next reading.`,
        );
        editing.onSaved();
      })
      .catch((error: unknown) => {
        setFailed(
          error instanceof ApiError
            ? error
            : new ApiError(0, 'UNKNOWN', error instanceof Error ? error.message : 'failed'),
        );
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <div className="mt-1">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          set();
        }}
      >
        <select
          aria-label={`Lookup for ${channel.name}`}
          value={choice}
          disabled={busy}
          onChange={(event) => {
            setChoice(event.target.value);
            setDone(null);
            setFailed(null);
          }}
          className="max-w-full border border-control bg-surface px-2 py-1 text-xs text-text"
        >
          {lookupOptions(channel, lookups).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {/* The name says which channel, as the list's does: one button per row. It starts with
            the words on the button, whichever they are (WCAG 2.5.3). */}
        <button
          type="submit"
          aria-label={`${busy ? 'Setting lookup' : 'Set lookup'} for ${channel.name}`}
          aria-disabled={unavailable}
          className="border border-accent px-2 py-1 text-xs text-accent aria-disabled:opacity-40"
        >
          {busy ? 'Setting lookup…' : 'Set lookup'}
        </button>
      </form>
      {/* Both regions always there and empty until they speak (`U-41`, `U-54`), taking no space
          while they say nothing (`U-45`). */}
      <div role="status" className="mt-1 text-xs empty:mt-0">
        {done !== null && <p className="text-up-fg">{done}</p>}
      </div>
      <div role="alert" className="mt-1 empty:mt-0">
        {failed !== null && (
          <p className="text-xs text-down-fg">
            {failed.message}
            {failed.status === 412 &&
              ' — somebody else changed this sensor since the page was opened. Reload to see' +
                ' their change before setting this over it.'}
            <CorrelationId id={failed.correlationId} />
          </p>
        )}
      </div>
    </div>
  );
}
