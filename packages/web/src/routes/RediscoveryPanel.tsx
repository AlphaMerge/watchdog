import { useCallback, useMemo, useState } from 'react';
import { ApiError, send, useApi } from '../api/client';
import type {
  DeviceTemplateSummary,
  ObjectPage,
  RediscoveryCadence,
  RediscoveryRule,
  ScheduleSummary,
} from '../api/types';
import { Card, CorrelationId, Empty, ErrorPanel, Loading } from '../components/Panels';
import { descendantsOf } from './discovery-model';
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
 */
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

  const names = useMemo(() => {
    const byId = new Map<number, string>();
    for (const one of [...probes, ...groups]) byId.set(one.id, one.name);
    return byId;
  }, [probes, groups]);

  const act = useCallback(
    (rule: RediscoveryRule, change: () => Promise<unknown>, failed: string) => {
      setBusy(rule.id);
      setProblem(null);
      change()
        .then(() => {
          rules.reload();
        })
        .catch((failure: unknown) => {
          setProblem(failure instanceof ApiError ? failure : new ApiError(0, 'UNKNOWN', failed));
        })
        .finally(() => {
          setBusy(null);
          setConfirming(null);
        });
    },
    [rules],
  );

  if (rules.status === 'loading') return <Loading what="rediscovery rules" />;
  if (rules.status === 'error') return <ErrorPanel error={rules.error} retry={rules.retry} />;
  const windowList = windows.status === 'ready' ? windows.data.items : [];

  return (
    <Card
      title="Rediscovery rules"
      actions={
        editing === null ? (
          <button
            type="button"
            onClick={() => {
              setProblem(null);
              setEditing('new');
            }}
            className="border border-border px-2 py-1 text-sm text-text hover:bg-surface"
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

      {editing !== null && (
        <RuleForm
          rule={editing === 'new' ? null : editing}
          probes={probes}
          groups={groups}
          templates={templates}
          windows={windowList}
          onSaved={() => {
            setEditing(null);
            rules.reload();
          }}
          onCancel={() => {
            setEditing(null);
          }}
          onStale={() => {
            setEditing(null);
            rules.reload();
          }}
        />
      )}

      {/* A refused switch or delete. **Always there, empty until a refusal** (`U-54`, as `U-48`
          did): focus is on the row's button when the core refuses, and a region added with its
          text already in it is not reliably announced (`U-41`). `act` empties it as an attempt
          starts, so a second refusal in the same words is said again; `empty:mt-0` gives back
          its margin while it says nothing (`U-45`). */}
      <p role="alert" className="mt-3 text-sm text-down-fg empty:mt-0">
        {problem?.message}
        <CorrelationId id={problem?.correlationId} />
      </p>

      {rules.data.items.length === 0 ? (
        <div className="mt-3">
          <Empty because="Nothing rediscovers on its own until somebody writes a rule.">
            No rules.
          </Empty>
        </div>
      ) : (
        <ul className="mt-3 divide-y divide-border" aria-label="Rediscovery rules">
          {rules.data.items.map((rule) => {
            const status = ruleStatus(rule);
            const where = `${names.get(rule.groupId) ?? `group ${String(rule.groupId)}`}, from ${
              names.get(rule.probeId) ?? `probe ${String(rule.probeId)}`
            }`;
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
                  <button
                    type="button"
                    disabled={busy === rule.id}
                    onClick={() => {
                      act(
                        rule,
                        () =>
                          send('POST', `/discovery/schedules/${String(rule.id)}/enabled`, {
                            enabled: !rule.enabled,
                          }),
                        'the rule could not be switched',
                      );
                    }}
                    className="border border-border px-2 py-1 text-sm text-text hover:bg-surface disabled:opacity-50"
                  >
                    {rule.enabled ? `Switch off ${rule.name}` : `Switch on ${rule.name}`}
                  </button>
                  <button
                    type="button"
                    disabled={busy === rule.id || editing !== null}
                    onClick={() => {
                      setProblem(null);
                      setEditing(rule);
                    }}
                    className="border border-border px-2 py-1 text-sm text-text hover:bg-surface disabled:opacity-50"
                  >
                    Edit <span className="sr-only">{rule.name}</span>
                  </button>
                  {confirming === rule.id ? (
                    <span className="flex items-center gap-2" role="group" aria-label="Confirm">
                      <span className="text-sm text-text">Delete {rule.name}?</span>
                      <button
                        type="button"
                        disabled={busy === rule.id}
                        onClick={() => {
                          act(
                            rule,
                            () => send('DELETE', `/discovery/schedules/${String(rule.id)}`),
                            'the rule could not be deleted',
                          );
                        }}
                        className="border border-down-fg px-2 py-1 text-sm text-down-fg hover:bg-surface disabled:opacity-50"
                      >
                        Delete
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setConfirming(null);
                        }}
                        className="border border-border px-2 py-1 text-sm text-text hover:bg-surface"
                      >
                        Keep
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      disabled={busy === rule.id}
                      onClick={() => {
                        setConfirming(rule.id);
                      }}
                      className="border border-border px-2 py-1 text-sm text-text hover:bg-surface disabled:opacity-50"
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
  onSaved: () => void;
  onCancel: () => void;
  onStale: () => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState<RuleDraft>(() =>
    rule === null ? EMPTY_RULE : draftFromRule(rule),
  );
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const change = (next: Partial<RuleDraft>): void => {
    setDraft((current) => ({ ...current, ...next }));
  };

  const underProbe = useMemo(
    () => (draft.probeId === null ? [] : descendantsOf(groups, draft.probeId)),
    [groups, draft.probeId],
  );
  const blocked = whyNotSavable(draft);
  const groupName = groups.find((group) => group.id === draft.groupId)?.name;

  const save = (): void => {
    setSaving(true);
    setFailure(null);
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
      .then(onSaved)
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
        if (blocked === null && !unchanged) save();
      }}
    >
      <h3 className="text-sm font-medium text-text">
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
                const probeId = event.target.value === '' ? null : Number(event.target.value);
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
        <button
          type="submit"
          disabled={blocked !== null || unchanged || saving}
          className="border border-accent bg-accent px-3 py-1 text-sm font-medium text-accent-contrast disabled:opacity-50"
        >
          {saving ? 'Saving…' : rule === null ? 'Create the rule (off)' : 'Save changes'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="border border-border px-3 py-1 text-sm text-text hover:bg-surface"
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
