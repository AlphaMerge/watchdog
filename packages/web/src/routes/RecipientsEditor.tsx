import { useMemo, useState } from 'react';
import { useApi } from '../api/client';
import type { AccountChoice, TemplateRecipient, UserGroupView } from '../api/types';
import { Combobox, type ComboboxOption } from '../components/Combobox';
import {
  accountChoices,
  describeRecipient,
  groupChoices,
  matching,
  RECIPIENT_KINDS,
  withKind,
  type Choice,
} from './recipients-model';

/**
 * Who a template sends to: addresses, and for an administrator, users and groups (`M-20`).
 *
 * **Users and groups are chosen, never typed.** The core stores them by id, because a login or a
 * group name can change and a template that followed the old name would page somebody else
 * (`M-19`). So a picker names them, and what is saved is the id of the one picked.
 *
 * **A writer who is not an administrator is told why, not offered a list that fails.** The lists
 * are `ADMIN`, so this editor never asks for them on that writer's behalf. They edit addresses as
 * before, and a user or a group already on the template stays exactly as it was, shown by its id,
 * and can still be removed.
 */
export function RecipientsEditor({
  items,
  onChange,
  choosePeople,
}: {
  readonly items: readonly TemplateRecipient[];
  readonly onChange: (next: TemplateRecipient[]) => void;
  readonly choosePeople: boolean;
}): React.JSX.Element {
  // One request per list for the whole editor, not one per row, and none at all for a writer who
  // may not read them.
  const accounts = useApi<{ items: AccountChoice[] }>(choosePeople ? '/accounts' : null);
  const groups = useApi<{ items: UserGroupView[] }>(choosePeople ? '/groups' : null);
  const accountList = choosePeople && accounts.status === 'ready' ? accounts.data.items : null;
  const groupList = choosePeople && groups.status === 'ready' ? groups.data.items : null;

  const replace = (index: number, next: TemplateRecipient): void => {
    const all = [...items];
    all[index] = next;
    onChange(all);
  };

  return (
    <fieldset className="space-y-2 border border-border px-3 pb-3 pt-1">
      <legend className="px-1 text-xs font-medium uppercase tracking-wide text-text-muted">
        Recipients
      </legend>
      {!choosePeople && (
        <p className="text-xs text-text-muted">
          Users and groups are chosen by an administrator. Any already here are kept as they are,
          and you can still remove them.
        </p>
      )}
      {items.length === 0 && (
        <p className="text-xs text-text-muted">
          None. A template with no recipients delivers to nobody.
        </p>
      )}
      <ul className="space-y-2" aria-label="Recipients">
        {items.map((recipient, index) => {
          const number = String(index + 1);
          const rowId = `recipient-${String(index)}`;
          const list = recipient.kind === 'user' ? accounts : groups;
          return (
            <li key={index} className="flex flex-wrap items-center gap-2">
              {choosePeople ? (
                <>
                  <label className="sr-only" htmlFor={`${rowId}-kind`}>
                    Recipient {number}: kind
                  </label>
                  <select
                    id={`${rowId}-kind`}
                    value={recipient.kind}
                    onChange={(event) => {
                      const kind = RECIPIENT_KINDS.find((one) => one.kind === event.target.value);
                      if (kind !== undefined) replace(index, withKind(recipient, kind.kind));
                    }}
                    className="border border-control bg-surface px-2 py-1 text-sm text-text"
                  >
                    {RECIPIENT_KINDS.map((one) => (
                      <option key={one.kind} value={one.kind}>
                        {one.label}
                      </option>
                    ))}
                  </select>
                </>
              ) : (
                recipient.kind !== 'address' && (
                  <span className="text-xs font-medium uppercase tracking-wide text-text-muted">
                    {recipient.kind === 'user' ? 'User' : 'Group'}
                  </span>
                )
              )}

              {recipient.kind === 'address' ? (
                <>
                  <label className="sr-only" htmlFor={rowId}>
                    Recipient {number}: address
                  </label>
                  <input
                    id={rowId}
                    value={recipient.value}
                    onChange={(event) => {
                      replace(index, { ...recipient, value: event.target.value });
                    }}
                    className="w-64 border border-control bg-surface px-2 py-1 text-sm text-text"
                  />
                </>
              ) : choosePeople ? (
                <PersonPicker
                  id={rowId}
                  label={`Recipient ${number}: ${recipient.kind === 'user' ? 'account' : 'group'}`}
                  loading={list.status === 'loading'}
                  failed={list.status === 'error' ? list.error.message : null}
                  choices={
                    recipient.kind === 'user'
                      ? accountChoices(accountList ?? [])
                      : groupChoices(groupList ?? [])
                  }
                  chosen={describeRecipient(recipient, accountList, groupList)}
                  onPick={(id) => {
                    replace(index, { ...recipient, value: String(id) });
                  }}
                />
              ) : (
                <span className="text-sm text-text">
                  {describeRecipient(recipient, null, null)}
                </span>
              )}

              <button
                type="button"
                aria-label={`Remove recipient ${number}`}
                onClick={() => {
                  onChange(items.filter((_, at) => at !== index));
                }}
                className="border border-control px-2 py-0.5 text-xs text-text-muted hover:text-text"
              >
                Remove
              </button>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        onClick={() => {
          onChange([...items, { kind: 'address', value: '' }]);
        }}
        className="border border-control px-2 py-1 text-xs text-text-muted hover:text-text"
      >
        Add a recipient
      </button>
    </fieldset>
  );
}

/**
 * One account or one group, found by typing (`M-20`).
 *
 * The same `Combobox` the sensor-type search and the map designer use, so the keyboard is the one
 * already proved: nothing is chosen until Enter or a click, and focus stays in the box. What is
 * chosen is said in words beside it, since the box itself holds what is being typed, and the box
 * is described by those words so a screen reader says them too.
 */
function PersonPicker({
  id,
  label,
  loading,
  failed,
  choices,
  chosen,
  onPick,
}: {
  readonly id: string;
  readonly label: string;
  readonly loading: boolean;
  readonly failed: string | null;
  readonly choices: readonly Choice[];
  readonly chosen: string;
  readonly onPick: (id: number) => void;
}): React.JSX.Element {
  const [typed, setTyped] = useState('');
  const found = useMemo(() => matching(choices, typed), [choices, typed]);
  const byName = useMemo(() => new Map(choices.map((one) => [one.name, one.id])), [choices]);
  const options = useMemo<ComboboxOption[]>(
    () =>
      found.map((one) => ({
        value: one.name,
        detail: one.detail,
        ...(one.badge === undefined ? {} : { badge: one.badge }),
      })),
    [found],
  );

  if (failed !== null) {
    return (
      <span role="alert" className="text-xs text-down-fg">
        Could not load the list: {failed}
      </span>
    );
  }

  return (
    <span className="flex flex-wrap items-center gap-2">
      <span className="text-sm text-text" id={`${id}-chosen`}>
        {chosen}
      </span>
      <Combobox
        id={id}
        label={label}
        placeholder={loading ? 'Loading…' : 'Search to change…'}
        value={typed}
        onChange={setTyped}
        onPick={(option) => {
          const picked = byName.get(option.value);
          if (picked === undefined) return;
          setTyped('');
          onPick(picked);
        }}
        options={options}
        className="w-56"
        describedBy={`${id}-chosen`}
      />
    </span>
  );
}
