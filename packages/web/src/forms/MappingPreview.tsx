import { useEffect, useId, useRef, useState } from 'react';
import { ApiError, send } from '../api/client';

/**
 * Proving a set of paths against a response, before a sensor has to run to find out (`U-13`).
 *
 * **Writing JSONPath blind against an API you cannot see is the part people give up on.** A path
 * that selects nothing and a path that selects three strings look identical from the form — both
 * produce a channel with no readings — and the loop for telling them apart is otherwise: save,
 * wait for a scan, read a message. This shortens that to a paste.
 *
 * **The core runs the sensor type's own code**, through the same functions a real check runs
 * (`POST /sensor-types/:id/preview`). Evaluating paths here in the browser would have been a
 * second implementation of the path language, and a preview that agreed with the sensor only
 * most of the time is worse than none: it certifies a path that does not work.
 *
 * **Which types offer this is read from `hasPreview`**, never matched on the id. Adding a sensor
 * type is a one-file job and asking `if (type === 'rest.custom')` here would quietly end that.
 */

interface PreviewSelection {
  text: string;
  numeric: boolean;
}

interface PreviewRow {
  key: string;
  path: string;
  error?: string;
  selected: PreviewSelection[];
  selectedCount: number;
  value: number | null;
}

interface PreviewExpectation {
  path: string;
  error?: string;
  actual: string;
  ok: boolean;
}

export interface PreviewResult {
  format: string;
  error?: string;
  rows: PreviewRow[];
  expectations: PreviewExpectation[];
  problems: string[];
}

/** Long enough that a keystroke is not a request, short enough that a pause feels answered. */
const DEBOUNCE_MS = 400;

/** What the route accepts. Refusing here saves a round trip and says something more useful. */
const MAX_DOCUMENT = 256 * 1024;

