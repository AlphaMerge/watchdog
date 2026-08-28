import type { AuditActor } from './types.js';

/**
 * Naming an audit actor, and addressing one (`A-08`).
 *
 * Two questions, one union. **What to show** is the identifying fact for that kind — a login, a
 * token id, a component, an address — never the bare kind, which is what a UI shows when it reads
 * a field the API does not send. **What to filter by** is `actor_ref`, which is the same value:
 * the audit log stores `(actor_kind, actor_ref)` and indexes it that way, so "everything this
 * person did" is a keyset walk rather than a scan.
 *
 * Kept beside the types rather than in a view, because the object detail panel and the logs feed
 * both ask, and two renderings of "who" that disagree is how an audit log stops being evidence.
 */

export function actorLabel(actor: AuditActor): string {
  switch (actor.kind) {
    case 'user':
      return actor.login;
    // No login to show: a token is a credential, not a person, and the id is what the token list
    // is keyed by, so it is the thing an operator can look up.
    case 'token':
      return `token #${String(actor.tokenId)}`;
    case 'system':
      return actor.component;
    case 'anonymous':
      return actor.remoteAddress;
  }
}

/**
 * The `actorRef` to filter on. Always paired with the kind, because a ref is only unique within
 * one — user 4 and token 4 are different actors.
 */
export function actorRef(actor: AuditActor): string {
  switch (actor.kind) {
    case 'user':
      return String(actor.userId);
    case 'token':
      return String(actor.tokenId);
    case 'system':
      return actor.component;
    case 'anonymous':
      return actor.remoteAddress;
  }
}
