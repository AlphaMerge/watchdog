import { useState } from 'react';
import { ApiError, send, useApi } from '../api/client';
import type { MapShare } from '../api/types';
import { ErrorPanel, Loading } from '../components/Panels';
import { shareLinkFor } from './shareUrl';

/**
 * Publishing a map to people with no account (`G-06`, `ADR-002` Decision 1).
 *
 * **The warning is at the point of sharing, not in documentation nobody reads.** That is a
 * requirement of the ADR rather than a nicety: an operator making a link is trading hostnames,
 * sensor names and what is currently failing for a URL somebody can open on a phone, and the
 * moment to say so is the moment they decide.
 *
 * **The URL is shown once.** Only the token's hash is stored, so there is nothing to show later —
 * a property worth stating plainly, because a person who loses the link will otherwise look for a
 * "show again" button and conclude the page is broken.
 */

const EXPIRIES: readonly { readonly days: number; readonly label: string }[] = [
  { days: 1, label: '1 day' },
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 365, label: 'a year' },
];

export function MapSharePanel({ mapId }: { readonly mapId: number }): React.JSX.Element {
  const shares = useApi<{ items: MapShare[] }>(`/maps/${String(mapId)}/shares`);
  const [label, setLabel] = useState('');
  const [days, setDays] = useState(7);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiError | null>(null);
  /** The one time this token exists anywhere the browser can show it. */
  const [minted, setMinted] = useState<string | null>(null);

  const create = (event: React.SyntheticEvent): void => {
    event.preventDefault();
    if (label.trim() === '' || busy) return;
    setBusy(true);
    setFailure(null);
    setMinted(null);
    const expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
    send<{ token: string }>('POST', `/maps/${String(mapId)}/shares`, {
      label: label.trim(),
      expiresAt,
    })
      .then((made) => {
        setMinted(shareLinkFor(made.token, window.location.origin));
        setLabel('');
        shares.reload();
      })
      .catch((error: unknown) => {
        setFailure(
          error instanceof ApiError
            ? error
            : new ApiError(0, 'UNREACHABLE', 'the core is not reachable'),
        );
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const revoke = (share: MapShare): void => {
    setFailure(null);
    send('DELETE', `/maps/${String(mapId)}/shares/${String(share.id)}`)
      .then(() => {
        // The link somebody is looking at may be the one just revoked; clearing it stops them
        // pasting a URL that has already stopped working.
        setMinted(null);
        shares.reload();
      })
      .catch((error: unknown) => {
        setFailure(
          error instanceof ApiError
            ? error
            : new ApiError(0, 'UNREACHABLE', 'the core is not reachable'),
        );
      });
  };

  const live = shares.status === 'ready' ? shares.data.items.filter(isLive) : [];

  return (
    <div className="space-y-3">
      <h3 className="ms-label">Public links</h3>

      <p className="text-xs text-text-muted">
        Anybody with one of these links can see this map without signing in: the widgets on it, the
        names of the devices and sensors they point at, and what is failing right now. They cannot
        open anything else. A link stops working when it expires or when you revoke it.
      </p>

      <form onSubmit={create} className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-text-muted">
          <span className="ms-label block">What it is for</span>
          <input
            value={label}
            onChange={(event) => {
              setLabel(event.target.value);
            }}
            maxLength={100}
            placeholder="NOC wall display"
            className="mt-1 w-56 max-w-full border border-control bg-surface px-2 py-1 text-sm text-text"
          />
        </label>
        <label className="text-xs text-text-muted">
          <span className="ms-label block">Expires in</span>
          <select
            value={days}
            onChange={(event) => {
              setDays(Number(event.target.value));
            }}
            className="mt-1 border border-control bg-surface px-2 py-1 text-sm text-text"
          >
            {EXPIRIES.map((entry) => (
              <option key={entry.days} value={entry.days}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          disabled={label.trim() === '' || busy}
          className="border border-accent bg-accent px-3 py-1 text-sm font-medium text-accent-contrast disabled:opacity-50"
        >
          {busy ? 'Making…' : 'Make a link'}
        </button>
      </form>

      {failure !== null && <ErrorPanel error={failure} />}

      {minted !== null && (
        <div className="border border-accent bg-surface p-3">
          <p className="ms-label">Copy this now</p>
          <p className="mt-1 break-all font-mono text-xs text-text">{minted}</p>
          <p className="mt-2 text-xs text-text-muted">
            This is the only time it can be shown. The system stores a hash of it, not the link
            itself — which is what stops a copy of the database being a set of working links.
          </p>
        </div>
      )}

      {shares.status === 'loading' && <Loading what="links" />}
      {shares.status === 'error' && <ErrorPanel error={shares.error} retry={shares.reload} />}
      {shares.status === 'ready' && live.length === 0 && (
        <p className="text-xs text-text-muted">No public links.</p>
      )}
      {live.length > 0 && (
        <ul className="space-y-1">
          {live.map((share) => (
            <li key={share.id} className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-text">{share.label}</span>
              <span className="font-mono text-text-muted">{share.prefix}…</span>
              <span className="text-text-muted">
                expires {new Date(share.expiresAt).toLocaleDateString()}
              </span>
              <span className="text-text-muted">
                {share.lastUsedAt === null
                  ? 'never used'
                  : `last used ${new Date(share.lastUsedAt).toLocaleString()}`}
              </span>
              <button
                type="button"
                onClick={() => {
                  revoke(share);
                }}
                className="ms-label border border-control px-1.5 py-0.5 text-text-muted hover:text-text"
              >
                <span className="sr-only">Revoke </span>
                {share.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * A link that is still worth listing.
 *
 * Revoked and expired ones are dropped here rather than in the query: the core keeps the rows
 * because the record of what existed outlives the decision to stop it, and a list of dead links
 * is not what somebody deciding whether to revoke one needs to read.
 */
function isLive(share: MapShare): boolean {
  return share.revokedAt === null && new Date(share.expiresAt).getTime() > Date.now();
}
