import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, request, sameWords, send, useApi } from '../api/client';
import type {
  DeviceTemplateSummary,
  DiscoveryPreview,
  DiscoveryRun,
  DiscoverySummary,
  ObjectPage,
} from '../api/types';
import { Card, CorrelationId, Empty, ErrorPanel, Loading } from '../components/Panels';
import { useRefusal } from '../components/refusal';
import { PageTitle } from '../components/PageTitle';
import { Field, INPUT, SELECT, TemplatePicker } from './discovery-fields';
import { RediscoveryPanel } from './RediscoveryPanel';
import { formatDuration } from './detail/model';
import {
  EMPTY_DRAFT,
  PROBE_ABOVE,
  PROBE_ABOVE_LABEL,
  estimateText,
  groupsFor,
  groupsUnderUnseenProbe,
  isActive,
  isLong,
  orderedLevels,
  phaseOf,
  pollIntervalMs,
  probeChoiceOf,
  probeIdFor,
  progressOf,
  whyNotStartable,
  type DiscoveryDraft,
} from './discovery-model';

/** How long to wait after a keystroke before asking the core what a range means. */
const PREVIEW_DEBOUNCE_MS = 400;

/**
 * Auto-discovery (`D-10`).
 *
 * **The estimate is shown before the choice, not after it.** `D-06` computes what each level
 * costs on *this* range, and the whole point of having written it is that an operator picks
 * `detailed` on a /24 knowing it is a minute and declines it on a /16 knowing it is four hours.
 * A level picker without the numbers beside it is the picker PRTG has, and its warning — "may
 * take days" — is true and helps nobody decide anything.
 *
 * **Progress is polled, and that is a decision rather than an omission.** `U-02`'s WebSocket
 * carries sensor state; a discovery run is not a sensor. It lives for minutes, one operator is
 * watching it, and pushing its progress would mean a new message kind, a subscription for it,
 * and a fan-out to every connected client for something one of them cares about. One request
 * every two seconds against an indexed primary key is cheaper, and it stops the moment the run
 * does — see `pollIntervalMs`.
 *
 * **Nothing here creates anything.** A finished run offers its plan and its summary; turning
 * that into devices is `POST /discovery/:id/provision`, behind its own button, because
 * `WORKFLOW.MD §2` is explicit that surprise objects are a support burden and this is the screen
 * where that promise is either kept or broken.
 */
export function DiscoveryView(): React.JSX.Element {
  const probes = useApi<ObjectPage>('/objects?kind=probe&limit=200&sort=id');
  const groups = useApi<ObjectPage>('/objects?kind=group&limit=500&sort=id');
  const templates = useApi<{ items: DeviceTemplateSummary[] }>('/device-templates');

  const [draft, setDraft] = useState<DiscoveryDraft>(EMPTY_DRAFT);
  const [startedId, setStartedId] = useState<number | null>(null);
  const [startError, setStartError] = useState<ApiError | null>(null);

  if (
    probes.status === 'loading' ||
    groups.status === 'loading' ||
    templates.status === 'loading'
  ) {
    return <Loading what="discovery" />;
  }
  if (probes.status === 'error') return <ErrorPanel error={probes.error} retry={probes.retry} />;
  if (groups.status === 'error') return <ErrorPanel error={groups.error} retry={groups.retry} />;
  if (templates.status === 'error') {
    return <ErrorPanel error={templates.error} retry={templates.retry} />;
  }

  return (
    <div className="space-y-4">
      <PageTitle title="Discovery" />

      <StartPanel
        draft={draft}
        onChange={setDraft}
        probes={probes.data.items}
        groups={groups.data.items}
        templates={templates.data.items}
        error={startError}
        onStarted={(run) => {
          setStartError(null);
          setStartedId(run.id);
        }}
        onError={setStartError}
      />

      {/* Keyed by the run (`U-64` review): everything the card holds — the run as last read, its
          summary, a refused cancel, a failed poll — is about that run, and a second start would
          otherwise show run 7's refusal and summary under run 8's heading for good. */}
      {startedId !== null && <RunPanel key={startedId} runId={startedId} />}

      {draft.groupId !== null && <RecentRuns groupId={draft.groupId} watching={startedId} />}

      <RediscoveryPanel
        probes={probes.data.items}
        groups={groups.data.items}
        templates={templates.data.items}
      />
    </div>
  );
}

// ── starting ────────────────────────────────────────────────────────────────────────────────

