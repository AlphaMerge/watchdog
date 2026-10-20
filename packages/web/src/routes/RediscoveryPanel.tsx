import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, send, useApi } from '../api/client';
import type {
  DeviceTemplateSummary,
  ObjectPage,
  RediscoveryCadence,
  RediscoveryRule,
  ScheduleSummary,
} from '../api/types';
import { Card, CorrelationId, Empty } from '../components/Panels';
import { ReadRegion, ReadState } from '../components/ReadRegion';
import {
  PROBE_ABOVE,
  PROBE_ABOVE_LABEL,
  groupsFor,
  groupsUnderUnseenProbe,
  probeChoiceOf,
} from './discovery-model';
import { Field, INPUT, SELECT, TemplatePicker } from './discovery-fields';
import {
  EMPTY_RULE,
  WEEKDAYS,
  createBody,
  draftFromRule,
  ifMatch,
  isStale,
  patchBody,
  ruleStatus,
  whyNotSavable,
  type RuleDraft,
} from './rediscovery-model';

/**
 * Rediscovery rules on the discovery page (`D-11`).
 *
 * **The API had these since `D-07` and the web had nothing**, so a rule could be made only with
 * `curl`, and a rule refused every night (`A-28`) said so only to somebody reading JSON. The
 * list leads with that: a rule's status line puts a refused firing before anything else.
 *
 * **Off by default, twice, as `D-07` decided.** A new rule is created off, and provisioning is a
 * separate box that is also off, so the first thing a rule does when switched on is sweep and
 * leave a plan somebody reads. Switching on is its own button on the row, not a field in the
 * form, because it is the moment a rule starts sending packets and deserves to be a decision.
 *
 * **An edit sends what changed and the version it was made against**, and a refusal because
 * somebody else saved first says so and offers the rule as it now is.
 *
 * **Focus is put where it is next needed after every action** (`U-23` review, WCAG 2.4.3). It
 * used to fall to the page after nearly all of them: the button pressed was taken away (New rule,
 * Delete, Keep, the form's), disabled as it was pressed (Edit, a switch, the confirmed Delete), or
 * went with the whole list while it was read again. Now the form's heading takes it as the form
 * opens; Cancel and *Show the rule as it is now* give it back to the button that opened the form;
 * a delete asked about puts it on the question, and Keep back on Delete; a save or a delete puts it
 * on the line that says what was done; a switch and a confirmed Delete keep it while they are out,
 * unavailable rather than disabled; and the list stays on screen while it is read again.
 */

/** Where focus is owed once the panel has its new shape. */
type FocusTarget =
  | { readonly to: 'new' }
  | { readonly to: 'notice' }
  | { readonly to: 'edit' | 'delete'; readonly id: number };
