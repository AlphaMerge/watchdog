# ADR-002: How a map is exposed — public share links and custom HTML

- **Status**: Accepted
- **Date**: 2026-09-09
- **Deciders**: Roman
- **Supersedes**: —
- **Relates to**: `ADR-001` Decision 9 (auth), `A-11` (access decisions), Phase 12 (`V2-02`)

## Context

`CAPABILITIES.MD §6` describes maps as "publicly shareable by URL" and as able to hold "custom
HTML". Both are on the list because PRTG has them, and both are decisions about the security
posture of the product rather than features to be implemented on request. They are settled here,
before `G-02` fixes the widget model, because each one changes it.

Phase 9 spent considerable effort making every read answer to a principal: `onRequest`
authentication, per-route `PUBLIC | READS | SELF | ADMIN | onObject(...)` authorisation, and
`ObjectService.#redact` as the single place write-only parameters are stripped. A public map URL
is, by construction, a hole in that. Saying so plainly is the point of writing this down: the
question is not whether it is a weakening — it is — but whether it is a bounded one worth the
capability.

## Decision 1 — Public share links exist, and are bearer tokens with an expiry

**Decision.** A map may be shared by URL. The URL carries a per-map bearer token; the token is
revocable and carries an expiry. `GET /public/maps/:token` is the only unauthenticated route the
feature adds.

**What a shared map may serve, and nothing else.** The route resolves *that map's widgets* and
returns their current values. It does not accept an object id, does not walk the tree, does not
drill through to a sensor page, and does not reach the object API. A viewer holding the link sees
the dashboard somebody built and has no way to ask a question the dashboard does not already
answer.

**Why this shape.** The failure everyone has seen is the share link that turns out to be a
credential for the whole system, because it was implemented as "log in as a service account".
Scoping the token to one map's already-chosen widgets means the blast radius of a leaked link is
exactly what the person who made the link was looking at — which is a thing they can reason about.

**What it still leaks, said out loud.** Hostnames, sensor names, what is currently failing, and
the shape of whatever the map author put on the canvas. That is monitoring data about
infrastructure, and anyone with the link has it until the token is revoked or expires. An operator
turning this on is making that trade; the UI must say so at the point of sharing rather than in
documentation nobody reads.

**Consequences.**

- The widget resolver (`G-02`) must work with *no principal*, which means it cannot use the
  ambient authorisation the rest of the API relies on. The map's own stored widget list is the
  authorisation, and that is the only mode the public route has.
- Tokens are revocable per map, which means storage for them and a revocation path in the UI.
- An expiry is mandatory rather than optional. A share link with no expiry is a permanent
  unauthenticated route that nobody remembers creating.
- Rate limiting belongs on this route. It is the one place an unauthenticated caller can make the
  core do work.

**Rejected: no public sharing at all.** Defensible, and Phase 9 already supports a read-only
account for a wall display. Rejected because a wall display driven by a real account is a session
that has to be kept alive, on a machine in a corridor, and in practice becomes a shared password —
which is a worse outcome than a scoped, revocable, expiring token.

## Decision 2 — Custom HTML runs in a sandboxed iframe, never in the application document

**Decision.** A custom HTML widget renders inside `<iframe sandbox srcdoc="...">` with no
`allow-same-origin`, under a restrictive CSP. It cannot reach the session, the DOM around it, or
any API.

**Why not a sanitiser.** An allowlist sanitiser is safe exactly as long as it is complete and
stays complete, against an attacker surface that is the entire history of browser parsing quirks.
The iframe is safe by construction: even a widget that is entirely hostile markup can only affect
its own rectangle. The cost is that a custom widget cannot inherit the page's styles and cannot be
laid out as freely, which is a real cost and the right one to pay.

**Why this is sharper once Decision 1 exists.** Operator-supplied HTML on a publicly shared map is
operator-supplied content served to unauthenticated strangers from this system's origin. Without
the sandbox, a map author — who need not be an administrator — would be able to publish arbitrary
script under the monitoring system's domain. The two features are individually defensible and
together are a phishing kit, unless the sandbox is non-negotiable. It is.

**Consequences.**

- Custom HTML widgets cannot participate in the page's theming, and will look like what they are.
- The CSP for the application must be written to permit `srcdoc` iframes without weakening
  anything else.
- No script in a custom widget can read live data. A widget that wants live data uses one of the
  built-in widget types, which is the intended path anyway.

## Amendments, 2026-09-09 (`G-06`, on building it)

Two things this decision said turned out to be slightly wrong in the letter, and both are recorded
here rather than quietly diverged from.

**"`GET /public/maps/:token` is the only unauthenticated route" — there are two, and the second one
serves the map's background image.** `G-05` had not happened when this was written and a map could
not have a background. Serving it needs the same token, resolves the same map, and returns bytes
the map author put there; the alternative was a data URI inside the JSON, which would put two
megabytes of base64 into every poll of a wall display. **The rule that survives is the one that
matters**: the public surface is a *token-scoped namespace*, `/api/v1/public/`, and every route in
it takes a share token and reaches nothing the token does not already open. That prefix is what
the authentication hook exempts, so "what can a stranger reach?" is answered by reading one file.

**The path is `/api/v1/public/maps/:token`, and the page a person is given is `/shared/:token`.**
The API lives under the versioned prefix with everything else, because that is where the
authentication hook can exempt exactly one namespace; the human-facing URL has to be a route the
app shell serves, and the two cannot be the same string.

**Decision 2 said "no `allow-same-origin`"; what shipped is `sandbox=""` — no tokens at all**
(`G-07`). Stricter than the decision rather than looser, so nothing here is weakened: a custom
widget gets a unique opaque origin, no scripts, no forms and no navigation.

The reason for going further is worth recording, because it changes what an operator can do. A
`srcdoc` document is a local scheme and inherits the embedding page's content security policy,
which here is `default-src 'self'` with no `unsafe-inline` — so inline `<style>`, `style`
attributes and third-party images are inert inside the frame whatever the sandbox says. Granting
`allow-scripts` would therefore have been a promise the policy breaks. **A custom widget is markup
and text**, and the designer says so where somebody is typing rather than leaving them to discover
it. *(The sandbox is what the safety argument rests on and is well defined; the inheritance is read
from the specification and has not been checked in a browser here.)*

**One thing this decision did not anticipate, decided the same way it would have been:** a shared
map's *graph* widgets show their channels' current readings rather than a chart. Drawing history
would mean an unauthenticated range query per graph tile, which is precisely the work the fourth
consequence above asks to be bounded. A viewer who needs the history signs in.

## Decision 3 — Geographical maps are deferred, not designed here

`G-08` needs map tiles, and every way of getting them argues with `CLAUDE.md`'s third hard
constraint or with the product's standalone posture: bundling is gigabytes, a hosted provider means
an API key and an internet path from a NOC that may not have one, and a self-hosted tile server is
another service an operator installs and supervises.

**No decision is taken here** beyond the shape of the eventual one: whatever is chosen must degrade
to a plain background when no provider is configured, so that an air-gapped installation gets a map
without tiles rather than a map that does not load. Deciding it properly needs its own ADR and is
not on the path of any other Phase 12 ticket.
