import { render, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { actorLabel, actorRef } from '../src/api/actors';
import { ActorLink, auditQueryFor } from '../src/routes/LogsView';
import type { AuditActor } from '../src/api/types';

/**
 * Who did it, and how to ask for everything else they did (`A-08`).
 *
 * The bug these were written against was silent: the web types said the actor was
 * `{ kind, label? }`, the API sends a discriminated union with no `label` in it, and
 * `actor.label ?? actor.kind` therefore rendered "user" for every entry ever written. The login
 * was in the response the whole time. Nothing failed — an audit log that names nobody looks
 * exactly like one that has nobody to name.
 */

const ACTORS: { actor: AuditActor; label: string; ref: string }[] = [
  { actor: { kind: 'user', userId: 4, login: 'ada' }, label: 'ada', ref: '4' },
  { actor: { kind: 'token', tokenId: 7 }, label: 'token #7', ref: '7' },
  {
    actor: { kind: 'system', component: 'housekeeping' },
    label: 'housekeeping',
    ref: 'housekeeping',
  },
  { actor: { kind: 'anonymous', remoteAddress: '10.0.0.9' }, label: '10.0.0.9', ref: '10.0.0.9' },
];

describe('naming an audit actor', () => {
  for (const { actor, label, ref } of ACTORS) {
    it(`shows a ${actor.kind} by what identifies it, not by its kind`, () => {
      expect(actorLabel(actor)).toBe(label);
      expect(actorLabel(actor)).not.toBe(actor.kind);
      expect(actorRef(actor)).toBe(ref);
    });
  }

  it('uses the ref the audit log is indexed by, so the filter is a keyset walk', () => {
    // `audit_log_actor_idx` is (actor_kind, actor_ref, id DESC). A label that was not the stored
    // ref — "ada" rather than "4" — would filter to nothing at all, and an empty list reads as
    // "they did nothing" rather than "you asked the wrong question".
    expect(actorRef({ kind: 'user', userId: 4, login: 'ada' })).toBe('4');
  });
});

describe('the actor link', () => {
  // Scoped to this render's own container rather than the whole screen: several of these tests
  // render in a loop, and a screen-wide query finds every earlier one too.
  const linkFor = (actor: AuditActor): HTMLElement => {
    const { container } = render(
      <MemoryRouter>
        <ActorLink actor={actor} />
      </MemoryRouter>,
    );
    return within(container).getByRole('link');
  };

  it('names the person rather than the word "user"', () => {
    const link = linkFor({ kind: 'user', userId: 4, login: 'ada' });
    expect(link.textContent).toBe('ada');
  });

  for (const { actor, ref } of ACTORS) {
    it(`carries both kind and ref for a ${actor.kind}, because a ref is unique only within a kind`, () => {
      // user 4 and token 4 are different actors; filtering on the id alone would mix them.
      const link = linkFor(actor);
      const search = new URLSearchParams(link.getAttribute('href')?.split('?')[1] ?? '');
      expect(search.get('actorKind')).toBe(actor.kind);
      expect(search.get('actorRef')).toBe(ref);
      expect(search.get('tab')).toBe('objects');
    });
  }

  it('links every kind, not only the human ones', () => {
    // `actor_ref` on a system entry names one component, so "everything housekeeping did" is as
    // answerable as "everything Ada did" — and one address's unauthenticated requests is the
    // query an incident starts from.
    for (const { actor } of ACTORS) {
      const link = linkFor(actor);
      expect(link.getAttribute('href')).toMatch(/^\/logs\?/);
    }
  });
});

describe('the audit query the filters build', () => {
  const query = (search: string): URLSearchParams => auditQueryFor(new URLSearchParams(search));

  it('sends both actor parameters together', () => {
    const built = query('actorKind=user&actorRef=4');
    expect(built.get('actorKind')).toBe('user');
    expect(built.get('actorRef')).toBe('4');
  });

  it('sends neither when only the ref is present', () => {
    // A ref without its kind matches user 4 *and* token 4, so the log would attribute one
    // actor's changes to another — which is the one thing an audit log may not do. Half a
    // filter is dropped rather than half applied.
    const built = query('actorRef=4');
    expect(built.get('actorRef')).toBeNull();
    expect(built.get('actorKind')).toBeNull();
  });

  it('sends neither when only the kind is present', () => {
    const built = query('actorKind=user');
    expect(built.get('actorKind')).toBeNull();
  });

  it('drops an empty ref, which is what a cleared filter sends', () => {
    const built = query('actorKind=user&actorRef=');
    expect(built.get('actorRef')).toBeNull();
    expect(built.get('actorKind')).toBeNull();
  });

  it('keeps the other filters alongside it', () => {
    const built = query('actorKind=user&actorRef=4&objectId=17&category=object&category=setting');
    expect(built.get('objectId')).toBe('17');
    expect(built.getAll('category')).toEqual(['object', 'setting']);
    expect(built.get('limit')).not.toBeNull();
  });

  it('never sends the tab the URL uses to choose a view', () => {
    // `tab` belongs to the router, not to the API, and `additionalProperties: false` on the
    // querystring schema means the request would be refused rather than ignored.
    expect(query('tab=objects&objectId=17').get('tab')).toBeNull();
  });
});
