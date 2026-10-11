import { useContext, useId, useState } from 'react';
import { ApiError, send } from '../../api/client';
import type { ObjectDetail } from '../../api/types';
import { SessionContext } from '../../auth/session';
import { CorrelationId } from '../../components/Panels';
import { addressesFrom, mayExcept, textOf } from './exception-model';

/**
 * A device's exception to its probe's target policy, on the device page (`A-79`).
 *
 * Until `A-79` it could be set and read only through the API (`A-64`). **Everyone who may read
 * the device sees the list**, as the core shows it to them; **only an administrator is offered the
 * editor**, because only an administrator's write is taken. The core judges every entry and names
 * the one it refuses, so this sends what was typed and shows the refusal.
 *
 * The session is read from its context directly and not through `useSession`, which throws without
 * one: the device page is drawn in tests and stories with no session, and there it is simply not an
 * administrator's.
 */
export function TargetPolicyException({
  detail,
  onSaved,
}: {
  detail: ObjectDetail;
  onSaved: () => void;
}): React.JSX.Element {
  const editable = mayExcept(useContext(SessionContext)?.session);
  const stored = detail.targetPolicyException ?? [];
  const fieldId = useId();
  const helpId = useId();

  const [text, setText] = useState(() => textOf(stored));
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState<'saved' | 'cleared' | null>(null);
  // **Taken again from the device when it changes** (as `ParamsForm`): the version is what this
  // editor was built from, and a reload after somebody else's save brings a new one.
  const [basis, setBasis] = useState(detail.version);
  if (basis !== detail.version) {
    setBasis(detail.version);
    setText(textOf(stored));
  }

  const wanted = addressesFrom(text);
  const dirty = textOf(wanted) !== textOf(stored);

  const save = (addresses: readonly string[]): void => {
    setSaving(true);
    setFailed(null);
    setSaved(null);
    send<ObjectDetail>(
      'PUT',
      `/objects/${String(detail.id)}/target-policy-exception`,
      { addresses },
      { 'if-match': `W/"${String(detail.version)}"` },
    )
      .then(() => {
        setSaved(addresses.length === 0 ? 'cleared' : 'saved');
        onSaved();
      })
      .catch((error: unknown) => {
        setFailed(
          error instanceof ApiError
            ? error
            : new ApiError(0, 'UNKNOWN', error instanceof Error ? error.message : 'failed'),
        );
      })
      .finally(() => {
        setSaving(false);
      });
  };

  return (
    <div className="space-y-3 text-sm">
      <p className="text-text-muted">
        The addresses of this device its probe may connect to although the probe’s target policy
        refuses them. They do not travel: moving the device under another probe clears them.
      </p>
      {stored.length === 0 ? (
        <p>None. The probe’s target policy holds for every address of this device.</p>
      ) : (
        <ul aria-label="Excepted addresses" className="space-y-1">
          {stored.map((address) => (
            <li key={address} className="font-mono">
              {address}
            </li>
          ))}
        </ul>
      )}

      {!editable && <p className="text-xs text-text-muted">Only an administrator can change it.</p>}

      {editable && (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            save(wanted);
          }}
        >
          <label htmlFor={fieldId} className="block font-medium">
            Excepted addresses
          </label>
          <textarea
            id={fieldId}
            aria-describedby={helpId}
            value={text}
            rows={Math.min(Math.max(wanted.length + 1, 2), 8)}
            spellCheck={false}
            disabled={saving}
            onChange={(event) => {
              setText(event.target.value);
              setSaved(null);
              setFailed(null);
            }}
            className="w-full max-w-md border border-control bg-surface px-2 py-1 font-mono text-sm text-text"
          />
          <p id={helpId} className="text-xs text-text-muted">
            One address per line, at most 16. An address only: not a name, a range or a zone, and
            never a cloud instance-metadata service. A probe older than protocol 28 ignores it.
          </p>
          {/* The buttons and the two regions under them are one block, the form's last child, so
              the regions put no space under the buttons while they say nothing (`U-52`). */}
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="submit"
                disabled={saving || !dirty}
                className="border border-accent bg-accent px-3 py-1 text-sm font-medium text-accent-contrast disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save exception'}
              </button>
              {stored.length > 0 && (
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => {
                    save([]);
                  }}
                  className="border border-control px-3 py-1 text-sm text-text-muted hover:text-text disabled:opacity-50"
                >
                  Clear exception
                </button>
              )}
            </div>
            {/* Both regions always there and empty until they speak (`U-41`, `U-54`), and taking
              no space while they say nothing (`U-45`). */}
            <div role="status" className="mt-2 text-xs empty:mt-0">
              {saved !== null && !dirty && (
                <p className="text-up-fg">
                  {saved === 'cleared' ? 'Cleared.' : 'Saved.'} The probe picks the change up on its
                  next configuration push; no restart is needed.
                </p>
              )}
            </div>
            <div role="alert" className="mt-2 empty:mt-0">
              {failed !== null && (
                <p className="text-xs text-down-fg">
                  {failed.message}
                  {failed.status === 412 &&
                    ' — somebody else changed this device since the page was opened. Reload to' +
                      ' see their change before saving over it.'}
                  <CorrelationId id={failed.correlationId} />
                </p>
              )}
            </div>
          </div>
        </form>
      )}
    </div>
  );
}
