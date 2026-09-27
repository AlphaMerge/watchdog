import { useState } from 'react';
import { ApiError, send } from '../api/client';
import type { ReportFrequency, ReportKind, ReportSummary } from '../api/types';
import { Card, ErrorPanel } from '../components/Panels';
import {
  REPORT_KINDS,
  badRecipients,
  clockOf,
  minuteOf,
  scheduleFields,
  scheduleFrom,
  splitRecipients,
} from '../routes/reports-model';

/**
 * Editing a report (`E-11`).
 *
 * **`If-Match` on every save**, because a report is a thing two people open at once and the core
 * refuses a `PATCH` without it rather than letting the second save discard the first. The version
 * comes from the report that was loaded; a conflict answers 409 and the error panel says so, which
 * is the honest outcome — silently reloading and re-applying would be this form deciding whose
 * edit wins.
 *
 * **Only the fields a frequency uses are offered.** The core refuses a weekday on a monthly report
 * outright, so a form that showed the control would produce a 400 nobody can explain;
 * `scheduleFields` is the mirror of `validateSchedule` and is tested against the same rules.
 */
export function ReportSettings({
  report,
  onSaved,
}: {
  report: ReportSummary;
  onSaved: () => void;
}): React.JSX.Element {
  const [name, setName] = useState(report.name);
  const [description, setDescription] = useState(report.description);
  const [kind, setKind] = useState<ReportKind>(report.kind);
  const [subjects, setSubjects] = useState(report.subjects.objectIds.join(', '));
  const [runAs, setRunAs] = useState(report.runAs.login);

  const [spanKind, setSpanKind] = useState(report.span.kind);
  const [offset, setOffset] = useState(String(report.span.offset ?? 1));
  const [spanZone, setSpanZone] = useState(report.span.timezone ?? '');

  const [frequency, setFrequency] = useState<ReportFrequency>(report.schedule.kind);
  const [clock, setClock] = useState(clockOf(report.schedule.minute ?? 0));
  const [weekday, setWeekday] = useState(String(report.schedule.weekday ?? 0));
  const [dayOfMonth, setDayOfMonth] = useState(String(report.schedule.dayOfMonth ?? 1));
  const [month, setMonth] = useState(String(report.schedule.month ?? 1));
  const [scheduleZone, setScheduleZone] = useState(report.schedule.timezone ?? '');

  const [formats, setFormats] = useState(report.outputs.formats);
  const [delivery, setDelivery] = useState(report.outputs.delivery);
  const [recipients, setRecipients] = useState(report.outputs.recipients.join('\n'));
  const [zip, setZip] = useState(report.outputs.zip);

  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState(false);

  const fields = scheduleFields(frequency);
  const wrongAddresses = badRecipients(recipients);
  const sendsEmail = delivery !== 'store';

  const save = (event: React.SyntheticEvent): void => {
    event.preventDefault();
    if (saving || wrongAddresses.length > 0) return;
    setSaving(true);
    setFailure(null);
    setSaved(false);

    const objectIds = subjects
      .split(/[\s,]+/u)
      .map((entry) => Number(entry))
      .filter((entry) => Number.isSafeInteger(entry) && entry > 0);

    send<ReportSummary>(
      'PATCH',
      `/reports/${String(report.id)}`,
      {
        name: name.trim(),
        description,
        kind,
        subjects: { objectIds },
        span: {
          kind: spanKind,
          // A custom span names its own start and end, which this form does not offer yet — the
          // offset belongs to the named periods and the core refuses it on the other.
          ...(spanKind === 'custom' ? {} : { offset: Number(offset) }),
          ...(spanZone.trim() === '' ? {} : { timezone: spanZone.trim() }),
        },
        schedule: scheduleFrom({
          kind: frequency,
          minute: minuteOf(clock),
          weekday: Number(weekday),
          dayOfMonth: Number(dayOfMonth),
          month: Number(month),
          timezone: scheduleZone,
        }),
        outputs: {
          formats,
          delivery,
          // Empty unless it sends: the core refuses a recipient list on a stored-only report,
          // because a list that looks saved and sends nothing is worse than a refusal.
          recipients: sendsEmail ? splitRecipients(recipients) : [],
          zip,
        },
        runAs: runAs.trim(),
      },
      { 'If-Match': String(report.version) },
    )
      .then(() => {
        setSaved(true);
        onSaved();
      })
      .catch((error: unknown) => {
        setFailure(
          error instanceof ApiError
            ? error
            : new ApiError(0, 'UNREACHABLE', 'the core is not reachable'),
        );
      })
      .finally(() => {
        setSaving(false);
      });
  };

  const field = 'mt-1 border border-control bg-surface px-2 py-1 text-sm text-text';

  return (
    <Card title="Settings">
      <form onSubmit={save} className="space-y-5">
        <div className="flex flex-wrap gap-3">
          <label className="text-xs text-text-muted">
            <span className="ms-label block">Name</span>
            <input
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
              maxLength={100}
              className={`${field} w-64 max-w-full`}
            />
          </label>
          <label className="grow text-xs text-text-muted">
            <span className="ms-label block">Description</span>
            <input
              value={description}
              onChange={(event) => {
                setDescription(event.target.value);
              }}
              maxLength={1000}
              className={`${field} w-full`}
            />
          </label>
        </div>

        <div className="flex flex-wrap gap-3">
          <label className="text-xs text-text-muted">
            <span className="ms-label block">Template</span>
            <select
              value={kind}
              onChange={(event) => {
                setKind(event.target.value as ReportKind);
              }}
              className={field}
            >
              {REPORT_KINDS.map((one) => (
                <option key={one.id} value={one.id}>
                  {one.label}
                </option>
              ))}
            </select>
          </label>
          <label className="grow text-xs text-text-muted">
            <span className="ms-label block">Object ids it covers</span>
            <input
              value={subjects}
              onChange={(event) => {
                setSubjects(event.target.value);
              }}
              placeholder="41, 42, 43"
              className={`${field} w-full`}
            />
          </label>
          <label className="text-xs text-text-muted">
            <span className="ms-label block">Renders as</span>
            <input
              value={runAs}
              onChange={(event) => {
                setRunAs(event.target.value);
              }}
              maxLength={64}
              className={`${field} w-40`}
            />
          </label>
        </div>
        {/*
          Said where it is set. Changing this needs full access rather than write, because it
          decides whose data the output contains — the same class of act as granting access
          (`E-03`) — and naming anybody but yourself needs an administrator (`A-13`).
        */}
        <p className="-mt-3 text-xs text-text-muted">
          A report contains what that account can see. Changing it needs full access, only an
          administrator may name somebody other than themselves, and granting somebody this report
          grants them everything that account can see.
        </p>

        <fieldset className="space-y-2">
          <legend className="ms-label text-text-muted">Period</legend>
          <div className="flex flex-wrap gap-3">
            <label className="text-xs text-text-muted">
              <span className="ms-label block">Covers</span>
              <select
                value={spanKind}
                onChange={(event) => {
                  setSpanKind(event.target.value as ReportSummary['span']['kind']);
                }}
                className={field}
              >
                {['day', 'week', 'month', 'quarter', 'year'].map((one) => (
                  <option key={one} value={one}>
                    {one}
                  </option>
                ))}
              </select>
            </label>
            {spanKind !== 'custom' && (
              <label className="text-xs text-text-muted">
                <span className="ms-label block">Periods back</span>
                <input
                  type="number"
                  min={0}
                  max={1000}
                  value={offset}
                  onChange={(event) => {
                    setOffset(event.target.value);
                  }}
                  className={`${field} w-24`}
                />
              </label>
            )}
            <label className="text-xs text-text-muted">
              <span className="ms-label block">Time zone</span>
              <input
                value={spanZone}
                onChange={(event) => {
                  setSpanZone(event.target.value);
                }}
                placeholder="the core’s own"
                className={`${field} w-52`}
              />
            </label>
          </div>
          <p className="text-xs text-text-muted">
            1 is the last complete period, which is what a scheduled report wants — a monthly report
            firing on the 1st and covering “this month” would cover two hours. 0 is the one in
            progress and ends now.
          </p>
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="ms-label text-text-muted">Schedule</legend>
          <div className="flex flex-wrap gap-3">
            <label className="text-xs text-text-muted">
              <span className="ms-label block">Runs</span>
              <select
                value={frequency}
                onChange={(event) => {
                  setFrequency(event.target.value as ReportFrequency);
                }}
                className={field}
              >
                {['manual', 'hourly', 'daily', 'weekly', 'monthly', 'quarterly', 'annual'].map(
                  (one) => (
                    <option key={one} value={one}>
                      {one}
                    </option>
                  ),
                )}
              </select>
            </label>
            {fields.minute && (
              <label className="text-xs text-text-muted">
                <span className="ms-label block">{frequency === 'hourly' ? 'At :mm' : 'At'}</span>
                <input
                  type="time"
                  value={clock}
                  onChange={(event) => {
                    setClock(event.target.value);
                  }}
                  className={`${field} w-32`}
                />
              </label>
            )}
            {fields.weekday && (
              <label className="text-xs text-text-muted">
                <span className="ms-label block">Weekday</span>
                <select
                  value={weekday}
                  onChange={(event) => {
                    setWeekday(event.target.value);
                  }}
                  className={field}
                >
                  {[
                    'Monday',
                    'Tuesday',
                    'Wednesday',
                    'Thursday',
                    'Friday',
                    'Saturday',
                    'Sunday',
                  ].map((label, index) => (
                    <option key={label} value={String(index)}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {fields.dayOfMonth && (
              <label className="text-xs text-text-muted">
                <span className="ms-label block">Day of month</span>
                <input
                  type="number"
                  min={1}
                  max={31}
                  value={dayOfMonth}
                  onChange={(event) => {
                    setDayOfMonth(event.target.value);
                  }}
                  className={`${field} w-24`}
                />
              </label>
            )}
            {fields.month && (
              <label className="text-xs text-text-muted">
                <span className="ms-label block">Month</span>
                <input
                  type="number"
                  min={1}
                  max={12}
                  value={month}
                  onChange={(event) => {
                    setMonth(event.target.value);
                  }}
                  className={`${field} w-24`}
                />
              </label>
            )}
            {frequency !== 'manual' && (
              <label className="text-xs text-text-muted">
                <span className="ms-label block">Time zone</span>
                <input
                  value={scheduleZone}
                  onChange={(event) => {
                    setScheduleZone(event.target.value);
                  }}
                  placeholder="the core’s own"
                  className={`${field} w-52`}
                />
              </label>
            )}
          </div>
          {fields.dayOfMonth && (
            <p className="text-xs text-text-muted">
              A day a month does not have is clamped to its last — the 31st runs on the 28th of
              February rather than not at all.
            </p>
          )}
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="ms-label text-text-muted">Output and delivery</legend>
          <div className="flex flex-wrap items-end gap-4">
            <div className="text-xs text-text-muted">
              <span className="ms-label block">Formats</span>
              <div className="mt-1 flex gap-3">
                {(['html', 'csv', 'xml', 'pdf'] as const).map((one) => (
                  <label key={one} className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={formats.includes(one)}
                      onChange={(event) => {
                        setFormats(
                          event.target.checked
                            ? [...formats, one]
                            : formats.filter((format) => format !== one),
                        );
                      }}
                    />
                    {one.toUpperCase()}
                  </label>
                ))}
              </div>
            </div>
            <label className="text-xs text-text-muted">
              <span className="ms-label block">Delivery</span>
              <select
                value={delivery}
                onChange={(event) => {
                  setDelivery(event.target.value as ReportSummary['outputs']['delivery']);
                }}
                className={field}
              >
                <option value="store">store</option>
                <option value="store-and-email">store and email</option>
                <option value="email">email only</option>
              </select>
            </label>
            <label className="flex items-center gap-1 text-xs text-text-muted">
              <input
                type="checkbox"
                checked={zip}
                onChange={(event) => {
                  setZip(event.target.checked);
                }}
              />
              One ZIP instead of separate files
            </label>
          </div>
          {sendsEmail && (
            <label className="block text-xs text-text-muted">
              <span className="ms-label block">Recipients, one per line</span>
              <textarea
                value={recipients}
                onChange={(event) => {
                  setRecipients(event.target.value);
                }}
                rows={3}
                className={`${field} w-full max-w-lg font-mono`}
              />
            </label>
          )}
          {/*
            Named individually while the operator is still looking at the list. The core checks
            again and its answer is the one that counts; this exists so twelve addresses with one
            typo do not come back as a single error about the whole field.
          */}
          {wrongAddresses.length > 0 && (
            <p className="text-xs text-warning-fg">
              Not addresses this system will send to: {wrongAddresses.join(', ')}
            </p>
          )}
          {delivery === 'email' && (
            <p className="text-xs text-text-muted">
              Email only still stores the report until it has gone — a retry needs the bytes, and
              re-rendering later is a different document. It is deleted once it is delivered.
            </p>
          )}
        </fieldset>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={saving || wrongAddresses.length > 0}
            className="border border-accent bg-accent px-3 py-1 text-sm font-medium text-accent-contrast disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          {saved && <span className="text-xs text-text-muted">Saved.</span>}
        </div>

        {failure !== null && <ErrorPanel error={failure} />}
      </form>
    </Card>
  );
}