export function MappingPreview({
  typeId,
  params,
}: {
  typeId: string;
  /** The form's current values, sent as they are — the core does not require them to be valid. */
  params: Record<string, unknown>;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [document, setDocument] = useState('');
  const [contentType, setContentType] = useState('');
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const documentId = useId();
  const contentTypeId = useId();

  // Serialised rather than passed as an object: `params` is a fresh identity on every keystroke
  // in any field, and an effect keyed on it would fire for a change to a timeout.
  const paramsKey = JSON.stringify(params);

  // The request in flight, so an answer to a superseded one cannot overwrite a newer result —
  // a slow reply landing after a fast one is how a preview ends up describing a path nobody has
  // any more.
  const latest = useRef(0);

  useEffect(() => {
    if (!open || document.trim() === '') {
      setResult(null);
      setFailed(null);
      return undefined;
    }
    if (document.length > MAX_DOCUMENT) {
      setResult(null);
      setFailed(
        `That is ${Math.round(document.length / 1024).toLocaleString()} kB. A preview reads ` +
          `${String(MAX_DOCUMENT / 1024)} kB — paste the part with the values in it.`,
      );
      return undefined;
    }

    const timer = setTimeout(() => {
      const mine = latest.current + 1;
      latest.current = mine;
      setRunning(true);
      send<PreviewResult>('POST', `/sensor-types/${encodeURIComponent(typeId)}/preview`, {
        document,
        contentType,
        params: JSON.parse(paramsKey) as Record<string, unknown>,
      })
        .then((answer) => {
          if (latest.current !== mine) return;
          setResult(answer);
          setFailed(null);
        })
        .catch((error: unknown) => {
          if (latest.current !== mine) return;
          setResult(null);
          setFailed(error instanceof ApiError ? error.message : 'the preview could not be run');
        })
        .finally(() => {
          if (latest.current === mine) setRunning(false);
        });
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [open, document, contentType, paramsKey, typeId]);

  return (
    <section className="border border-border bg-surface-muted">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen((was) => !was);
        }}
        className="flex w-full items-center justify-between px-3 py-2 text-left text-sm font-medium"
      >
        <span>Test these paths against a response</span>
        <span aria-hidden="true" className="text-text-muted">
          {open ? '−' : '+'}
        </span>
      </button>

      {open && (
        <div className="space-y-3 border-t border-border px-3 py-3">
          <p className="text-xs text-text-muted">
            Paste what the API returns and each path below is run against it — by this sensor
            type&rsquo;s own code, so a path that reads correctly here reads correctly on the
            device. Nothing is fetched, nothing is saved, and no reading enters history.
          </p>

          <div>
            <label htmlFor={documentId} className="block text-sm font-medium">
              The response
            </label>
            <textarea
              id={documentId}
              value={document}
              spellCheck={false}
              rows={8}
              onChange={(event) => {
                setDocument(event.target.value);
              }}
              placeholder={'{\n  "queue": { "depth": 12 }\n}'}
              className="mt-1 w-full border border-control bg-surface p-2 font-mono text-xs"
            />
          </div>

          <div>
            <label htmlFor={contentTypeId} className="block text-sm font-medium">
              Content-Type <span className="font-normal text-text-muted">(optional)</span>
            </label>
            <input
              id={contentTypeId}
              value={contentType}
              spellCheck={false}
              onChange={(event) => {
                setContentType(event.target.value);
              }}
              placeholder="application/json"
              className="mt-1 w-full border border-control bg-surface px-2 py-1 font-mono text-xs"
            />
            <p className="mt-1 text-xs text-text-muted">
              Only matters where the format is set to <code className="font-mono">auto</code> and
              the document is ambiguous. Leaving it empty guesses from the document, which is what
              the sensor does when a server sends no usable type.
            </p>
          </div>

          <div aria-live="polite" className="space-y-3">
            {running && <p className="text-xs text-text-muted">Running…</p>}
            {failed !== null && <p className="text-xs text-down-fg">{failed}</p>}
            {result !== null && <Result result={result} />}
          </div>
        </div>
      )}
    </section>
  );
}

function Result({ result }: { result: PreviewResult }): React.JSX.Element {
  if (result.error !== undefined) {
    return (
      <p className="text-xs text-down-fg">
        Read as {result.format}, and {result.error}
      </p>
    );
  }

  return (
    <>
      <p className="text-xs text-text-muted">
        Read as <span className="font-medium text-text">{result.format}</span>.
      </p>

      {result.rows.length === 0 ? (
        <p className="text-xs text-text-muted">
          No paths to try yet — add a channel above and it appears here.
        </p>
      ) : (
        <table className="w-full text-left text-xs">
          <caption className="sr-only">What each path selects from the pasted response</caption>
          <thead className="text-text-muted">
            <tr>
              <th scope="col" className="py-1 pr-2 font-medium">
                Channel
              </th>
              <th scope="col" className="py-1 pr-2 font-medium">
                Selects
              </th>
              <th scope="col" className="py-1 font-medium">
                Reading
              </th>
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row, at) => (
              <Row key={`${row.key}-${String(at)}`} row={row} />
            ))}
          </tbody>
        </table>
      )}

      {result.expectations.length > 0 && (
        <ul className="space-y-1 text-xs">
          {result.expectations.map((one, at) => (
            <li key={`${one.path}-${String(at)}`} className="flex gap-2">
              <span className={one.ok ? 'text-up-fg' : 'text-down-fg'}>{one.ok ? '✓' : '✗'}</span>
              <code className="font-mono">{one.path}</code>
              <span className="text-text-muted">
                {one.error ?? (one.actual === '' ? 'found nothing' : `is “${one.actual}”`)}
              </span>
            </li>
          ))}
        </ul>
      )}

      {result.problems.length > 0 && (
        <div className="border border-down-border bg-down-bg p-2">
          <p className="text-xs font-medium text-down-fg">As it stands, this check would fail:</p>
          <ul className="mt-1 list-inside list-disc text-xs text-down-fg">
            {result.problems.map((problem, at) => (
              <li key={`${problem}-${String(at)}`}>{problem}</li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

/**
 * One channel's row.
 *
 * The three columns answer the three questions in order: what did the path find, could a reading
 * be made of it, and what is the number. A path selecting five values above an empty reading is
 * the commonest confusion here, and `numeric` on each value is what explains it.
 */
function Row({ row }: { row: PreviewRow }): React.JSX.Element {
  return (
    <tr className="border-t border-border align-top">
      <th scope="row" className="py-1 pr-2 text-left font-normal">
        <span className="font-medium">{row.key === '' ? '(unnamed)' : row.key}</span>
        <br />
        <code className="font-mono text-text-muted">{row.path}</code>
      </th>
      <td className="py-1 pr-2">
        {row.error !== undefined ? (
          <span className="text-down-fg">{row.error}</span>
        ) : row.selectedCount === 0 ? (
          <span className="text-text-muted">nothing</span>
        ) : (
          <>
            <span className="flex flex-wrap gap-1">
              {row.selected.map((one, at) => (
                <code
                  key={`${one.text}-${String(at)}`}
                  className={`border px-1 font-mono ${
                    one.numeric
                      ? 'border-border bg-surface'
                      : 'border-warning-border bg-warning-bg text-warning-fg'
                  }`}
                >
                  {one.text}
                  {/*
                    The shading says which values an aggregate can use, and shading alone would
                    say it to nobody using a screen reader and nobody printing this in grey
                    (WCAG 1.4.1). A `title` does not fix that: it is unreachable from a keyboard
                    and read inconsistently. This is the text, hidden from sight only.
                  */}
                  {!one.numeric && <span className="sr-only"> — not a number</span>}
                </code>
              ))}
            </span>
            {row.selectedCount > row.selected.length && (
              <span className="text-text-muted">
                {' '}
                and {(row.selectedCount - row.selected.length).toLocaleString()} more, {}
                {row.selectedCount.toLocaleString()} in all
              </span>
            )}
          </>
        )}
      </td>
      <td className="py-1 font-mono">
        {row.value === null ? (
          // Never a zero. A path that found nothing is a gap in the channel, and saying "0" here
          // would teach exactly the mistake the storage layer refuses to make.
          <span className="font-sans text-text-muted">no reading</span>
        ) : (
          row.value.toLocaleString(undefined, { maximumFractionDigits: 6 })
        )}
      </td>
    </tr>
  );
}