export function RediscoveryPanel({
  probes,
  groups,
  templates,
}: {
  probes: ObjectPage['items'];
  groups: ObjectPage['items'];
  templates: DeviceTemplateSummary[];
}): React.JSX.Element {
  const rules = useApi<{ items: RediscoveryRule[] }>('/discovery/schedules');
  const windows = useApi<{ items: ScheduleSummary[] }>('/schedules');
  /** `null` is the list; `'new'` is a rule being written; a rule is that rule being edited. */
  const [editing, setEditing] = useState<RediscoveryRule | 'new' | null>(null);
  const [problem, setProblem] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [confirming, setConfirming] = useState<number | null>(null);
  /** What the last save or delete did, said and left on screen, and focused (`U-23` review). */
  const [notice, setNotice] = useState<string | null>(null);
  const [owed, setOwed] = useState<FocusTarget | null>(null);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const newButton = useRef<HTMLButtonElement>(null);
  const editButtons = useRef(new Map<number, HTMLButtonElement>());
  const deleteButtons = useRef(new Map<number, HTMLButtonElement>());

  // **The list as last read stays on screen while it is read again** (`U-23` review), and when
  // that read fails, which is said above it. `useApi` goes back to `loading` for a reload, which
  // took the whole panel down after every switch, save and delete, and the focus with it.
  const [held, setHeld] = useState<RediscoveryRule[] | null>(null);
  if (rules.status === 'ready' && rules.data.items !== held) setHeld(rules.data.items);
  const items = rules.status === 'ready' ? rules.data.items : held;

  const names = useMemo(() => {
    const byId = new Map<number, string>();
    for (const one of [...probes, ...groups]) byId.set(one.id, one.name);
    return byId;
  }, [probes, groups]);

  // Given once the target is on the page, and only from the page or from inside the panel: an
  // operator who moved on while a request was out is left where they are. A target that is not
  // there once the list has been read — a rule somebody else deleted — is owed nothing.
  const reloading = rules.status !== 'ready';
  useEffect(() => {
    if (owed === null) return;
    const target =
      owed.to === 'new'
        ? newButton.current
        : owed.to === 'notice'
          ? noticeRef.current
          : (owed.to === 'edit' ? editButtons : deleteButtons).current.get(owed.id);
    if ((target === null || target === undefined) && reloading) return;
    setOwed(null);
    // The panel is the card the notice is in, which is there whenever the list is.
    const card = noticeRef.current?.closest('section');
    const at = document.activeElement;
    const ours = at === null || at === document.body || (card?.contains(at) ?? false);
    if (ours) target?.focus();
  }, [owed, reloading, items]);

  const act = useCallback(
    (
      rule: RediscoveryRule,
      change: () => Promise<unknown>,
      failed: string,
      after: { done?: () => void; refused?: () => void } = {},
    ) => {
      setBusy(rule.id);
      setProblem(null);
      setNotice(null);
      change()
        .then(() => {
          after.done?.();
          rules.reload();
        })
        .catch((failure: unknown) => {
          setProblem(failure instanceof ApiError ? failure : new ApiError(0, 'UNKNOWN', failed));
          after.refused?.();
        })
        .finally(() => {
          setBusy(null);
          setConfirming(null);
        });
    },
    [rules],
  );

  if (items === null) return <ReadState read={rules} what="rediscovery rules" />;
  const windowList = windows.status === 'ready' ? windows.data.items : [];
  const opener = (rule: RediscoveryRule | 'new'): FocusTarget =>
    rule === 'new' ? { to: 'new' } : { to: 'edit', id: rule.id };

  return (
    <Card
      title="Rediscovery rules"
      actions={
        editing === null ? (
          <button
            ref={newButton}
            type="button"
            onClick={() => {
              setProblem(null);
              setNotice(null);
              setEditing('new');
            }}
            // The control grey, as every button here is (`U-87`): they were edged in the hairline,
            // 1.36:1 on the light surface where 1.4.11 asks 3:1 of a control's edge.
            className="border border-control px-2 py-1 text-sm text-text hover:bg-surface"
          >
            New rule
          </button>
        ) : undefined
      }
    >
      <p className="text-sm text-text-muted">
        A rule runs a discovery on a schedule. A new rule is off, and whether it creates what it
        finds is a separate choice: without it, each run leaves a plan for somebody to review.
      </p>

      {/* What a save or a delete did. Always in the document, so it is said as it is written
          rather than only when the region is new, and focusable, because the control used to get
          here has gone (`U-23` review), as the Credentials tab's notice is (`U-21`). */}
      <p
        ref={noticeRef}
        role="status"
        aria-live="polite"
        tabIndex={-1}
        className={
          notice === null
            ? 'sr-only'
            : 'mt-3 border border-border bg-surface px-3 py-2 text-sm text-text'
        }
      >
        {notice ?? ''}
      </p>

      {editing !== null && (
        <RuleForm
          rule={editing === 'new' ? null : editing}
          probes={probes}
          groups={groups}
          templates={templates}
          windows={windowList}
          onSaved={(name) => {
            setNotice(
              editing === 'new'
                ? `Created ${name}. It is off until it is switched on from its row.`
                : `Saved ${name}.`,
            );
            setOwed({ to: 'notice' });
            setEditing(null);
            rules.reload();
          }}
          onCancel={() => {
            setOwed(opener(editing));
            setEditing(null);
          }}
          onStale={() => {
            setOwed(opener(editing));
            setEditing(null);
            rules.reload();
          }}
        />
      )}

      {/* A refused switch or delete. **Always there, empty until a refusal** (`U-54`, as `U-48`
          did): focus is on the row's button when the core refuses — a switch keeps it, being
          unavailable rather than disabled while it is out, and a refused delete gives it back to
          the row's Delete (`U-23` review) — and a region added with its text already in it is not
          reliably announced (`U-41`). `act` empties it as an attempt starts, so a second refusal
          in the same words is said again; `empty:mt-0` gives back its margin while it says
          nothing (`U-45`). */}
      <p role="alert" className="mt-3 text-sm text-down-fg empty:mt-0">
        {problem?.message}
        <CorrelationId id={problem?.correlationId} />
      </p>

      {/* The list could not be read again after a change that was made: it stays, said to be the
          old one, with *Try again*, in a region there, empty, while the list is (`U-58`). */}
      <ReadRegion
        error={rules.status === 'error' ? rules.error : null}
        retry={rules.retry}
        className="mt-3 empty:mt-0"
      >
        <p className="text-sm text-text">
          The rules below could not be read again, so they may not show the last change.
        </p>
      </ReadRegion>

      {items.length === 0 ? (
        <div className="mt-3">
          <Empty because="Nothing rediscovers on its own until somebody writes a rule.">
            No rules.
          </Empty>
        </div>
      ) : (
        <ul className="mt-3 divide-y divide-border" aria-label="Rediscovery rules">
          {items.map((rule) => {
            const status = ruleStatus(rule);
            // No probe id is a probe its reader cannot see (`A-80`), said as such and not as a
            // number nobody can look up.
            const probe =
              rule.probeId === undefined
                ? 'the probe above it'
                : (names.get(rule.probeId) ?? `probe ${String(rule.probeId)}`);
            const where = `${names.get(rule.groupId) ?? `group ${String(rule.groupId)}`}, from ${probe}`;
            return (
              <li key={rule.id} className="py-3">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <h3 className="text-sm font-medium text-text">{rule.name}</h3>
                  <span className="text-sm text-text-muted">
                    {rule.range}, {rule.description}, into {where}
                  </span>
                </div>
                <p
                  className={`mt-1 text-sm ${
                    status.tone === 'problem'
                      ? 'text-warning-fg'
                      : status.tone === 'on'
                        ? 'text-text'
                        : 'text-text-muted'
                  }`}
                >
                  {status.text}
                </p>
                <p className="mt-1 text-xs text-text-muted">
                  {rule.autoProvision
                    ? 'Creates the devices it finds.'
                    : 'Leaves a plan to review; creates nothing.'}{' '}
                  {rule.lastRunAt === null
                    ? 'Has not run yet.'
                    : `Last ran ${new Date(rule.lastRunAt).toLocaleString()}${
                        rule.lastRunId === null ? '' : ` (run ${String(rule.lastRunId)})`
                      }.`}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {/* Unavailable while it is out, not `disabled`, so it keeps the focus it was
                      pressed with (`U-23` review); a press then sends nothing. */}
                  <button
                    type="button"
                    aria-disabled={busy === rule.id}
                    onClick={() => {
                      if (busy === rule.id) return;
                      act(
                        rule,
                        () =>
                          send('POST', `/discovery/schedules/${String(rule.id)}/enabled`, {
                            enabled: !rule.enabled,
                          }),
                        'the rule could not be switched',
                      );
                    }}
                    className="border border-control px-2 py-1 text-sm text-text hover:bg-surface aria-disabled:opacity-50"
                  >
                    {rule.enabled ? `Switch off ${rule.name}` : `Switch on ${rule.name}`}
                  </button>
                  {/* Disabled as it is pressed, which is safe: the form's heading takes focus. */}
                  <button
                    ref={(node) => {
                      if (node === null) editButtons.current.delete(rule.id);
                      else editButtons.current.set(rule.id, node);
                    }}
                    type="button"
                    disabled={busy === rule.id || editing !== null}
                    onClick={() => {
                      setProblem(null);
                      setNotice(null);
                      setEditing(rule);
                    }}
                    className="border border-control px-2 py-1 text-sm text-text hover:bg-surface disabled:opacity-50"
                  >
                    Edit <span className="sr-only">{rule.name}</span>
                  </button>
                  {confirming === rule.id ? (
                    <ConfirmDelete
                      name={rule.name}
                      busy={busy === rule.id}
                      onDelete={() => {
                        act(
                          rule,
                          () => send('DELETE', `/discovery/schedules/${String(rule.id)}`),
                          'the rule could not be deleted',
                          {
                            done: () => {
                              setNotice(`Deleted ${rule.name}.`);
                              setOwed({ to: 'notice' });
                            },
                            refused: () => {
                              setOwed({ to: 'delete', id: rule.id });
                            },
                          },
                        );
                      }}
                      onKeep={() => {
                        setConfirming(null);
                        setOwed({ to: 'delete', id: rule.id });
                      }}
                    />
                  ) : (
                    <button
                      ref={(node) => {
                        if (node === null) deleteButtons.current.delete(rule.id);
                        else deleteButtons.current.set(rule.id, node);
                      }}
                      type="button"
                      disabled={busy === rule.id}
                      onClick={() => {
                        setNotice(null);
                        setConfirming(rule.id);
                      }}
                      className="border border-control px-2 py-1 text-sm text-text hover:bg-surface disabled:opacity-50"
                    >
                      Delete <span className="sr-only">{rule.name}</span>
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

/**
 * The question a row's Delete asks (`U-23` review). **Focus goes to it as it opens**: the button
 * pressed is gone, and a reader on the page heard nothing of the question. A group that can take
 * focus, named for what it asks, as the Credentials tab's removal is (`U-21`). Its Delete and Keep
 * are unavailable while the delete is out, not disabled, so the one pressed keeps focus.
 */
function ConfirmDelete({
  name,
  busy,
  onDelete,
  onKeep,
}: {
  name: string;
  busy: boolean;
  onDelete: () => void;
  onKeep: () => void;
}): React.JSX.Element {
  const group = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    group.current?.focus();
  }, []);
  return (
    <span
      ref={group}
      tabIndex={-1}
      className="flex items-center gap-2"
      role="group"
      aria-label={`Confirm deleting ${name}`}
    >
      <span className="text-sm text-text">Delete {name}?</span>
      <button
        type="button"
        aria-disabled={busy}
        onClick={() => {
          if (!busy) onDelete();
        }}
        className="border border-down-fg px-2 py-1 text-sm text-down-fg hover:bg-surface aria-disabled:opacity-50"
      >
        Delete
      </button>
      <button
        type="button"
        aria-disabled={busy}
        onClick={() => {
          if (!busy) onKeep();
        }}
        className="border border-control px-2 py-1 text-sm text-text hover:bg-surface aria-disabled:opacity-50"
      >
        Keep
      </button>
    </span>
  );
}

// ── the form ────────────────────────────────────────────────────────────────────────────────

function RuleForm({
  rule,
  probes,
  groups,
  templates,
  windows,
  onSaved,
  onCancel,
  onStale,
}: {
  /** The rule being edited, or null for a new one. */
  rule: RediscoveryRule | null;
  probes: ObjectPage['items'];
  groups: ObjectPage['items'];
  templates: DeviceTemplateSummary[];
  windows: ScheduleSummary[];
  /** Saved, under the name it was saved with. */
  onSaved: (name: string) => void;
  onCancel: () => void;
  onStale: () => void;
}): React.JSX.Element {
  // **Focus comes to the form as it opens** (`U-23` review): the button that opened it is gone or
  // disabled, and focus fell to the page with it.
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  const [draft, setDraft] = useState<RuleDraft>(() =>
    rule === null ? EMPTY_RULE : draftFromRule(rule),
  );
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const change = (next: Partial<RuleDraft>): void => {
    setDraft((current) => ({ ...current, ...next }));
  };

  const underProbe = useMemo(
    () => groupsFor(draft.probeId, probes, groups),
    [probes, groups, draft.probeId],
  );
  // Offered where there is such a group, and always for a rule whose probe is one of them.
  const unseen = useMemo(
    () => draft.probeId === PROBE_ABOVE || groupsUnderUnseenProbe(probes, groups).length > 0,
    [probes, groups, draft.probeId],
  );
  const blocked = whyNotSavable(draft);
  const groupName = groups.find((group) => group.id === draft.groupId)?.name;

  const save = (): void => {
    setSaving(true);
    setFailure(null);
    const name = draft.name.trim();
    const request =
      rule === null
        ? send('POST', '/discovery/schedules', createBody(draft))
        : send(
            'PATCH',
            `/discovery/schedules/${String(rule.id)}`,
            patchBody(rule, draft),
            ifMatch(rule),
          );
    request
      .then(() => {
        onSaved(name);
      })
      .catch((error: unknown) => {
        setFailure(
          error instanceof ApiError
            ? error
            : new ApiError(0, 'UNKNOWN', 'the rule could not be saved'),
        );
      })
      .finally(() => {
        setSaving(false);
      });
  };

  const unchanged = rule !== null && Object.keys(patchBody(rule, draft)).length === 0;

  return (
    <form
      aria-label={rule === null ? 'New rediscovery rule' : `Edit ${rule.name}`}
      className="mt-4 border border-border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        // Enter in a box, or the button pressed again, while the save is out: it only says it is
        // unavailable (below), so this is what keeps it to one request.
        if (blocked === null && !unchanged && !saving) save();
      }}
    >
      <h3 ref={heading} tabIndex={-1} className="text-sm font-medium text-text">
        {rule === null ? 'New rule' : `Editing ${rule.name}`}
      </h3>

      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <Field label="Name">
          {(describedBy) => (
            <input
              className={INPUT}
              aria-describedby={describedBy}
              value={draft.name}
              maxLength={200}
              onChange={(event) => {
                change({ name: event.target.value });
              }}
            />
          )}
        </Field>
        <Field label="Range" hint="10.0.0.0/24, 10.0.0.1-10.0.0.50, or a single address.">
          {(describedBy) => (
            <input
              className={INPUT}
              aria-describedby={describedBy}
              spellCheck={false}
              value={draft.range}
              onChange={(event) => {
                change({ range: event.target.value });
              }}
            />
          )}
        </Field>

        <Field
          label="Probe"
          hint={
            rule === null
              ? 'The one that can reach this network.'
              : 'It has to be the probe the group is under. If the group has moved, choose its new probe here.'
          }
        >
          {(describedBy) => (
            <select
              className={SELECT}
              aria-describedby={describedBy}
              value={draft.probeId ?? ''}
              onChange={(event) => {
                const probeId = probeChoiceOf(event.target.value);
                // A new rule's group is cleared with its probe, as on the form above; an edited
                // rule keeps its group, which is the one thing an edit cannot change.
                change(rule === null ? { probeId, groupId: null } : { probeId });
              }}
            >
              <option value="">Choose a probe…</option>
              {probes.map((probe) => (
                <option key={probe.id} value={probe.id}>
                  {probe.name}
                </option>
              ))}
              {unseen && <option value={PROBE_ABOVE}>{PROBE_ABOVE_LABEL}</option>}
            </select>
          )}
        </Field>

        {rule === null ? (
          <Field label="Group" hint="Where the devices it finds are created.">
            {(describedBy) => (
              <select
                className={SELECT}
                aria-describedby={describedBy}
                value={draft.groupId ?? ''}
                disabled={draft.probeId === null}
                onChange={(event) => {
                  change({
                    groupId: event.target.value === '' ? null : Number(event.target.value),
                  });
                }}
              >
                <option value="">
                  {draft.probeId === null ? 'Choose a probe first' : 'Choose a group…'}
                </option>
                {underProbe.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        ) : (
          <div>
            <span className="block text-sm font-medium text-text">Group</span>
            <p className="mt-1 text-sm text-text">{groupName ?? `group ${String(rule.groupId)}`}</p>
            <p className="mt-1 text-xs text-text-muted">
              A rule stays in its group. For another group, write another rule.
            </p>
          </div>
        )}
      </div>

      <fieldset className="mt-4">
        <legend className="text-sm font-medium text-text">When</legend>
        <div className="mt-2 grid gap-4 sm:grid-cols-3">
          <Field label="Every">
            {(describedBy) => (
              <select
                className={SELECT}
                aria-describedby={describedBy}
                value={draft.cadence}
                onChange={(event) => {
                  const cadence = event.target.value as RediscoveryCadence;
                  // The time box means something else for an hourly rule, so it starts again
                  // rather than carrying `03:00` into a box that wants minutes.
                  change({
                    cadence,
                    at:
                      cadence === 'hourly' ? '0' : draft.cadence === 'hourly' ? '03:00' : draft.at,
                  });
                }}
              >
                <option value="hourly">hour</option>
                <option value="daily">day</option>
                <option value="weekly">week</option>
              </select>
            )}
          </Field>
          {draft.cadence === 'weekly' && (
            <Field label="On">
              {(describedBy) => (
                <select
                  className={SELECT}
                  aria-describedby={describedBy}
                  value={draft.weekday}
                  onChange={(event) => {
                    change({ weekday: Number(event.target.value) });
                  }}
                >
                  {WEEKDAYS.map((day, index) => (
                    <option key={day} value={index}>
                      {day}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          )}
          <Field
            label={draft.cadence === 'hourly' ? 'Minutes past the hour' : 'At'}
            hint={draft.cadence === 'hourly' ? '0 to 59.' : 'HH:MM, in the time zone below.'}
          >
            {(describedBy) => (
              <input
                className={INPUT}
                aria-describedby={describedBy}
                inputMode={draft.cadence === 'hourly' ? 'numeric' : 'text'}
                value={draft.at}
                onChange={(event) => {
                  change({ at: event.target.value });
                }}
              />
            )}
          </Field>
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field label="Time zone" hint="Europe/Berlin, for example. Empty is the core’s own.">
            {(describedBy) => (
              <input
                className={INPUT}
                aria-describedby={describedBy}
                spellCheck={false}
                value={draft.timezone}
                onChange={(event) => {
                  change({ timezone: event.target.value });
                }}
              />
            )}
          </Field>
          <Field
            label="Only while"
            hint="A schedule used as a permitted window: the run waits for the next time it is open."
          >
            {(describedBy) => (
              <select
                className={SELECT}
                aria-describedby={describedBy}
                value={draft.windowId ?? ''}
                onChange={(event) => {
                  change({
                    windowId: event.target.value === '' ? null : Number(event.target.value),
                  });
                }}
              >
                <option value="">any time</option>
                {windows.map((window) => (
                  <option key={window.id} value={window.id}>
                    {window.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
      </fieldset>

      <fieldset className="mt-4">
        <legend className="text-sm font-medium text-text">How hard to look</legend>
        <div className="mt-2 flex flex-wrap gap-4">
          {(['ping', 'standard', 'detailed'] as const).map((level) => (
            <label key={level} className="flex items-center gap-2 text-sm text-text">
              <input
                type="radio"
                name={`rule-level-${rule === null ? 'new' : String(rule.id)}`}
                checked={draft.level === level}
                onChange={() => {
                  change({ level });
                }}
              />
              {level}
            </label>
          ))}
        </div>
      </fieldset>

      {draft.level !== 'ping' && (
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {rule === null ? (
            <Field label="SNMP community" hint="Read-only. Left empty, SNMP is skipped.">
              {(describedBy) => (
                <input
                  className={INPUT}
                  type="password"
                  autoComplete="off"
                  aria-describedby={describedBy}
                  value={draft.community}
                  onChange={(event) => {
                    change({ community: event.target.value });
                  }}
                />
              )}
            </Field>
          ) : (
            <CommunityChoice draft={draft} onChange={change} ruleId={rule.id} />
          )}
          <TemplatePicker
            templates={templates}
            chosen={draft.templates}
            onChange={(next) => {
              change({ templates: next });
            }}
          />
        </div>
      )}

      <label className="mt-4 flex items-start gap-2 text-sm text-text">
        <input
          type="checkbox"
          className="mt-1"
          checked={draft.autoProvision}
          onChange={(event) => {
            change({ autoProvision: event.target.checked });
          }}
        />
        <span>
          Create the devices it finds
          <span className="block text-xs text-text-muted">
            Off, each run leaves a plan to review and creates nothing. On, it creates what has
            appeared since the last run, and nothing twice.
          </span>
        </span>
      </label>

      {/* A refused save, in a region always there and empty until one (`U-54`), for the
          reasons the panel's own is; `save` empties it as it starts. */}
      <div role="alert" className="mt-4 text-sm text-down-fg empty:mt-0">
        {failure !== null && (
          <p>
            {failure.message}
            <CorrelationId id={failure.correlationId} />
          </p>
        )}
        {failure !== null && isStale(failure) && (
          <p className="mt-1">
            Somebody else changed this rule since the form was opened.{' '}
            <button
              type="button"
              onClick={onStale}
              className="text-accent underline underline-offset-2"
            >
              Show the rule as it is now
            </button>
          </p>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        {/* **Unavailable while the save is out, not `disabled`** (`U-23` review, as `U-73` made
            the template form's): disabled, it dropped the focus it held to the page as it was
            pressed, and a refusal came back to focus on nothing. Still `disabled` while there is
            nothing to save, when focus is in the box that needs changing. Cancel is unavailable
            the same way, so the form is not closed under a save still out. */}
        <button
          type="submit"
          disabled={blocked !== null || unchanged}
          aria-disabled={saving}
          className="border border-accent bg-accent px-3 py-1 text-sm font-medium text-accent-contrast disabled:opacity-50 aria-disabled:opacity-50"
        >
          {saving ? 'Saving…' : rule === null ? 'Create the rule (off)' : 'Save changes'}
        </button>
        <button
          type="button"
          aria-disabled={saving}
          onClick={() => {
            if (!saving) onCancel();
          }}
          className="border border-control px-3 py-1 text-sm text-text hover:bg-surface aria-disabled:opacity-50"
        >
          Cancel
        </button>
        {blocked !== null && <span className="text-sm text-text-muted">{blocked}</span>}
        {blocked === null && unchanged && (
          <span className="text-sm text-text-muted">Nothing has changed yet.</span>
        )}
      </div>
    </form>
  );
}

/**
 * The stored community on an edit: keep it, replace it, or clear it.
 *
 * The form is never shown the stored one (`P-55`), so an empty box cannot say which of the three
 * is meant; the choice does, and the box appears only for a replacement.
 */
function CommunityChoice({
  draft,
  onChange,
  ruleId,
}: {
  draft: RuleDraft;
  onChange: (next: Partial<RuleDraft>) => void;
  ruleId: number;
}): React.JSX.Element {
  const name = `rule-community-${String(ruleId)}`;
  return (
    <fieldset>
      <legend className="text-sm font-medium text-text">SNMP community</legend>
      <p className="mt-1 text-xs text-text-muted">
        The stored one is never shown. Keeping it sends nothing.
      </p>
      <div className="mt-2 space-y-1">
        {(
          [
            ['keep', 'Keep the stored one'],
            ['replace', 'Replace it'],
            ['clear', 'Remove it, and skip SNMP'],
          ] as const
        ).map(([value, label]) => (
          <label key={value} className="flex items-center gap-2 text-sm text-text">
            <input
              type="radio"
              name={name}
              checked={draft.communityChange === value}
              onChange={() => {
                onChange({
                  communityChange: value,
                  community: value === 'replace' ? draft.community : '',
                });
              }}
            />
            {label}
          </label>
        ))}
      </div>
      {draft.communityChange === 'replace' && (
        <label className="mt-2 block">
          <span className="text-sm font-medium text-text">New community</span>
          <input
            className={INPUT}
            type="password"
            autoComplete="off"
            value={draft.community}
            onChange={(event) => {
              onChange({ community: event.target.value });
            }}
          />
        </label>
      )}
    </fieldset>
  );
}