function StartPanel({
  draft,
  onChange,
  probes,
  groups,
  templates,
  error,
  onStarted,
  onError,
}: {
  draft: DiscoveryDraft;
  onChange: (draft: DiscoveryDraft) => void;
  probes: ObjectPage['items'];
  groups: ObjectPage['items'];
  templates: DeviceTemplateSummary[];
  error: ApiError | null;
  onStarted: (run: DiscoveryRun) => void;
  /** Told `null` as an attempt starts, so a second refusal in the same words is said again. */
  onError: (error: ApiError | null) => void;
}): React.JSX.Element {
  const [preview, setPreview] = useState<DiscoveryPreview | null>(null);
  const [previewError, setPreviewError, sayAgain] = useRefusal<ApiError>();
  const [starting, setStarting] = useState(false);

  // Debounced, because the preview parses a range and an operator types one character at a time
  // — nine requests for `10.0.0.0/24` would each be answering a question nobody asked.
  const range = draft.range.trim();
  useEffect(() => {
    if (range === '') {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    // An answer about a range that is no longer in the box is not shown: the newer one is asked.
    let stale = false;
    const timer = setTimeout(() => {
      send<DiscoveryPreview>('POST', '/discovery/preview', { range })
        .then((next) => {
          if (stale) return;
          setPreview(next);
          setPreviewError(null);
        })
        .catch((failure: unknown) => {
          if (stale) return;
          setPreview(null);
          // The parser's own sentence — "that is 16,777,214 addresses and one run may sweep
          // 65,536; the usual cause is a /8 where a /24 was meant" — is the whole reason `D-01`
          // wrote it, and a generic "invalid range" here would throw it away.
          //
          // **Emptied now and said a moment later** (`U-57`). Each answer is about a different
          // range, so a `/7` refused after a `/8` in the same words is a new refusal; but the
          // region's text would not change, React would not touch it, and a live region that
          // does not change says nothing. Emptying it as the request goes out is not enough on
          // its own either: a local core answers in a few milliseconds, and a screen reader can
          // read the tree after both changes and find it as it was. So `useRefusal` empties it
          // and fills it `SAY_AGAIN_MS` later, as it does for a refusal the form decides itself.
          sayAgain(
            failure instanceof ApiError
              ? failure
              : new ApiError(0, 'UNKNOWN', 'the range is not valid'),
          );
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [range, setPreviewError, sayAgain]);

  const underProbe = useMemo(
    () => groupsFor(draft.probeId, probes, groups),
    [probes, groups, draft.probeId],
  );
  // Offered only where there is such a group: anybody who can see every probe never sees it.
  const unseen = useMemo(() => groupsUnderUnseenProbe(probes, groups).length > 0, [probes, groups]);

  const blocked = whyNotStartable(draft, preview !== null);
  const chosen = preview?.levels.find((one) => one.id === draft.level);

  const start = useCallback(() => {
    if (draft.probeId === null || draft.groupId === null) return;
    setStarting(true);
    onError(null);
    send<DiscoveryRun>('POST', '/discovery', {
      groupId: draft.groupId,
      ...probeIdFor(draft.probeId),
      range: draft.range.trim(),
      level: draft.level,
      templates: draft.templates,
      ...(draft.snmpCommunity === '' ? {} : { snmpCommunity: draft.snmpCommunity }),
    })
      .then(onStarted)
      .catch((failure: unknown) => {
        onError(
          failure instanceof ApiError
            ? failure
            : new ApiError(0, 'UNKNOWN', 'the run could not be started'),
        );
      })
      .finally(() => {
        setStarting(false);
      });
  }, [draft, onStarted, onError]);

  return (
    <Card title="Scan a range">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Probe" hint="The one that can reach this network. Discovery is a local job.">
          {(describedBy) => (
            <select
              className={SELECT}
              aria-describedby={describedBy}
              value={draft.probeId ?? ''}
              onChange={(event) => {
                const probeId = probeChoiceOf(event.target.value);
                // The group is cleared with the probe: a group under the old probe would be a
                // selection that still looks valid and that the core would refuse.
                onChange({ ...draft, probeId, groupId: null });
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

        <Field label="Group" hint="Where the devices it finds are created.">
          {(describedBy) => (
            <select
              className={SELECT}
              aria-describedby={describedBy}
              value={draft.groupId ?? ''}
              disabled={draft.probeId === null}
              onChange={(event) => {
                onChange({
                  ...draft,
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
      </div>

      <div className="mt-4">
        <Field
          label="Range"
          hint="10.0.0.0/24, 10.0.0.1-10.0.0.50, or a single address. IPv4 only."
        >
          {(describedBy) => (
            <input
              className={INPUT}
              value={draft.range}
              spellCheck={false}
              onChange={(event) => {
                onChange({ ...draft, range: event.target.value });
              }}
              aria-invalid={previewError !== null}
              // The refusal joins the hint rather than replacing it: what the box wants and what
              // it did not like are both worth hearing, and in that order.
              aria-describedby={
                previewError === null ? describedBy : `range-problem ${describedBy ?? ''}`.trim()
              }
            />
          )}
        </Field>
        {/* **Always there, empty until the range is refused** (`U-54`): the refusal comes a
            debounce and a round trip after the last keystroke, and a region added with its text
            already in it is not reliably announced (`U-41`). **Polite, not an alert** (`U-57`):
            it answers the range as it is typed and changes with it, so it should wait for the
            screen reader to finish rather than cut into the operator's own typing, as `U-48`
            kept the settings panel's problems. Said whole (`aria-atomic`), as an alert is, so a
            new id after the same sentence is not read as the id alone. Named by the box only
            while it says something (above); `empty:mt-0` gives back its margin while it does not
            (`U-45`). */}
        <p
          id="range-problem"
          aria-live="polite"
          aria-atomic="true"
          className="mt-2 text-sm text-down-fg empty:mt-0"
        >
          {previewError?.message}
          <CorrelationId id={previewError?.correlationId} />
        </p>
        {preview !== null && (
          <p className="mt-2 text-sm text-text-muted">
            {preview.total.toLocaleString()} addresses.
          </p>
        )}
      </div>

      {preview !== null && (
        <fieldset className="mt-4">
          <legend className="text-sm font-medium text-text">How hard to look</legend>
          <div className="mt-2 space-y-2">
            {orderedLevels(preview.levels).map((level) => (
              <label
                key={level.id}
                className="flex cursor-pointer gap-3 border border-border p-3 hover:bg-surface"
              >
                <input
                  type="radio"
                  name="level"
                  className="mt-1"
                  checked={draft.level === level.id}
                  onChange={() => {
                    onChange({ ...draft, level: level.id });
                  }}
                />
                <span className="min-w-0">
                  <span className="flex flex-wrap items-baseline gap-2">
                    <span className="text-sm font-medium text-text">{level.name}</span>
                    <span className="text-sm tabular-nums text-text-muted">
                      {estimateText(level.minSeconds, level.maxSeconds)}
                    </span>
                    {isLong(level) && (
                      <span className="bg-warning-bg px-1.5 py-0.5 text-xs text-warning-fg">
                        long enough to walk away from
                      </span>
                    )}
                  </span>
                  <span className="mt-1 block text-sm text-text-muted">{level.description}</span>
                </span>
              </label>
            ))}
          </div>
          <p className="mt-2 text-xs text-text-muted">
            A range, not a guess: the low end is every address answering, the high end is none of
            them answering. Every real network is somewhere between.
          </p>
        </fieldset>
      )}

      {draft.level !== 'ping' && (
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field
            label="SNMP community"
            hint="Read-only, tried against every host while identifying. Left empty, SNMP is skipped."
          >
            {(describedBy) => (
              <input
                className={INPUT}
                type="password"
                autoComplete="off"
                aria-describedby={describedBy}
                value={draft.snmpCommunity}
                onChange={(event) => {
                  onChange({ ...draft, snmpCommunity: event.target.value });
                }}
              />
            )}
          </Field>
          <TemplatePicker
            templates={templates}
            chosen={draft.templates}
            onChange={(next) => {
              onChange({ ...draft, templates: next });
            }}
          />
        </div>
      )}

      {/* A refused start, in a region always there and empty until one (`U-54`, as `U-48` did):
          focus is on *Start discovery* when the core refuses, and a region added with its text
          already in it is not reliably announced (`U-41`). `start` empties it as it begins. */}
      <p role="alert" className="mt-4 text-sm text-down-fg empty:mt-0">
        {error?.message}
        <CorrelationId id={error?.correlationId} />
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={blocked !== null || starting}
          onClick={start}
          className="border border-accent bg-accent px-3 py-1 text-sm font-medium text-accent-contrast disabled:opacity-50"
        >
          {starting ? 'Starting…' : 'Start discovery'}
        </button>
        {/* A disabled button with no explanation is a puzzle. This says which box is empty. */}
        {blocked !== null && <span className="text-sm text-text-muted">{blocked}</span>}
        {chosen !== undefined && blocked === null && (
          <span className="text-sm text-text-muted">
            about {estimateText(chosen.minSeconds, chosen.maxSeconds)}
          </span>
        )}
      </div>
    </Card>
  );
}

// ── watching ────────────────────────────────────────────────────────────────────────────────

function RunPanel({ runId }: { runId: number }): React.JSX.Element {
  const [run, setRun] = useState<DiscoveryRun | null>(null);
  const [summary, setSummary] = useState<DiscoverySummary | null>(null);
  // Two regions, two kinds of news (`U-64`). `problem` is a read of the run failing — the polls'
  // own business, emptied by the next read that succeeds. `refused` is the operator's cancel,
  // refused: emptied only by their next attempt, so a good poll two seconds later does not take
  // the refusal away before it is read.
  const [problem, setProblem] = useState<ApiError | null>(null);
  const [refused, setRefused] = useState<ApiError | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  // One timer chained from the last answer rather than an interval, so a slow reply cannot
  // stack requests behind it — the same rule the probe's own sweep follows for its ticks.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const tick = (): void => {
      request<DiscoveryRun>(`/discovery/${String(runId)}`)
        .then((next) => {
          if (stopped) return;
          setRun(next);
          setProblem(null);
          const wait = pollIntervalMs(next);
          if (wait === null) return;
          timer = setTimeout(tick, wait);
        })
        .catch((failure: unknown) => {
          if (stopped) return;
          const next =
            failure instanceof ApiError
              ? failure
              : new ApiError(0, 'UNKNOWN', 'the run could not be read');
          // A poll that fails again in the same words keeps the failure already shown, id and
          // all: each answer from the core has its own correlation id, and a region whose text
          // changed every five seconds would say the same failure every five seconds (`U-59`).
          setProblem((shown) => (shown !== null && sameWords(shown, next) ? shown : next));
          // Kept asking, because a core that was briefly unreachable is the common case and a
          // page that gave up would need a reload to notice it came back.
          timer = setTimeout(tick, 5_000);
        });
    };

    tick();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [runId]);

  // The summary is worth one request, once the run has stopped moving.
  useEffect(() => {
    if (run === null || isActive(run.status)) return;
    request<DiscoverySummary>(`/discovery/${String(runId)}/summary`)
      .then((next) => {
        if (live.current) setSummary(next);
      })
      .catch(() => {
        // A missing summary is not worth a banner over a finished run: everything it would say
        // is already on the run itself, one field at a time.
      });
  }, [run, runId]);

  const cancel = useCallback(() => {
    setCancelling(true);
    // Emptied as the attempt starts, so a refusal in the words already there is said (`U-54`).
    setRefused(null);
    send('POST', `/discovery/${String(runId)}/cancel`)
      .catch((failure: unknown) => {
        setRefused(
          failure instanceof ApiError
            ? failure
            : new ApiError(0, 'UNKNOWN', 'the run could not be cancelled'),
        );
      })
      .finally(() => {
        setCancelling(false);
      });
  }, [runId]);

  if (run === null) {
    return (
      <Card title="Run">
        {problem === null && <Loading what="the run" />}
        {/* The first read failing. **Always there, empty until it does** (`U-56`): it answers a
            read that went out as the card was drawn, and a region added with its text already in
            it is not reliably announced (`U-41`). **Polite, not an alert.** Nothing the operator
            asked for was refused — the run was started, and *Start discovery* said so — and the
            card keeps asking every five seconds and replaces this with the run once a read
            succeeds; what it says is the same kind of news as the *Loading the run…* status it
            takes the place of, and is said the same way. It takes no margin: one or the other
            is shown, never both. */}
        <p role="status" className="text-sm text-down-fg">
          {problem?.message}
          <CorrelationId id={problem?.correlationId} />
        </p>
      </Card>
    );
  }

  const percent = Math.round(progressOf(run) * 100);
  const elapsed =
    run.startedAt === null
      ? null
      : formatDuration(
          (run.finishedAt === null ? Date.now() : new Date(run.finishedAt).getTime()) -
            new Date(run.startedAt).getTime(),
        );

  return (
    <Card
      title={`Run ${String(run.id)} — ${run.range}`}
      actions={
        isActive(run.status) ? (
          <button
            type="button"
            onClick={cancel}
            disabled={cancelling}
            className="border border-border px-2 py-1 text-sm text-text hover:bg-surface disabled:opacity-50"
          >
            {cancelling ? 'Cancelling…' : 'Cancel'}
          </button>
        ) : (
          <Link
            to={`/objects/${String(run.groupId)}`}
            className="text-sm text-accent underline underline-offset-2"
          >
            Open the group
          </Link>
        )
      }
    >
      {summary !== null ? (
        <p className="text-sm text-text">{summary.headline}</p>
      ) : (
        <p className="text-sm text-text">
          {phaseOf(run)} — {run.cursor.toLocaleString()} of {run.total.toLocaleString()} addresses,{' '}
          {run.found.toLocaleString()} answered
        </p>
      )}

      <div
        className="mt-3 h-2 w-full overflow-hidden bg-border"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Discovery of ${run.range}`}
      >
        <div
          className="h-full bg-accent transition-[width]"
          style={{ width: `${String(percent)}%` }}
        />
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
        <Stat term="Answered" value={run.found.toLocaleString()} />
        <Stat term="Identified" value={run.identified.toLocaleString()} />
        <Stat term="Devices created" value={run.devicesCreated.toLocaleString()} />
        <Stat term="Sensors created" value={run.sensorsCreated.toLocaleString()} />
      </dl>

      {elapsed !== null && <p className="mt-2 text-xs text-text-muted">{elapsed} elapsed</p>}

      {summary !== null && summary.errors.length > 0 && (
        <div className="mt-3 border border-border p-3">
          <h3 className="text-sm font-medium text-text">
            {summary.errors.length} address{summary.errors.length === 1 ? '' : 'es'} had problems
          </h3>
          <ul className="mt-1 space-y-1 text-sm text-text-muted">
            {summary.errors.map((one) => (
              <li key={one.address}>
                <span className="tabular-nums">{one.address}</span> — {one.problem}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* A refused cancel. **Always there, empty until one** (`U-54`): a region added with its
          text already in it is not reliably announced (`U-41`). An alert, for `U-48`'s reason:
          focus is on *Cancel* when the core refuses, and the run the operator thinks they stopped
          is still going. **Its own region** (`U-64`): only the next cancel empties it, so the
          poll that succeeds two seconds later leaves it to be read. */}
      <p role="alert" className="mt-3 text-sm text-down-fg empty:mt-0">
        {refused?.message}
        <CorrelationId id={refused?.correlationId} />
      </p>
      {/* A read of the run failing, once it has been read (`U-64`). **Polite**, as the first
          read's failure is (`U-56`): nothing the operator asked for was refused, the card keeps
          asking by itself, and a read that succeeds empties it. Always there and empty until a
          read fails; a poll that fails again in the same words leaves it alone, so it is said
          once and not every five seconds (`U-59`). */}
      <p role="status" className="mt-3 text-sm text-down-fg empty:mt-0">
        {problem?.message}
        <CorrelationId id={problem?.correlationId} />
      </p>
    </Card>
  );
}

function RecentRuns({
  groupId,
  watching,
}: {
  groupId: number;
  watching: number | null;
}): React.JSX.Element {
  const runs = useApi<{ items: DiscoveryRun[] }>(`/objects/${String(groupId)}/discovery?limit=10`);

  if (runs.status === 'loading') return <Loading what="earlier runs" />;
  if (runs.status === 'error') return <ErrorPanel error={runs.error} retry={runs.retry} />;

  const others = runs.data.items.filter((run) => run.id !== watching);
  if (others.length === 0) {
    return (
      <Card title="Earlier runs">
        <Empty because="Nothing has scanned into this group yet.">No earlier runs.</Empty>
      </Card>
    );
  }

  return (
    <Card title="Earlier runs">
      <ul className="divide-y divide-border">
        {others.map((run) => (
          <li key={run.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 text-sm">
            <span className="font-medium text-text">{run.range}</span>
            <span className="text-text-muted">{phaseOf(run)}</span>
            <span className="text-text-muted">
              {run.found.toLocaleString()} answered, {run.devicesCreated.toLocaleString()} created
            </span>
            {run.scheduleId !== null && (
              <span className="bg-surface px-1.5 py-0.5 text-xs text-text-muted">scheduled</span>
            )}
            <span className="ml-auto text-xs text-text-muted">
              {new Date(run.createdAt).toLocaleString()}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ── bits ────────────────────────────────────────────────────────────────────────────────────

function Stat({ term, value }: { term: string; value: string }): React.JSX.Element {
  return (
    <div>
      <dt className="text-xs text-text-muted">{term}</dt>
      <dd className="tabular-nums text-text">{value}</dd>
    </div>
  );
}
