# MonitoringSystem API reference

**Generated from the OpenAPI document by `scripts/docs/api-reference.mjs`. Do not edit.** Every route is declared with a JSON Schema that Fastify validates against, so this is a rendering of what runs rather than a description of it, and `packages/core/test/build-hygiene.test.ts` fails when the two disagree.

The live document is at `GET /api/v1/openapi.json` on any running installation, and is the one to feed to a client generator. This page is for reading.

167 routes.

## Conventions

- **Everything is under `/api/v1`.** The version is in the path and will change only for a breaking change.
- **Authentication** is a session cookie or an API token in `Authorization: Bearer`. Token rights are the account's rights, never more.
- **Writes need the CSRF header** when they authenticate by cookie — see `docs/administration.md`.
- **Errors** share one shape: `{ error: { code, message } }`, with the code taken from a fixed set (`OBJECT_INVALID`, `NOT_FOUND`, `CONFLICT`, `FORBIDDEN`, …) so a client can branch on it without matching on prose.
- **Credentials are never returned.** Parameters a sensor type marks `writeOnly` are stripped from every response in one place; reads carry `redactedParams` instead.
- **Concurrent edits** use `If-Match` with the object's `version`; a stale one is `409`.
- **A body whose schema requires nothing may be left out.** It is read as `{}`, defaults and all. A body that is present has to be JSON: an empty one sent as `application/json` is a `400`.

### Reading the field tables

- **Every level is listed.** A field's path names its parents: `skew.kind` is `kind` inside `skew`, `items[].name` is `name` in each element of `items`, and `counts.*` is every value of a map keyed by name.
- **A field that takes one of several shapes** lists each under its own path, named by the field that tells them apart: `source{kind=own}.objectId` exists only when `kind` is `own`.
- **Shared shapes are under [Schemas](#schemas)** and linked wherever a route uses them, rather than listed again in each.
- **Flags:** `required` must be present, `nullable` may be `null`, `write-only` is accepted and never returned, `default` is what an absent field is read as.
- **Rules** below a table are the conditions that decide which fields may appear together.

---

## access

### `GET /api/v1/objects/{id}/access`

The grants sitting directly on this object

Only the explicit ones. What an account may actually do here is the *resolved* right, which walks the ancestors — see /objects/:id/access/effective.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, at least 1 | **required** |

**200** { items }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `items` | object[] | **required** |  |
| `items[].groupId` | integer | **required** |  |
| `items[].groupName` | string | **required** |  |
| `items[].right` | `none` · `read` · `write` · `full` | **required** | none cannot see it; read may look; write may edit, create and delete beneath it, acknowledge alarms and manage notifications; full adds editing that object’s own group rights. A stored `none` is not the same as no grant: it *overrides* what would be inherited, where revoking restores it. |
| `items[].grantedBy` | string | **required** |  |

### `GET /api/v1/objects/{id}/access/effective`

What an account may actually do with this object

Resolves the three rules — inheritance up the tree, explicit beats inherited, highest wins across groups — and reports where the winning grant came from, which is what makes a refusal debuggable. Without `userId` it answers about the calling account; asking about somebody else needs an administrator. **An account that is not an administrator, asking about itself, is told `none` with no source** wherever it holds nothing, as it is for an id that does not exist, so that an object hidden from it cannot be told from one that is not there (`A-49`).

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `userId` | query | integer, at least 1 |  |
| `id` | path | integer, at least 1 | **required** |

**200** { right, sourceObjectId, sourceGroupId, inherited, viaAdminGroup, cappedByRole, cappedByToken }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `right` | `none` · `read` · `write` · `full` | **required** | none cannot see it; read may look; write may edit, create and delete beneath it, acknowledge alarms and manage notifications; full adds editing that object’s own group rights. A stored `none` is not the same as no grant: it *overrides* what would be inherited, where revoking restores it. |
| `sourceObjectId` | integer | nullable |  |
| `sourceGroupId` | integer | nullable |  |
| `inherited` | boolean | **required** |  |
| `viaAdminGroup` | boolean | **required** | The account administers everything, so no grant was consulted at all. |
| `cappedByRole` | boolean |  | The account’s role held the right below what its groups granted (A-04). Reported rather than silent: "you have full on this device and may not edit it" is incomprehensible without it. |
| `cappedByToken` | boolean |  | The API token used for this request held it below that (A-06). |

### `PUT /api/v1/objects/{id}/access/{groupId}`

Grant a group a right on this object

Replaces any grant this group already had here. Everything beneath inherits it, until something lower overrides it for the same group.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, at least 1 | **required** |
| `groupId` | path | integer, at least 1 | **required** |

**Body**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `right` | `none` · `read` · `write` · `full` | **required** | none cannot see it; read may look; write may edit, create and delete beneath it, acknowledge alarms and manage notifications; full adds editing that object’s own group rights. A stored `none` is not the same as no grant: it *overrides* what would be inherited, where revoking restores it. |

**200** { items }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `items` | object[] | **required** |  |
| `items[].groupId` | integer | **required** |  |
| `items[].groupName` | string | **required** |  |
| `items[].right` | `none` · `read` · `write` · `full` | **required** | none cannot see it; read may look; write may edit, create and delete beneath it, acknowledge alarms and manage notifications; full adds editing that object’s own group rights. A stored `none` is not the same as no grant: it *overrides* what would be inherited, where revoking restores it. |
| `items[].grantedBy` | string | **required** |  |

### `DELETE /api/v1/objects/{id}/access/{groupId}`

Remove a grant, so the object falls back to what it inherits

Not the same as granting `none`, which overrides inheritance rather than restoring it. An administrator needs both: one undoes a mistake, the other carves a hole in a branch somebody else has access to.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, at least 1 | **required** |
| `groupId` | path | integer, at least 1 | **required** |

**200** { removed, items }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `removed` | boolean | **required** |  |
| `items` | object[] | **required** |  |
| `items[].groupId` | integer | **required** |  |
| `items[].groupName` | string | **required** |  |
| `items[].right` | `none` · `read` · `write` · `full` | **required** | none cannot see it; read may look; write may edit, create and delete beneath it, acknowledge alarms and manage notifications; full adds editing that object’s own group rights. A stored `none` is not the same as no grant: it *overrides* what would be inherited, where revoking restores it. |
| `items[].grantedBy` | string | **required** |  |

## accounts

### `GET /api/v1/accounts`

Every account, for choosing one

Listed by login, for the notification recipients editor. Only what choosing an account needs: the login, the display name, whether it is disabled and whether it has an address a message can go to. Its role, address and sign-in history are not listed.

**200** { items }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `items` | object[] | **required** |  |
| `items[].id` | integer | **required** |  |
| `items[].login` | string | **required** |  |
| `items[].displayName` | string | **required** |  |
| `items[].disabled` | boolean | **required** | A disabled account is skipped when a notification is sent (`M-19`). |
| `items[].hasAddress` | boolean | **required** | Whether the account has an email address. One without is skipped when a notification is sent, and the log says so. The address itself is not listed. |

## audit

### `GET /api/v1/objects/{id}/audit`

An object's configuration history, newest first: who changed it, when, and what changed. Page with `before`, using the `nextBefore` from the previous page. Sensor parameters changed are listed in `summary.paramsChanged` by key. Values appear in `diff` for parameters the sensor type does not mark `writeOnly`; a credential never appears in either, in any entry, at any age. **Grant entries are an administrator's**, as the grants themselves are: `full` on an object does not let an account read who else may see it, so for anybody else they are left out and a page is still a full page of the rest. **So are a probe's trust entries** (`A-46`) — its address, where it may connect from and the notes on it — as `GET /probes` is. **A count of what is beneath the object** (`sensorsAffected`, `movedCount`, `clonedCount`) is left out for a reader who cannot see all of it, and a reorder's positions for one who cannot see every sibling: each was counted over whoever acted, and would count what this reader cannot see. **An id naming an object the reader cannot see reads null** (`A-51`): where a move came from and went, the probes it left and joined, a reorder's parent, a clone's source and a dependency's master.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `before` | query | string, matches `^[0-9]{1,19}$` |  |
| `limit` | query | integer, 1–500 | default `100` |
| `id` | path | integer, 1–9007199254740991 | **required** |

**200** { items, nextBefore }

**200** is [ms:auditPage](#schema-ms-auditpage)

### `GET /api/v1/audit`

Configuration history across the whole installation, newest first — the object history third of the Logs view (`CAPABILITIES.MD §6`). Filter by `category` (the action's first segment), by `actorKind`, by time, or to one object. **`objectId` is that object exactly, never its subtree**: the entry most worth reading is the one recording a deletion, and an object that has been deleted has no parent left to be found through, so a subtree walk would drop precisely those. Page with `before`.

| Parameter | In | Type | | Description |
| --- | --- | --- | --- | --- |
| `objectId` | query | integer, at least 1 |  |  |
| `category` | query | `object` · `setting` · `credential` · `channel` · `trigger` · `template` · `schedule` · `sensor` · `report` · `library` · `map` · `grant` · `probe` · `discovery` · `account` · `group` · `token`, or an array of them, at most 17 items |  |  |
| `actorKind` | query | `user` · `token` · `system` · `anonymous`, or an array of them, at most 4 items |  |  |
| `actorRef` | query | string, at most 64 characters |  | One specific actor — a user id, a token id, a component name. "Everything this person did" is the question an audit log gets opened for, and `actorKind` cannot answer it: it narrows to all users, which during an incident is everybody. Pair it with `actorKind`, because an id is only unique within a kind. |
| `from` | query | string, at most 64 characters |  |  |
| `to` | query | string, at most 64 characters |  |  |
| `before` | query | string, matches `^[0-9]{1,19}$` |  |  |
| `limit` | query | integer, 1–500 | default `100` |  |

**200** { items, nextBefore }

**200** is [ms:auditPage](#schema-ms-auditpage)

## auth

### `POST /api/v1/auth/login`

Exchange a login and password for a session

Every failure answers 401 with the same code and the same sentence. Distinguishing "no such account" from "wrong password" would let a caller test which logins exist, and a login is half a credential — so which it was goes to the core log instead. An attempt turned away before its password is checked answers 429 `AUTH_THROTTLED` with `Retry-After`: its address has failed too often (an IPv6 address counts as its /64), the account has failed and its delay has not passed, or another attempt at the same account is being checked. An address that has signed in as that account in the last 30 days skips the delay (`A-47`).

**Body**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `login` | string, 1–64 characters | **required** |  |
| `password` | string, 1–512 characters | **required** **write-only** |  |
| `code` | string, at most 64 characters | **write-only** | A TOTP code or a recovery code, when the account needs one. A login without it answers 401 MFA_REQUIRED, which is how a client knows to ask. |

**200** { userId, login, role, mustChangePassword }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `userId` | integer | **required** |  |
| `login` | string | **required** |  |
| `role` | `admin` · `readwrite` · `readonly` | **required** |  |
| `mustChangePassword` | boolean | **required** | The password was set by somebody else — the bootstrap, or an administrator resetting it. A client should send the user to a change-password form before anything else. |

### `POST /api/v1/auth/logout`

End the current session

Idempotent, and public: logging out with a session that has already expired is the ordinary case and must not answer 401, or a client can be stuck unable to clear it.

**204**

### `GET /api/v1/auth/me`

Who this session belongs to

**200** { userId, login, role, mustChangePassword }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `userId` | integer | **required** |  |
| `login` | string | **required** |  |
| `role` | `admin` · `readwrite` · `readonly` | **required** |  |
| `mustChangePassword` | boolean | **required** | The password was set by somebody else — the bootstrap, or an administrator resetting it. A client should send the user to a change-password form before anything else. |

### `GET /api/v1/auth/session`

Whether this installation needs a login, and whether this caller has one

Public, and the first call a browser client makes (`U-17`). `GET /auth/me` cannot answer this: it refuses an anonymous caller with 401, and a 401 from it means both "log in" and "this installation does not need you to" — with `api.requireAuthentication` off, an anonymous caller may use the whole API and still gets that 401 from this one route. A client unable to tell those apart has to choose between demanding a login the core does not want and rendering an application whose every request will be refused. Nothing is disclosed that an unauthenticated request does not already reveal by being answered or refused.

**200** { requireAuthentication, authenticated, principal }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `requireAuthentication` | boolean | **required** | Whether `/api/` routes are refused without a principal. |
| `authenticated` | boolean | **required** |  |
| `principal` | object |  |  |
| `principal.userId` | integer | **required** |  |
| `principal.login` | string | **required** |  |
| `principal.role` | `admin` · `readwrite` · `readonly` | **required** |  |
| `principal.mustChangePassword` | boolean | **required** | The password was set by somebody else — the bootstrap, or an administrator resetting it. A client should send the user to a change-password form before anything else. |

### `GET /api/v1/auth/mfa`

Whether this account has, or needs, a second factor

`required` and `confirmed` are reported separately because the gap between them is the interesting state: an account a policy now demands MFA of, which has not set it up, has to be walked through enrolment before it can do anything.

**200** { enrolled, confirmed, required, recoveryCodesLeft }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `enrolled` | boolean | **required** |  |
| `confirmed` | boolean | **required** |  |
| `required` | boolean | **required** |  |
| `recoveryCodesLeft` | integer | **required** | Zero, with MFA on, is a lockout waiting for a lost phone. |

### `POST /api/v1/auth/mfa/enrol`

Begin enrolment

Returns a secret and an otpauth:// URI for a QR code. **Nothing changes until the enrolment is confirmed with a code from the device** — an unconfirmed secret does nothing at all, which is what stops a mistyped setup locking somebody out.

**200** { secret, uri }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `secret` | string | **required** | Base32, for typing in by hand. |
| `uri` | string | **required** | otpauth:// URI to render as a QR code. |

### `POST /api/v1/auth/mfa/confirm`

Confirm enrolment with a code, and receive recovery codes

The recovery codes are in this response and nowhere else, ever again. They exist because an installation that can only be entered with a device somebody is holding is one that a dropped phone takes down.

**Body**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `code` | string, 1–64 characters | **required** **write-only** |  |

**200** { recoveryCodes }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `recoveryCodes` | string[] | **required** |  |

### `POST /api/v1/auth/mfa/disable`

Turn off multi-factor authentication

Needs the account password. Turning off a second factor from a session alone would make a stolen session enough to remove the thing protecting against stolen sessions.

**Body**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `password` | string, 1–512 characters | **required** **write-only** |  |

**204**

### `POST /api/v1/auth/mfa/recovery-codes`

Issue a fresh set of recovery codes

The previous set stops working immediately.

**200** { recoveryCodes }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `recoveryCodes` | string[] | **required** |  |

### `POST /api/v1/auth/password`

Change your own password

Ends every *other* session this account holds. The reason somebody changes a password is usually that they think somebody else knows it, and leaving the sessions it opened is leaving the door they were worried about. The session making the change survives, so changing your password does not log you out of the tab you did it in.

**Body**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `currentPassword` | string, 1–512 characters | **required** **write-only** |  |
| `newPassword` | string, 12–512 characters | **required** **write-only** |  |

**200** { endedSessions }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `endedSessions` | integer | **required** |  |

### `GET /api/v1/auth/tokens`

The API tokens this account holds

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `includeRevoked` | query | `true` · `false` |  |

**200** { items }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `items` | object[] | **required** |  |
| `items[].id` | integer | **required** |  |
| `items[].name` | string | **required** |  |
| `items[].prefix` | string | **required** | The first few characters, so a list of tokens is readable. Never enough to use — the rest is shown once at creation and is unrecoverable afterwards. |
| `items[].scope` | `none` · `read` · `write` · `full` | **required** | A ceiling, not a grant. The effective right is the lesser of this, the account’s role and what its groups grant on the object — so a token can only ever be less than its owner. |
| `items[].expiresAt` | string | nullable |  |
| `items[].lastUsedAt` | string | nullable |  |
| `items[].revokedAt` | string | nullable |  |
| `items[].createdAt` | string | **required** |  |

### `POST /api/v1/auth/tokens`

Issue an API token

The secret is in this response and nowhere else, ever again — only its hash is stored. A scope higher than the account’s own role is lowered to it rather than refused, because the request is coherent and the answer is simply "that is as much as you have".

**Body**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `name` | string, 1–100 characters | **required** |  |
| `scope` | `none` · `read` · `write` · `full` | default `read` |  |
| `expiresAt` | string (date-time) |  |  |

**201** { token, secret }

**201 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `token` | object | **required** |  |
| `token.id` | integer | **required** |  |
| `token.name` | string | **required** |  |
| `token.prefix` | string | **required** | The first few characters, so a list of tokens is readable. Never enough to use — the rest is shown once at creation and is unrecoverable afterwards. |
| `token.scope` | `none` · `read` · `write` · `full` | **required** | A ceiling, not a grant. The effective right is the lesser of this, the account’s role and what its groups grant on the object — so a token can only ever be less than its owner. |
| `token.expiresAt` | string | nullable |  |
| `token.lastUsedAt` | string | nullable |  |
| `token.revokedAt` | string | nullable |  |
| `token.createdAt` | string | **required** |  |
| `secret` | string | **required** | Shown once. Store it now; it cannot be retrieved again. |

### `DELETE /api/v1/auth/tokens/{id}`

Revoke one of this account’s tokens

Scoped to the caller’s own tokens: a token id is a small integer, and revoking somebody else’s would otherwise be one guess away.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, at least 1 | **required** |

**204**

## channels

### `GET /api/v1/objects/{id}/channels`

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, 1–9007199254740991 | **required** |

**200** { items }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `items` | [ms:channelRecord](#schema-ms-channelrecord)[] | **required** |  |

### `PATCH /api/v1/objects/{id}/channels/{key}`

Sets a channel’s error and warning limits, the lookup that decides its state, or both. `limits` is a patch: `null` clears one threshold, an absent field leaves it alone. Both are immediate — a reading past an error limit, or one a lookup maps to an error, sets the sensor Down on the very first sample with no two-step rule. A channel with a lookup is judged by it *instead of* its limits. Limits that contradict each other are refused with the reason; a `lookupId` this installation has not loaded is accepted and reported, because a sensor type may ship ahead of its lookup file. `processing` sets the scaling factors, the spike filter and the decimal places — scaling is applied before anything judges the reading, and before the spike filter, so both bounds and limits are numbers in the channel’s own unit. Changing a factor does not rewrite readings already stored, so the graph steps at the moment of the change.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, 1–9007199254740991 | **required** |
| `key` | path | string, 1–100 characters | **required** |

**Body**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `limits` | object |  |  |
| `limits.enabled` | boolean |  |  |
| `limits.upperError` | number | nullable |  |
| `limits.upperWarning` | number | nullable |  |
| `limits.lowerWarning` | number | nullable |  |
| `limits.lowerError` | number | nullable |  |
| `limits.errorMessage` | string, at most 500 characters |  |  |
| `limits.warningMessage` | string, at most 500 characters |  |  |
| `lookupId` | string, 1–100 characters | nullable |  |
| `processing` | object |  |  |
| `processing.scaleMul` | string, at most 40 characters, matches `^-?[0-9]+(\.[0-9]+)?$` |  |  |
| `processing.scaleDiv` | string, at most 40 characters, matches `^-?[0-9]+(\.[0-9]+)?$` |  |  |
| `processing.decimals` | integer, 0–10 | nullable |  |
| `processing.spikeMin` | number | nullable |  |
| `processing.spikeMax` | number | nullable |  |

- at least 1 field must be given
- `limits`: at least 1 field must be given
- `processing`: at least 1 field must be given

**200** { id, sensorId, key, name, unit, isPrimary, scaleMul, scaleDiv, decimals, limits, spikeMin, spikeMax, showInGraph, showInTable, lookupId, retired }

**200** is [ms:channelRecord](#schema-ms-channelrecord)

## credentials

### `GET /api/v1/objects/{id}/credentials`

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `effective` | query | `true` · `false` |  |
| `id` | path | integer, 1–9007199254740991 | **required** |

**200** { items }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `items` | [ms:credentialView](#schema-ms-credentialview)[] | **required** |  |

### `GET /api/v1/credentials/unbounded`

The credential sets with no `allowedTargets` and no SSH `hostKeys`, each with the object it is stored on (`U-21`). `write` on that object is trust with the set (`A-41`), so this is the list to work through. **Only sets on objects the caller can see**: Core Health's `credentialsUnbounded` counts the installation's, and may be higher. No secret, and no public field either: the set itself is read from its object.

**200** { items }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `items` | object[] | **required** |  |
| `items[].objectId` | integer | **required** |  |
| `items[].objectKind` | `root` · `probe` · `group` · `device` · `sensor` | **required** |  |
| `items[].objectName` | string | **required** |  |
| `items[].kind` | `snmp` · `windows` · `ssh` · `vmware` · `database` · `http` · `mail` | **required** |  |
| `items[].updatedAt` | string | **required** |  |

### `GET /api/v1/credential-kinds`

The credential kinds this build can use, with the JSON Schema a form is generated from (`A-05`). Fields marked `writeOnly` are the secret half: they are encrypted at rest and **never returned by any route, to anyone**, so a form renders them as "set" with Replace and Clear rather than as a filled input. A kind absent from this list has no transport behind it yet, and storing a password nothing authenticates with is worse than not offering the field.

**200** { items }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `items` | object[] | **required** |  |
| `items[].id` | string | **required** |  |
| `items[].name` | string | **required** |  |
| `items[].description` | string | **required** |  |
| `items[].schema` | object | **required** |  |

### `PUT /api/v1/objects/{id}/credentials/{kind}`

Stores the credential set of this kind on this object, where everything below it inherits it (`CAPABILITIES.MD §10`). **A secret this omits is kept**, exactly as a sensor's `writeOnly` parameter is: a read never returns the value, so a client cannot send it back, and replacing the whole record would delete the community string every time somebody corrected the SNMP version beside it. Send the field with a value to rotate it, or `null` to remove it. **`values` is checked against the kind**, and a field it does not declare is refused with 400 naming it: a secret sent under a mistyped name would otherwise be stored as a public field. The response carries no secret. **Storing a set here vouches for sending it** wherever the sensors beneath that now inherit it send it (`A-41`). **Unless it has `allowedTargets`, or an SSH set `hostKeys`** (`A-41b`): then it goes to every sensor inside them whoever wrote the sensor, and to none outside, and `withholds` says how many sensors beneath are outside now. **What this write changes is beside it** (`A-55`): `withheldBefore` is how many of the same sensors were outside before, `newlyWithheld` how many the write puts outside and `noLongerWithheld` how many it brings back, so a save that touches no target answers zero for both whatever `withholds` is. A sensor on a device entered by name is outside targets that are addresses when its type cannot be held to an address its probe checked; one whose type can is not counted, since its probe decides at each scan. **`byReason` gives each of the four for that case apart from a device the targets do not cover** (`A-59`), as `unpinnable` and `outside`. A write that widens them (an entry added, the list emptied, strict key checking turned off) clears the secrets it does not send again, and `secretsCleared` names them. **`?dryRun=true` is the same write, rolled back** (`U-21`): the same checks, the same refusals and the same answer, with nothing stored and nothing in the history, so a form can say what a save will do before it is confirmed. It is held to `write` on the object before anything is worked out, as the write is. **Every one of the four counts, whole and by reason, is of the sensors the caller can see**: with a `none` carved beneath the object, the sensors inside it are kept from the set and not counted here. The installation’s log keeps the whole numbers (outside after the write, put there by it, brought back by it); the history this API serves carries no count for a credential write.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `dryRun` | query | `true` · `false` |  |
| `id` | path | integer, 1–9007199254740991 | **required** |
| `kind` | path | string, 1–40 characters | **required** |

**Body**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `values` | object | **required** |  |

**200** { kind, publicParams, source, updatedAt, bounded, secretsSet, withholds, withheldBefore, newlyWithheld, noLongerWithheld, byReason, secretsCleared }

**200** is [ms:credentialWrite](#schema-ms-credentialwrite)

### `DELETE /api/v1/objects/{id}/credentials/{kind}`

Removes the credential set defined *on this object*. It does not leave the object without credentials: whatever an ancestor defines comes back into force, and the response says which, so removing a device-level community string tells you the group's one is now in use rather than leaving it to be discovered. **403** when the set that comes back into force would reach a sensor somewhere nobody with `write` on where it is stored vouched for, and you do not have that `write` either (`A-41`); the set stays. `sensors` is how many sensors beneath were using the set, **of those the caller can see**. **`?dryRun=true` is the same removal, rolled back** (`U-21`): what would lose the set and what would come into force, or the same 403, with the set left where it is.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `dryRun` | query | `true` · `false` |  |
| `id` | path | integer, 1–9007199254740991 | **required** |
| `kind` | path | string, 1–40 characters | **required** |

**200** { kind, removed, sensors, nowInherited }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `kind` | `snmp` · `windows` · `ssh` · `vmware` · `database` · `http` · `mail` | **required** |  |
| `removed` | boolean | **required** |  |
| `sensors` | integer, at least 0 | **required** | How many sensors at or beneath this object resolved this kind to the set removed, of those the caller can see. Zero when there was no set to remove. |
| `nowInherited` | [ms:credentialView](#schema-ms-credentialview) | **required** nullable |  |

## dependencies

### `PUT /api/v1/objects/{id}/dependency`

Sets what this object depends on. `parent` inherits from above, `object` names a master sensor, `none` depends on nothing, and `device` makes **this sensor** the master for its parent device — which is what auto-discovery sets on a Ping sensor, and what pauses the rest of a device when it stops answering. A master pauses its dependents only when it is genuinely Down or Down (Acknowledged); pausing a master by hand or by schedule does not. `delaySeconds` keeps dependents paused after the master recovers, so a flapping link does not alarm on every bounce. A dependency that would form a loop is refused: a loop of masters can never recover. The master has to be a sensor the caller can read, here, through the settings route and in bulk alike; one they cannot read is refused as one that does not exist, and a step of a refused loop they cannot see reads `null` in `details.path` (`A-77`).

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, 1–9007199254740991 | **required** |

**Body**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `mode` | `parent` · `object` · `device` · `none` | **required** |  |
| `masterId` | integer, at least 1 |  |  |
| `delaySeconds` | integer, 0–86400 |  |  |

**200** { objectId, paused, pending, resumable, source, pausedAt, startsAt, pausedUntil, message, actor, inheritedFrom, schedule, dependency }

**200** is [ms:pauseView](#schema-ms-pauseview)

## discovery

### `POST /api/v1/discovery/preview`

What a range means, and what each level would cost

Parses a range and estimates every level, so an operator picks one knowing what it costs rather than finding out. The same parser and the same level table the run uses, so a range that previews is a range that will start and an estimate is about the run that actually happens.

**Body**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `range` | string, 1–4000 characters | **required** |  |
| `timeoutMs` | integer, 100–60000 | default `1000` |  |
| `concurrency` | integer, 1–512 | default `32` |  |

**200** { range, total, levels }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `range` | string | **required** |  |
| `total` | integer | **required** |  |
| `levels` | object[] | **required** |  |
| `levels[].id` | string | **required** |  |
| `levels[].name` | string | **required** |  |
| `levels[].description` | string | **required** |  |
| `levels[].minSeconds` | integer | **required** | If every address answers: the sweep is quick and every host is identified. |
| `levels[].maxSeconds` | integer | **required** | If none do: the sweep pays a full timeout each and there is nothing to identify. |
| `levels[].ports` | integer | **required** | How many ports each host is asked about. |

### `POST /api/v1/discovery`

Start a discovery run

Sweeps a range from one probe into one group. The probe is named rather than chosen: discovery is a local-network job, so the probe that can reach 10.0.0.0/24 is the one on that network. It has to be the probe the group is under, and one the caller can read: any other is refused `DISCOVERY_PROBE_INVALID` in the same words, so that a probe above the caller’s branch is answered as an id nobody used (`A-77`). Left out, it is the probe the group is under, which is how a writer granted a branch below a probe they cannot see starts one.

**Body**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `groupId` | integer, at least 1 | **required** |  |
| `probeId` | integer, at least 1 |  | The probe the group is under. Left out, that probe is used; named, it has to be that one and one the caller can read (`A-77`). |
| `range` | string, 1–4000 characters | **required** |  |
| `timeoutMs` | integer, 100–60000 |  |  |
| `concurrency` | integer, 1–512 |  |  |
| `ratePerSecond` | number, 0–100000 |  |  |
| `level` | `ping` · `standard` · `detailed` | default `standard` | How hard to look. `POST /discovery/preview` reports what each one costs on this range, which is worth reading before starting a detailed sweep of a /16. |
| `templates` | string[], at most 100 items, each 1–100 characters | default `[]` | Template ids this run may use. Empty means all of them. A filter rather than a fourth level, because “detailed, but only these templates” is a thing somebody wants and a level could not express it. |
| `snmpCommunity` | string, at most 128 characters | **write-only** default `` | Tried read-only against every host during identification, and skipped when empty. `sysDescr` and `sysObjectID` are the two most informative things a device will tell you, and this is the only credential identification has: it runs before anybody has told the system anything about these hosts, so v3 — which needs a username and a passphrase per device — is not available to it. |

**201** { id, groupId, probeId, range, total, cursor, found, failed, status, level, templates, identified, scheduleId, devicesCreated, devicesMatched, sensorsCreated, provisionedAt, message, timeoutMs, concurrency, ratePerSecond, createdAt, startedAt, finishedAt }

**201** is [ms:discoveryRun](#schema-ms-discoveryrun)

### `GET /api/v1/discovery/{id}`

A run and how far it has got

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, at least 1 | **required** |

**200** { id, groupId, probeId, range, total, cursor, found, failed, status, level, templates, identified, scheduleId, devicesCreated, devicesMatched, sensorsCreated, provisionedAt, message, timeoutMs, concurrency, ratePerSecond, createdAt, startedAt, finishedAt }

**200** is [ms:discoveryRun](#schema-ms-discoveryrun)

### `GET /api/v1/discovery/{id}/summary`

What a run did — scanned, found, created, errors

Derived from the run and its hosts rather than stored, so it cannot drift from what happened and a second provisioning pass updates it for free. `headline` is one sentence for the top of a page; everything under it is the same story precisely. The errors are here rather than behind a second request, because a run that created eleven devices and could not create two is exactly the case where somebody stops reading at the good number.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, at least 1 | **required** |

**200** { runId, groupId, probeId, scheduleId, range, level, status, headline, scanned, found, created, errors, timing }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `runId` | integer | **required** |  |
| `groupId` | integer |  |  |
| `probeId` | integer |  |  |
| `scheduleId` | integer | nullable | The rediscovery schedule that started it (`D-07`), or null for a run somebody started. What tells an operator where a run they did not start came from. |
| `range` | string | **required** |  |
| `level` | `ping` · `standard` · `detailed` |  |  |
| `status` | `queued` · `running` · `identifying` · `done` · `cancelled` · `failed` | **required** |  |
| `headline` | string | **required** |  |
| `scanned` | object | **required** |  |
| `scanned.addresses` | integer | **required** |  |
| `scanned.swept` | integer | **required** |  |
| `scanned.alive` | integer | **required** |  |
| `scanned.unreachable` | integer | **required** |  |
| `scanned.failed` | integer | **required** |  |
| `scanned.identified` | integer | **required** |  |
| `scanned.complete` | boolean | **required** |  |
| `found` | object | **required** |  |
| `found.byKind` | object[] | **required** |  |
| `found.byKind[].kind` | `windows` · `linux` · `network` · `printer` · `hypervisor` · `nas` · `unknown` · `unidentified` | **required** |  |
| `found.byKind[].count` | integer | **required** |  |
| `found.byVendor` | object[] | **required** |  |
| `found.byVendor[].vendor` | string | **required** |  |
| `found.byVendor[].count` | integer | **required** |  |
| `created` | object | **required** |  |
| `created.devices` | integer | **required** |  |
| `created.matched` | integer | **required** |  |
| `created.sensors` | integer | **required** |  |
| `created.provisionedAt` | string | nullable |  |
| `errors` | object[] | **required** |  |
| `errors[].address` | string | **required** |  |
| `errors[].problem` | string | **required** |  |
| `timing` | object | **required** |  |
| `timing.createdAt` | string | **required** |  |
| `timing.startedAt` | string | nullable |  |
| `timing.finishedAt` | string | nullable |  |
| `timing.durationMs` | integer | nullable |  |
| `timing.addressesPerSecond` | number | nullable |  |

### `GET /api/v1/discovery/{id}/hosts`

The addresses a run found alive

In address order rather than the order they answered, because an operator reading a list of them is looking for gaps.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `limit` | query | integer, 1–65536 | default `1000` |
| `id` | path | integer, at least 1 | **required** |

**200** { items }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `items` | object[] | **required** |  |
| `items[].address` | string | **required** |  |
| `items[].rttMs` | number | nullable |  |
| `items[].fingerprint` | object | nullable |  |

### `POST /api/v1/discovery/{id}/cancel`

Stop a run

Recorded immediately and sent to the probe as well, so a cancel works even while the probe is disconnected — otherwise the sweep would resume the moment it came back.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, at least 1 | **required** |

**200** { id, groupId, probeId, range, total, cursor, found, failed, status, level, templates, identified, scheduleId, devicesCreated, devicesMatched, sensorsCreated, provisionedAt, message, timeoutMs, concurrency, ratePerSecond, createdAt, startedAt, finishedAt }

**200** is [ms:discoveryRun](#schema-ms-discoveryrun)

### `POST /api/v1/discovery/{id}/provision`

Create the devices and sensors this run found

**Idempotent.** Devices are matched on address, then reverse name, then short name within the target group, and only sensors that are not already there are created — so running this twice creates nothing the second time. That matters because a discovery is re-run: on a schedule, or by an operator who has configured a credential and wants the sensors it unlocks. **A run whose rule was deleted creates nothing** (`A-41`): the account that wrote the rule vouched for sending the group’s credentials to the addresses it found, and deleting the rule withdraws that. With accounts on, the run is failed with the reason “its rule was deleted”, recorded in the audit log, and this answers 409 `DISCOVERY_RUN_FAILED` with the same sentence. Start a new run to provision those addresses. **Nor does a run whose group has since moved under another probe** (`P-241`): what it found was read from the old probe’s network, and would become devices in the new one’s branch. The run is failed with the reason “its group moved to another probe”, recorded in the audit log, and this answers 409 `DISCOVERY_RUN_FAILED` with that sentence. Start a new run from the group’s new probe. **It answers its caller in their own view** (`A-77`). A host at the address of a device the caller cannot see is reported in `problems` as “a device outside your view already has this address”, with no id and nothing created under the device; a sensor a template names that is already there and hidden is reported the same way and not counted in `sensorsSkipped`; and nothing is added to a device the caller may read and not write. An administrator is answered as before.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, at least 1 | **required** |

**200** { devicesCreated, matched, sensorsCreated, sensorsSkipped, mastersSet, problems, devices }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `devicesCreated` | integer | **required** |  |
| `matched` | integer | **required** | Devices that already existed. |
| `sensorsCreated` | integer | **required** |  |
| `sensorsSkipped` | integer | **required** | Sensors a template named that were already there. |
| `mastersSet` | integer |  | Devices whose reachability sensor became their master object, so one unreachable host is one alarm rather than a device’s worth. |
| `problems` | object[] |  |  |
| `problems[].address` | string | **required** |  |
| `problems[].problem` | string | **required** |  |
| `devices` | object[] |  |  |
| `devices[].address` | string | **required** |  |
| `devices[].deviceId` | integer | **required** |  |
| `devices[].created` | boolean | **required** |  |
| `devices[].sensors` | string[] |  |  |

### `GET /api/v1/discovery/{id}/problems`

What a run could not create, and why

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, at least 1 | **required** |

**200** { items }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `items` | object[] | **required** |  |
| `items[].address` | string | **required** |  |
| `items[].problem` | string | **required** |  |

### `GET /api/v1/objects/{id}/discovery`

What this group has been discovering, newest first

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `limit` | query | integer, 1–200 | default `25` |
| `id` | path | integer, at least 1 | **required** |

**200** { items }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `items` | [ms:discoveryRun](#schema-ms-discoveryrun)[] | **required** |  |

### `GET /api/v1/discovery/schedules`

Rediscovery schedules

Empty on almost every installation, because there is no schedule until somebody creates one and a new one is created **disabled**. Surprise objects are a support burden, and a monitoring system that invents devices on its own is one an operator stops trusting.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `groupId` | query | integer, at least 1 |  |

**200** { items }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `items` | object[] | **required** |  |
| `items[].id` | integer | **required** |  |
| `items[].groupId` | integer | **required** |  |
| `items[].probeId` | integer |  |  |
| `items[].name` | string | **required** |  |
| `items[].enabled` | boolean | **required** |  |
| `items[].range` | string | **required** |  |
| `items[].level` | `ping` · `standard` · `detailed` |  |  |
| `items[].templates` | string[] |  |  |
| `items[].timeoutMs` | integer |  |  |
| `items[].concurrency` | integer |  |  |
| `items[].ratePerSecond` | number |  |  |
| `items[].cadence` | string | **required** |  |
| `items[].cadenceMinute` | integer |  |  |
| `items[].cadenceWeekday` | integer |  |  |
| `items[].timezone` | string | nullable |  |
| `items[].autoProvision` | boolean |  |  |
| `items[].scheduleId` | integer | nullable |  |
| `items[].lastRunAt` | string | nullable |  |
| `items[].lastRunId` | integer | nullable |  |
| `items[].lastProblem` | string |  | Why the last firing started nothing, or empty. A rule whose group has moved under another probe is refused when it fires, and this is where that is said (`A-28`). |
| `items[].nextRunAt` | string | nullable |  |
| `items[].description` | string | **required** |  |
| `items[].version` | integer |  | What `If-Match` carries back on an edit; also the `ETag` (`D-11`). |

### `POST /api/v1/discovery/schedules`

Create a rediscovery schedule

Created **disabled** unless `enabled` says otherwise, and with `autoProvision` off: a rediscovery then sweeps and identifies, and an operator reviews the plan at `GET /discovery/:id/plan` before anything is created. Turning `autoProvision` on is safe because provisioning is idempotent — it creates what has appeared since and nothing else.

**Body**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `groupId` | integer, at least 1 | **required** |  |
| `probeId` | integer, at least 1 |  | The probe the group is under. Left out, that probe is used; named, it has to be that one and one the caller can read (`A-77`). |
| `name` | string, 1–200 characters | **required** |  |
| `range` | string, 1–4000 characters | **required** |  |
| `cadence` | `hourly` · `daily` · `weekly` | **required** |  |
| `cadenceMinute` | integer, 0–1439 | default `0` | Minutes past the hour for an hourly cadence, past midnight for the others. |
| `cadenceWeekday` | integer, 0–6 | default `0` | 0 is Monday. Read only for a weekly cadence. |
| `timezone` | string | nullable default `null` | A cadence is a statement about local time — 02:30 has to be 02:30 in both halves of the year — so it is stored as one. Null is the core’s own zone. |
| `level` | `ping` · `standard` · `detailed` | default `standard` |  |
| `templates` | string[] | default `[]` |  |
| `snmpCommunity` | string, at most 128 characters | **write-only** default `` |  |
| `timeoutMs` | integer, 100–60000 | default `1000` |  |
| `concurrency` | integer, 1–512 | default `32` |  |
| `ratePerSecond` | number, 0–100000 | default `0` |  |
| `autoProvision` | boolean | default `false` |  |
| `scheduleId` | integer | nullable default `null` | A schedule (`M-09`) used as a *permission window*: “weekly, but not during the change freeze”. It answers a different question from the cadence — is it allowed now, versus when is it next due — which is why both exist. |
| `enabled` | boolean | default `false` |  |

**201** { id, groupId, probeId, name, enabled, range, level, templates, timeoutMs, concurrency, ratePerSecond, cadence, cadenceMinute, cadenceWeekday, timezone, autoProvision, scheduleId, lastRunAt, lastRunId, lastProblem, nextRunAt, description, version }

**201 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `id` | integer | **required** |  |
| `groupId` | integer | **required** |  |
| `probeId` | integer |  |  |
| `name` | string | **required** |  |
| `enabled` | boolean | **required** |  |
| `range` | string | **required** |  |
| `level` | `ping` · `standard` · `detailed` |  |  |
| `templates` | string[] |  |  |
| `timeoutMs` | integer |  |  |
| `concurrency` | integer |  |  |
| `ratePerSecond` | number |  |  |
| `cadence` | string | **required** |  |
| `cadenceMinute` | integer |  |  |
| `cadenceWeekday` | integer |  |  |
| `timezone` | string | nullable |  |
| `autoProvision` | boolean |  |  |
| `scheduleId` | integer | nullable |  |
| `lastRunAt` | string | nullable |  |
| `lastRunId` | integer | nullable |  |
| `lastProblem` | string |  | Why the last firing started nothing, or empty. A rule whose group has moved under another probe is refused when it fires, and this is where that is said (`A-28`). |
| `nextRunAt` | string | nullable |  |
| `description` | string | **required** |  |
| `version` | integer |  | What `If-Match` carries back on an edit; also the `ETag` (`D-11`). |

### `POST /api/v1/discovery/schedules/{id}/enabled`

Turn a schedule on or off

Enabling computes the next run; disabling clears it, so a schedule that is off cannot be found by the sweep even if something else went wrong.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, at least 1 | **required** |

**Body**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `enabled` | boolean | **required** |  |

**200** { id, groupId, probeId, name, enabled, range, level, templates, timeoutMs, concurrency, ratePerSecond, cadence, cadenceMinute, cadenceWeekday, timezone, autoProvision, scheduleId, lastRunAt, lastRunId, lastProblem, nextRunAt, description, version }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `id` | integer | **required** |  |
| `groupId` | integer | **required** |  |
| `probeId` | integer |  |  |
| `name` | string | **required** |  |
| `enabled` | boolean | **required** |  |
| `range` | string | **required** |  |
| `level` | `ping` · `standard` · `detailed` |  |  |
| `templates` | string[] |  |  |
| `timeoutMs` | integer |  |  |
| `concurrency` | integer |  |  |
| `ratePerSecond` | number |  |  |
| `cadence` | string | **required** |  |
| `cadenceMinute` | integer |  |  |
| `cadenceWeekday` | integer |  |  |
| `timezone` | string | nullable |  |
| `autoProvision` | boolean |  |  |
| `scheduleId` | integer | nullable |  |
| `lastRunAt` | string | nullable |  |
| `lastRunId` | integer | nullable |  |
| `lastProblem` | string |  | Why the last firing started nothing, or empty. A rule whose group has moved under another probe is refused when it fires, and this is where that is said (`A-28`). |
| `nextRunAt` | string | nullable |  |
| `description` | string | **required** |  |
| `version` | integer |  | What `If-Match` carries back on an edit; also the `ETag` (`D-11`). |

### `PATCH /api/v1/discovery/schedules/{id}`

Change a schedule

`If-Match` carries the version the edit was made against (`W/"3"`, from the rule’s `version` or the `ETag` of the answer that returned it). Without it the request is refused with 428, and against a version that is no longer current with 412: two people editing one rule must not have the second silently undo the first. Whether it is on has its own route. The group cannot change — a rule in another group is another rule — and the probe must be the one the group is under. `snmpCommunity` left out keeps the stored one, and an empty one clears it; it is never returned. A community stays with where it is sent: an edit that changes `range` or `probeId` and leaves `snmpCommunity` out clears the stored one, and the audit entry says so — send it again with the edit to keep scanning with it. An edit that changes something clears `lastProblem`, and one that changes nothing keeps its version.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, at least 1 | **required** |

**Body**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `probeId` | integer, at least 1 |  |  |
| `name` | string, 1–200 characters |  |  |
| `range` | string, 1–4000 characters |  |  |
| `cadence` | `hourly` · `daily` · `weekly` |  |  |
| `cadenceMinute` | integer, 0–1439 |  |  |
| `cadenceWeekday` | integer, 0–6 |  |  |
| `timezone` | string | nullable |  |
| `level` | `ping` · `standard` · `detailed` |  |  |
| `templates` | string[] |  |  |
| `snmpCommunity` | string, at most 128 characters | **write-only** |  |
| `timeoutMs` | integer, 100–60000 |  |  |
| `concurrency` | integer, 1–512 |  |  |
| `ratePerSecond` | number, 0–100000 |  |  |
| `autoProvision` | boolean |  |  |
| `scheduleId` | integer | nullable |  |

- at least 1 field must be given

**200** { id, groupId, probeId, name, enabled, range, level, templates, timeoutMs, concurrency, ratePerSecond, cadence, cadenceMinute, cadenceWeekday, timezone, autoProvision, scheduleId, lastRunAt, lastRunId, lastProblem, nextRunAt, description, version }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `id` | integer | **required** |  |
| `groupId` | integer | **required** |  |
| `probeId` | integer |  |  |
| `name` | string | **required** |  |
| `enabled` | boolean | **required** |  |
| `range` | string | **required** |  |
| `level` | `ping` · `standard` · `detailed` |  |  |
| `templates` | string[] |  |  |
| `timeoutMs` | integer |  |  |
| `concurrency` | integer |  |  |
| `ratePerSecond` | number |  |  |
| `cadence` | string | **required** |  |
| `cadenceMinute` | integer |  |  |
| `cadenceWeekday` | integer |  |  |
| `timezone` | string | nullable |  |
| `autoProvision` | boolean |  |  |
| `scheduleId` | integer | nullable |  |
| `lastRunAt` | string | nullable |  |
| `lastRunId` | integer | nullable |  |
| `lastProblem` | string |  | Why the last firing started nothing, or empty. A rule whose group has moved under another probe is refused when it fires, and this is where that is said (`A-28`). |
| `nextRunAt` | string | nullable |  |
| `description` | string | **required** |  |
| `version` | integer |  | What `If-Match` carries back on an edit; also the `ETag` (`D-11`). |

### `DELETE /api/v1/discovery/schedules/{id}`

Delete a schedule

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, at least 1 | **required** |

**204**

### `GET /api/v1/device-templates`

Every device template, and anything that was refused

Refused templates are reported rather than hidden: one that failed to load creates none of the sensors it names, and nobody notices until the day one of them mattered.

**200** { items, problems }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `items` | object[] | **required** |  |
| `items[].id` | string | **required** |  |
| `items[].name` | string | **required** |  |
| `items[].description` | string | **required** |  |
| `items[].sensorCount` | integer | **required** |  |
| `items[].overridesBuiltIn` | boolean |  |  |
| `items[].source` | string | **required** | `built-in`, or the path of the file the template was read from. |
| `problems` | object[] | **required** |  |
| `problems[].id` | string | **required** |  |
| `problems[].source` | string | **required** | `built-in`, or the path of the file that was refused. |
| `problems[].problems` | string[] | **required** |  |

### `GET /api/v1/device-templates/{templateId}`

One template, in full

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `templateId` | path | string, 1–100 characters | **required** |

**200** object

### `POST /api/v1/device-templates/plan`

What a fingerprint would produce

The answer `D-04` will act on, before it acts on it. Takes a fingerprint — one of the ones a discovery run recorded — and reports which templates matched and which sensors would actually be created, given the credential kinds available. The fingerprint is checked as a stored one is: without an IPv4 `address`, a known `kind` and a number on every port, or with anything but text in a text field, it is a 400 `FINGERPRINT_INVALID` naming the field. Fields this build does not know are accepted and ignored.

**Body**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `fingerprint` | object | **required** |  |
| `credentials` | string[], each at most 40 characters | default `[]` | The credential kinds this device could resolve. A sensor whose kind is not here is left out rather than created and left failing. |

**200** { templates, sensors, tags }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `templates` | object[] | **required** |  |
| `templates[].id` | string | **required** |  |
| `templates[].name` | string | **required** |  |
| `templates[].score` | integer | **required** |  |
| `sensors` | object[] | **required** |  |
| `tags` | string[] | **required** |  |

### `GET /api/v1/discovery/{id}/plan`

What a run’s hosts would produce

The whole run at once, which is what an operator wants to look at before letting `D-04` create anything. Hosts with no fingerprint yet are reported with the generic plan, because that is what they would get.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `credentials` | query | string, at most 200 characters | default `` |
| `limit` | query | integer, 1–5000 | default `500` |
| `id` | path | integer, at least 1 | **required** |

**200** { items }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `items` | object[] | **required** |  |
| `items[].address` | string | **required** |  |
| `items[].kind` | `windows` · `linux` · `network` · `printer` · `hypervisor` · `nas` · `unknown` |  |  |
| `items[].templates` | string[] | **required** |  |
| `items[].sensors` | string[] | **required** |  |

### `POST /api/v1/objects/{id}/as-template`

A template file, from a device already set up

Returns the JSON to save under the template directory — it is not registered here, because a template is a file an operator edits and one source of truth is enough. **The match rule matches nothing until you fill it in**: only you know whether this is for this model, this vendor, or every switch, and a template that matched everything by accident would put this sensor set on every printer in the estate.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, at least 1 | **required** |

**Body**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `id` | string, 3–100 characters | **required** |  |
| `name` | string, 1–200 characters | **required** |  |
| `description` | string, at most 1000 characters |  |  |
| `match` | object |  |  |

**200** object

## groups

### `GET /api/v1/groups`

Every user group, built-in ones first

**200** { items }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `items` | object[] | **required** |  |
| `items[].id` | integer | **required** |  |
| `items[].name` | string | **required** |  |
| `items[].description` | string | **required** |  |
| `items[].isAdmin` | boolean | **required** | Members administer the whole installation. Kept as a flag rather than as a right on the root object, because "may do anything, including to objects that do not exist yet" is not a statement about a position in the tree. |
| `items[].isDefault` | boolean | **required** | The group a new account joins. |
| `items[].isBuiltin` | boolean | **required** | Cannot be deleted or renamed. Its description can be changed. |
| `items[].memberCount` | integer | **required** |  |

### `POST /api/v1/groups`

Create a user group

**Body**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `name` | string, 1–100 characters | **required** |  |
| `description` | string, at most 1000 characters |  |  |
| `isAdmin` | boolean | default `false` |  |

**201** { id, name, description, isAdmin, isDefault, isBuiltin, memberCount }

**201 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `id` | integer | **required** |  |
| `name` | string | **required** |  |
| `description` | string | **required** |  |
| `isAdmin` | boolean | **required** | Members administer the whole installation. Kept as a flag rather than as a right on the root object, because "may do anything, including to objects that do not exist yet" is not a statement about a position in the tree. |
| `isDefault` | boolean | **required** | The group a new account joins. |
| `isBuiltin` | boolean | **required** | Cannot be deleted or renamed. Its description can be changed. |
| `memberCount` | integer | **required** |  |

### `PUT /api/v1/groups/{id}`

Rename a group, describe it, or change what it grants

A built-in group accepts only a description. Renaming Administrators or clearing its admin flag is a one-way door out of your own installation.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, at least 1 | **required** |

**Body**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `name` | string, 1–100 characters |  |  |
| `description` | string, at most 1000 characters |  |  |
| `isAdmin` | boolean |  |  |

**200** { id, name, description, isAdmin, isDefault, isBuiltin, memberCount }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `id` | integer | **required** |  |
| `name` | string | **required** |  |
| `description` | string | **required** |  |
| `isAdmin` | boolean | **required** | Members administer the whole installation. Kept as a flag rather than as a right on the root object, because "may do anything, including to objects that do not exist yet" is not a statement about a position in the tree. |
| `isDefault` | boolean | **required** | The group a new account joins. |
| `isBuiltin` | boolean | **required** | Cannot be deleted or renamed. Its description can be changed. |
| `memberCount` | integer | **required** |  |

### `DELETE /api/v1/groups/{id}`

Delete a group

Members are not deleted with it, and anybody whose primary group this was is given another — a user with groups and no primary among them is a state object ownership has no answer for.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, at least 1 | **required** |

**204**

### `GET /api/v1/groups/{id}/members`

Who is in this group

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, at least 1 | **required** |

**200** { items }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `items` | object[] | **required** |  |
| `items[].userId` | integer | **required** |  |
| `items[].login` | string | **required** |  |
| `items[].isPrimary` | boolean | **required** |  |

### `PUT /api/v1/groups/{id}/members/{userId}`

Add an account to a group

Idempotent. The first group an account joins becomes its primary one; adding it to a second does not move that unless asked.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, at least 1 | **required** |
| `userId` | path | integer, at least 1 | **required** |

**Body**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `primary` | boolean | default `false` |  |

**200** { items }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `items` | object[] | **required** |  |
| `items[].groupId` | integer | **required** |  |
| `items[].name` | string | **required** |  |
| `items[].isAdmin` | boolean | **required** |  |
| `items[].isPrimary` | boolean | **required** | The *default* group, not the strongest one: it answers which group owns an object this user creates, and nothing else. Access is the union of every group they are in. |

### `DELETE /api/v1/groups/{id}/members/{userId}`

Remove an account from a group

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, at least 1 | **required** |
| `userId` | path | integer, at least 1 | **required** |

**200** { items }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `items` | object[] | **required** |  |
| `items[].groupId` | integer | **required** |  |
| `items[].name` | string | **required** |  |
| `items[].isAdmin` | boolean | **required** |  |
| `items[].isPrimary` | boolean | **required** | The *default* group, not the strongest one: it answers which group owns an object this user creates, and nothing else. Access is the union of every group they are in. |

### `GET /api/v1/accounts/{id}/groups`

Every group an account belongs to, primary first

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, at least 1 | **required** |

**200** { items }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `items` | object[] | **required** |  |
| `items[].groupId` | integer | **required** |  |
| `items[].name` | string | **required** |  |
| `items[].isAdmin` | boolean | **required** |  |
| `items[].isPrimary` | boolean | **required** | The *default* group, not the strongest one: it answers which group owns an object this user creates, and nothing else. Access is the union of every group they are in. |

### `PUT /api/v1/accounts/{id}/primary-group/{groupId}`

Choose which of an account’s groups is its primary one

Refused for a group the account does not belong to — a rule the schema cannot express, since a foreign key could not say "and they must be a member of it".

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, at least 1 | **required** |
| `groupId` | path | integer, at least 1 | **required** |

**200** { items }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `items` | object[] | **required** |  |
| `items[].groupId` | integer | **required** |  |
| `items[].name` | string | **required** |  |
| `items[].isAdmin` | boolean | **required** |  |
| `items[].isPrimary` | boolean | **required** | The *default* group, not the strongest one: it answers which group owns an object this user creates, and nothing else. Access is the union of every group they are in. |

## health

### `GET /api/v1/core-health`

How the core itself is doing, right now

The same numbers the Core Health sensor records, read live. **A `null` is a gap and never a zero** — CPU is null on the first reading after a start because it is a rate and there is nothing to measure against yet, and a rollup tier that has never run is not a tier that is infinitely behind. `rollupLag` is the excess over a tier’s own bucket width, so a healthy daily tier reads 0 rather than 86,400.

**200** { at, channels } · **503** { error }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `at` | string | **required** |  |
| `channels` | object | **required** |  |
| `channels.ingestQueue` | number | nullable |  |
| `channels.writeLatency` | number | nullable |  |
| `channels.ingestRefused` | number | nullable |  |
| `channels.cpu` | number | nullable |  |
| `channels.memory` | number | nullable |  |
| `channels.heap` | number | nullable |  |
| `channels.memoryAvailable` | number | nullable |  |
| `channels.memoryAvailableBytes` | number | nullable |  |
| `channels.memoryLimitUsage` | number | nullable |  |
| `channels.memoryLimit` | number | nullable |  |
| `channels.uptime` | number | nullable |  |
| `channels.rollupLag` | number | nullable |  |
| `channels.backfillQueue` | number | nullable |  |
| `channels.backfillParked` | number | nullable |  |
| `channels.diskFree` | number | nullable |  |
| `channels.diskFreeBytes` | number | nullable |  |
| `channels.databaseSize` | number | nullable |  |
| `channels.evictedChunks` | number | nullable |  |
| `channels.reapQueue` | number | nullable |  |
| `channels.notifyPending` | number | nullable |  |
| `channels.notifyOldest` | number | nullable |  |
| `channels.notifyFailed` | number | nullable |  |
| `channels.streamCutoffs` | number | nullable |  |
| `channels.streamCoalesced` | number | nullable |  |
| `channels.streamEnded` | number | nullable |  |
| `channels.streamExpired` | number | nullable |  |
| `channels.streamRevoked` | number | nullable |  |
| `channels.streamDisabled` | number | nullable |  |
| `channels.streamCheckFailures` | number | nullable |  |
| `channels.streamUnsure` | number | nullable |  |
| `channels.streamChecksOutstanding` | number | nullable |  |
| `channels.streamEdgesUnvetted` | number | nullable |  |
| `channels.streamWithheld` | number | nullable |  |
| `channels.streamEdgesCoalesced` | number | nullable |  |
| `channels.dependencyPauses` | number | nullable |  |
| `channels.probesDown` | number | nullable |  |
| `channels.probesSilent` | number | nullable |  |
| `channels.alarmOverdue` | number | nullable |  |
| `channels.alarmsFired` | number | nullable |  |
| `channels.queriesRefused` | number | nullable |  |
| `channels.reportsDeferred` | number | nullable |  |
| `channels.reportsFailed` | number | nullable |  |
| `channels.reportsUndelivered` | number | nullable |  |
| `channels.reportFormatsWaiting` | number | nullable |  |
| `channels.reportFormatsRefused` | number | nullable |  |
| `channels.resultsFutureDated` | number | nullable |  |
| `channels.resultsPastDated` | number | nullable |  |
| `channels.resultsUnreadableTime` | number | nullable |  |
| `channels.resultsRefusedUnfit` | number | nullable |  |
| `channels.readingsDroppedUnfit` | number | nullable |  |
| `channels.channelsCreatedUndeclared` | number | nullable |  |
| `channels.channelsCreatedOutsideDeclaration` | number | nullable |  |
| `channels.sensorsWithInvalidParams` | number | nullable |  |
| `channels.clockBehind` | number | nullable |  |
| `channels.reactionsDeferred` | number | nullable |  |
| `channels.credentialsToReenter` | number | nullable |  |
| `channels.credentialsUnbounded` | number | nullable |  |
| `channels.credentialsWithheld` | number | nullable |  |
| `channels.lateRefusalWritesGivenUp` | number | nullable |  |
| `channels.logDropped` | number | nullable |  |
| `channels.logBacklog` | number | nullable |  |
| `channels.hostsRefused` | number | nullable |  |
| `channels.probeHellosUnproven` | number | nullable |  |
| `channels.rateLimited` | number | nullable |  |
| `channels.heartbeatFailures` | number | nullable |  |
| `channels.dbStatementTimeouts` | number | nullable |  |
| `channels.dbLockTimeouts` | number | nullable |  |
| `channels.dbOldestQuerySeconds` | number | nullable |  |

**503** is [ms:error](#schema-ms-error)

### `GET /api/v1/probes/{id}/health`

How one probe is doing, right now

**Answers for a probe that is not connected**, which is the whole reason Probe Health is evaluated by the core: a probe cannot report its own absence. `connected` is 0 then and every other channel is `null` — a gap, because the probe’s numbers are not zero, they are unknown, and a scheduler lag of 0 ms from a probe that is gone would be the most misleading reading this system could produce. A probe below protocol 7 cannot send its own numbers either; the message says so in words rather than leaving the channels silently absent, and it names the last hello refused over the version, with `lastProtocolRefusedAt` as its time, whenever that is set: not the last hello, since one refused before it proved it is this probe (its key, its address) is not recorded. `numbersUnavailable` says why the probe’s own numbers are gaps, as a value: `not-connected`; `protocol`, the only reason that is about versions, with the version it speaks and the one its numbers need; `no-heartbeat`, connected and none arrived yet, with how long it has been connected; `not-reported`, heartbeats that carry none. `null` when it reported them. `protocolVersion` is the version the probe speaks on its current connection, `null` when it is not connected: a probe that reports, below the version a channel arrived in, leaves that channel a gap whether or not what it counts is running. `lastProtocolVersion` is the version the probe declared at the last handshake the core recorded, kept after it disconnects: the one `GET /probes` shows, said of that connection and not of the probe now, which may have been upgraded since. `null` when none is recorded or the database could not be asked. `lastProtocolVersionAt` is when a handshake the core accepted spoke that version, as ISO 8601: not when the probe was last seen, which a refused hello moves too. `null` whenever `lastProtocolVersion` is, beside a version a hello was refused over, and for one recorded before the core kept the time. `lastProtocolRefusedAt` is when a hello was last refused over that version, as ISO 8601: no handshake has been accepted since, and a core with the same floor will refuse that version again. Never beside `lastProtocolVersionAt`, and `null` whenever `lastProtocolVersion` is, beside an accepted version, and for one recorded before the core kept the time. A `lastProtocolVersion` of 0 is served only beside it: a 0 without it is nothing recorded, and is `null`.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, at least 1 | **required** |

**200** { at, probeId, message, numbersUnavailable, protocolVersion, lastProtocolVersion, lastProtocolVersionAt, lastProtocolRefusedAt, channels } · **503** { error }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `at` | string | **required** |  |
| `probeId` | integer | **required** |  |
| `message` | string | **required** |  |
| `numbersUnavailable` | object | **required** nullable |  |
| `numbersUnavailable.reason` | `not-connected` · `protocol` · `no-heartbeat` · `not-reported` | **required** |  |
| `numbersUnavailable.protocolVersion` | integer |  |  |
| `numbersUnavailable.requiredVersion` | integer |  |  |
| `numbersUnavailable.connectedSeconds` | integer |  |  |
| `protocolVersion` | integer | **required** nullable |  |
| `lastProtocolVersion` | integer | **required** nullable |  |
| `lastProtocolVersionAt` | string (date-time) | **required** nullable |  |
| `lastProtocolRefusedAt` | string (date-time) | **required** nullable |  |
| `channels` | object | **required** |  |
| `channels.connected` | number | nullable |  |
| `channels.heartbeatAge` | number | nullable |  |
| `channels.delivering` | number | nullable |  |
| `channels.resultAge` | number | nullable |  |
| `channels.checksCompleting` | number | nullable |  |
| `channels.checksBehind` | number | nullable |  |
| `channels.checksOutstanding` | number | nullable |  |
| `channels.checkStalled` | number | nullable |  |
| `channels.protocol` | number | nullable |  |
| `channels.protocolFlap` | number | nullable |  |
| `channels.reportsRefused` | number | nullable |  |
| `channels.reportsForeign` | number | nullable |  |
| `channels.lateRefusals` | number | nullable |  |
| `channels.resultsWithheld` | number | nullable |  |
| `channels.schedulerLag` | number | nullable |  |
| `channels.skippedTicks` | number | nullable |  |
| `channels.poolUsage` | number | nullable |  |
| `channels.sessionsOpen` | number | nullable |  |
| `channels.sessionOverflows` | number | nullable |  |
| `channels.sessionsEvicted` | number | nullable |  |
| `channels.sessionsOpened` | number | nullable |  |
| `channels.poolCeiling` | number | nullable |  |
| `channels.poolMemoryCap` | number | nullable |  |
| `channels.poolHeldBack` | number | nullable |  |
| `channels.queued` | number | nullable |  |
| `channels.checkWait` | number | nullable |  |
| `channels.deferred` | number | nullable |  |
| `channels.refused` | number | nullable |  |
| `channels.timedOut` | number | nullable |  |
| `channels.workerCrashes` | number | nullable |  |
| `channels.workerStartupFailed` | number | nullable |  |
| `channels.poolState` | number | nullable |  |
| `channels.discarded` | number | nullable |  |
| `channels.trapReceived` | number | nullable |  |
| `channels.trapRejected` | number | nullable |  |
| `channels.trapMalformed` | number | nullable |  |
| `channels.syslogReceived` | number | nullable |  |
| `channels.syslogRejected` | number | nullable |  |
| `channels.syslogMalformed` | number | nullable |  |
| `channels.trapOverwritten` | number | nullable |  |
| `channels.syslogOverwritten` | number | nullable |  |
| `channels.trapEarlier` | number | nullable |  |
| `channels.syslogEarlier` | number | nullable |  |
| `channels.flowReceived` | number | nullable |  |
| `channels.flowRejected` | number | nullable |  |
| `channels.flowMalformed` | number | nullable |  |
| `channels.flowMissed` | number | nullable |  |
| `channels.flowUndecodable` | number | nullable |  |
| `channels.flowOverwritten` | number | nullable |  |
| `channels.flowEarlier` | number | nullable |  |
| `channels.scheduled` | number | nullable |  |
| `channels.childSlots` | number | nullable |  |
| `channels.childBusy` | number | nullable |  |
| `channels.childQueued` | number | nullable |  |
| `channels.childDeferred` | number | nullable |  |
| `channels.childRefused` | number | nullable |  |
| `channels.childTimedOut` | number | nullable |  |
| `channels.childCrashes` | number | nullable |  |
| `channels.childStartupFailed` | number | nullable |  |
| `channels.childStartup` | number | nullable |  |
| `channels.scriptGroupsEnded` | number | nullable |  |
| `channels.scriptGroupsRefused` | number | nullable |  |
| `channels.scriptGroupsRefusedRecently` | number | nullable |  |
| `channels.scriptGroupsRecycled` | number | nullable |  |
| `channels.resultChannelsDropped` | number | nullable |  |
| `channels.spoolDepth` | number | nullable |  |
| `channels.spoolBytes` | number | nullable |  |
| `channels.spoolDropped` | number | nullable |  |
| `channels.spoolUnwritten` | number | nullable |  |
| `channels.spoolCorrupt` | number | nullable |  |
| `channels.spoolRejected` | number | nullable |  |
| `channels.spoolOversized` | number | nullable |  |
| `channels.resultsDiscarded` | number | nullable |  |
| `channels.spoolStalled` | number | nullable |  |
| `channels.clockJumps` | number | nullable |  |
| `channels.resultsFutureDated` | number | nullable |  |
| `channels.resultsPastDated` | number | nullable |  |
| `channels.clockOffset` | number | nullable |  |
| `channels.sensorsFrozen` | number | nullable |  |
| `channels.cpu` | number | nullable |  |
| `channels.memory` | number | nullable |  |
| `channels.memoryAvailable` | number | nullable |  |
| `channels.memoryAvailableBytes` | number | nullable |  |
| `channels.memoryLimitUsage` | number | nullable |  |
| `channels.memoryLimit` | number | nullable |  |
| `channels.uptime` | number | nullable |  |
| `channels.logDropped` | number | nullable |  |
| `channels.logBacklog` | number | nullable |  |

**503** is [ms:error](#schema-ms-error)

## libraries

### `GET /api/v1/libraries`

The libraries this account may see

Highest priority first, then by name. An administrator sees every library; everybody else sees the ones a group they belong to has been granted.

**200** { items }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `items` | [ms:library](#schema-ms-library)[] | **required** |  |

### `POST /api/v1/libraries`

Create a library

The creator’s primary group is granted full access in the same transaction — access is per group and a new library has no grants, so otherwise the person who made it could not see it. At most 200 nodes, six levels deep, each id used once: a document that does not fit is refused whole, naming the node that is wrong.

**Body** — [ms:libraryInput](#schema-ms-libraryinput)

**201** { id, name, description, priority, nodes, version, createdAt, updatedAt }

**201** is [ms:library](#schema-ms-library)

### `GET /api/v1/libraries/{id}`

One library, with its nodes and their rules

The document, not what it shows: each node’s rule is evaluated when the library is viewed, through the viewer’s own rights. A library this account may not read answers 404 rather than 403, so the error cannot be used to enumerate which ids exist. The `ETag` is the version, to send back as `If-Match`.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, 1–9007199254740991 | **required** |

**200** { id, name, description, priority, nodes, version, createdAt, updatedAt }

**200** is [ms:library](#schema-ms-library)

### `PATCH /api/v1/libraries/{id}`

Change a library

`If-Match` carries the version this edit was made against, and without it the request is refused with 428: two people arranging one library is two people in a designer. One that has moved on is refused with 412 and `LIBRARY_CHANGED`. `nodes`, when sent, replaces every node — there is no merging of one tree into another.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, 1–9007199254740991 | **required** |

**Body**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `name` | string, 1–100 characters |  |  |
| `description` | string, at most 1000 characters |  |  |
| `priority` | integer, 1–5 |  |  |
| `nodes` | [ms:libraryNode](#schema-ms-librarynode)[], at most 200 items |  |  |

**200** { id, name, description, priority, nodes, version, createdAt, updatedAt }

**200** is [ms:library](#schema-ms-library)

### `DELETE /api/v1/libraries/{id}`

Delete a library

Needs full access. The grants on it go with it; no sensor does, because a library holds rules and never sensors.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, 1–9007199254740991 | **required** |

**204**

### `GET /api/v1/libraries/{id}/access`

Which groups may see this library

Needs full access: who else can see a thing is not a read.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, 1–9007199254740991 | **required** |

**200** { items }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `items` | object[] | **required** |  |
| `items[].groupId` | integer | **required** |  |
| `items[].groupName` | string | **required** |  |
| `items[].right` | `none` · `read` · `write` · `full` | **required** |  |
| `items[].grantedAt` | string (date-time) | **required** |  |
| `items[].grantedBy` | string | **required** |  |

### `PUT /api/v1/libraries/{id}/access/{groupId}`

Grant a group access to this library

Needs full access, so a write holder may arrange the nodes without deciding who else sees them. Granting twice replaces rather than failing: it is a correction.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, 1–9007199254740991 | **required** |
| `groupId` | path | integer, 1–9007199254740991 | **required** |

**Body**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `right` | `none` · `read` · `write` · `full` | **required** |  |

**204**

### `DELETE /api/v1/libraries/{id}/access/{groupId}`

Take a group’s access away

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, 1–9007199254740991 | **required** |
| `groupId` | path | integer, 1–9007199254740991 | **required** |

**204**

## lookups

### `GET /api/v1/lookups`

List the lookups this installation has loaded

Every definition available to a channel, plus every one that was refused and why. A refused lookup leaves its channels judged by nothing, so the failures are served beside the successes rather than left in the journal.

**200** { items, problems }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `items` | [ms:lookupSummary](#schema-ms-lookupsummary)[] | **required** |  |
| `problems` | [ms:lookupProblem](#schema-ms-lookupproblem)[] | **required** |  |

### `GET /api/v1/lookups/{id}`

One lookup, with every entry

What each value maps to. `undefinedState` is what a value no entry covers becomes — it has no default, because whether an undocumented status code is fine or a problem depends entirely on the device.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | string, 1–100 characters | **required** |

**200** { id, name, description, type, undefinedState, entries }

**200** is [ms:lookupDetail](#schema-ms-lookupdetail)

## maps

### `GET /api/v1/maps`

The maps this account may see

Highest priority first, then by name. An administrator sees every map; everybody else sees the ones a group they belong to has been granted.

**200** { items }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `items` | object[] | **required** |  |
| `items[].id` | integer | **required** |  |
| `items[].name` | string | **required** |  |
| `items[].description` | string | **required** |  |
| `items[].priority` | integer, 1–5 | **required** |  |
| `items[].layout` | object | **required** |  |
| `items[].version` | integer | **required** |  |
| `items[].createdAt` | string (date-time) | **required** |  |
| `items[].updatedAt` | string (date-time) | **required** |  |

### `POST /api/v1/maps`

Create a map

The creator’s primary group is granted full access in the same transaction — access is per group and a new map has no grants, so otherwise the person who made it could not see it.

**Body**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `name` | string, 1–100 characters | **required** |  |
| `description` | string, at most 1000 characters |  |  |
| `priority` | integer, 1–5 |  |  |
| `layout` | object |  |  |

**201** { id, name, description, priority, layout, version, createdAt, updatedAt }

**201 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `id` | integer | **required** |  |
| `name` | string | **required** |  |
| `description` | string | **required** |  |
| `priority` | integer, 1–5 | **required** |  |
| `layout` | object | **required** |  |
| `version` | integer | **required** |  |
| `createdAt` | string (date-time) | **required** |  |
| `updatedAt` | string (date-time) | **required** |  |

### `GET /api/v1/maps/{id}`

One map, with its canvas

A map this account may not read answers 404 rather than 403, so the error cannot be used to enumerate which ids exist. The `ETag` is the version, to send back as `If-Match`.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, 1–9007199254740991 | **required** |

**200** { id, name, description, priority, layout, version, createdAt, updatedAt }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `id` | integer | **required** |  |
| `name` | string | **required** |  |
| `description` | string | **required** |  |
| `priority` | integer, 1–5 | **required** |  |
| `layout` | object | **required** |  |
| `version` | integer | **required** |  |
| `createdAt` | string (date-time) | **required** |  |
| `updatedAt` | string (date-time) | **required** |  |

### `PATCH /api/v1/maps/{id}`

Change a map

`If-Match` carries the version this edit was made against. Without it the request is refused with 428: a designer is a thing two people open at once, and last-write-wins there means somebody’s afternoon disappears without a message. One that has moved on is refused with 412 and `MAP_CHANGED`, as HTTP answers a failed precondition.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, 1–9007199254740991 | **required** |

**Body**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `name` | string, 1–100 characters |  |  |
| `description` | string, at most 1000 characters |  |  |
| `priority` | integer, 1–5 |  |  |
| `layout` | object |  |  |

**200** { id, name, description, priority, layout, version, createdAt, updatedAt }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `id` | integer | **required** |  |
| `name` | string | **required** |  |
| `description` | string | **required** |  |
| `priority` | integer, 1–5 | **required** |  |
| `layout` | object | **required** |  |
| `version` | integer | **required** |  |
| `createdAt` | string (date-time) | **required** |  |
| `updatedAt` | string (date-time) | **required** |  |

### `DELETE /api/v1/maps/{id}`

Delete a map

Needs full access. The grants on it go with it.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, 1–9007199254740991 | **required** |

**204**

### `GET /api/v1/maps/{id}/view`

One map with its widgets filled in

What a map draws, rather than the document it is stored as. A widget naming an object that has been deleted, or one this account may not see, comes back as `unavailable` and stays on the canvas — a dashboard that quietly stops mentioning what failed is worse than one with a hole in it. **Which of the two it is, is told to nobody**: anybody who may write can make a map, so telling its author would answer "does this id exist?" for any id they chose.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, 1–9007199254740991 | **required** |

**200** { map, widgets, connectors, problems, geo, tiles }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `map` | object | **required** |  |
| `map.id` | integer | **required** |  |
| `map.name` | string | **required** |  |
| `map.description` | string | **required** |  |
| `map.priority` | integer, 1–5 | **required** |  |
| `map.layout` | object | **required** |  |
| `map.version` | integer | **required** |  |
| `map.createdAt` | string (date-time) | **required** |  |
| `map.updatedAt` | string (date-time) | **required** |  |
| `widgets` | object[] | **required** |  |
| `connectors` | object[] | **required** |  |
| `connectors[].id` | string | **required** |  |
| `connectors[].from` | string | **required** |  |
| `connectors[].to` | string | **required** |  |
| `problems` | object[] | **required** |  |
| `problems[].id` | string | **required** |  |
| `problems[].problem` | string | **required** |  |
| `geo` | object | nullable |  |
| `geo.lat` | number | **required** |  |
| `geo.lon` | number | **required** |  |
| `geo.zoom` | integer | **required** |  |
| `geo.publicTiles` | boolean | **required** |  |
| `tiles` | object | nullable |  |
| `tiles.urlTemplate` | string | **required** |  |
| `tiles.attribution` | string | **required** |  |

### `GET /api/v1/maps/{id}/shares`

The public share links on this map

Needs full access: a share link is a grant to everybody, and `full` is the right that decides a map’s audience. The tokens themselves are not here and cannot be — only their hashes are stored, so a URL is shown once when it is made.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, 1–9007199254740991 | **required** |

**200** { items }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `items` | object[] | **required** |  |
| `items[].id` | integer | **required** |  |
| `items[].label` | string | **required** |  |
| `items[].prefix` | string | **required** |  |
| `items[].expiresAt` | string (date-time) | **required** |  |
| `items[].lastUsedAt` | string (date-time) | **required** nullable |  |
| `items[].revokedAt` | string (date-time) | **required** nullable |  |
| `items[].createdAt` | string (date-time) | **required** |  |
| `items[].createdBy` | string | **required** |  |

### `POST /api/v1/maps/{id}/shares`

Make a public share link

Answers with the URL’s token **once**. Only its hash is stored, so it cannot be shown again — which is what keeps a database backup from being a set of working share links. An expiry is required (`ADR-002`): a link without one is a permanent unauthenticated route nobody remembers creating.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, 1–9007199254740991 | **required** |

**Body**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `label` | string, 1–100 characters | **required** |  |
| `expiresAt` | string (date-time) | **required** |  |

**201** { share, token }

**201 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `share` | object | **required** |  |
| `share.id` | integer | **required** |  |
| `share.label` | string | **required** |  |
| `share.prefix` | string | **required** |  |
| `share.expiresAt` | string (date-time) | **required** |  |
| `share.lastUsedAt` | string (date-time) | **required** nullable |  |
| `share.revokedAt` | string (date-time) | **required** nullable |  |
| `share.createdAt` | string (date-time) | **required** |  |
| `share.createdBy` | string | **required** |  |
| `token` | string | **required** |  |

### `DELETE /api/v1/maps/{id}/shares/{shareId}`

Revoke a share link

The link stops working immediately. The row stays, revoked, so the record of what existed outlives the decision to stop it.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, 1–9007199254740991 | **required** |
| `shareId` | path | integer, 1–9007199254740991 | **required** |

**204**

### `GET /api/v1/maps/{id}/background`

The background image behind a map

The stored bytes, with the SHA-256 of them as a strong ETag. Send `If-None-Match` and a wall display re-opens without downloading the floor plan again.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, 1–9007199254740991 | **required** |

**200**

### `POST /api/v1/maps/{id}/background`

Put a background image behind a map

PNG, JPEG or WebP, at most 2 MiB and 4096 pixels on a side. The format is decided by reading the file’s own header — the declared content type is a claim by the client and is never trusted. SVG is refused: it is a document rather than an image, and a background is drawn in the application’s own page (`ADR-003`). Needs `write`, the same right as moving a widget. The body is the file itself, not JSON.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, 1–9007199254740991 | **required** |

**200** { mediaType, digest, width, height, bytes, uploadedAt, uploadedBy }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `mediaType` | `image/png` · `image/jpeg` · `image/webp` | **required** |  |
| `digest` | string | **required** |  |
| `width` | integer | **required** |  |
| `height` | integer | **required** |  |
| `bytes` | integer | **required** |  |
| `uploadedAt` | string (date-time) | **required** |  |
| `uploadedBy` | string | **required** |  |

### `DELETE /api/v1/maps/{id}/background`

Take the background off a map

Silent when there was none: the map ends up without one either way.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, 1–9007199254740991 | **required** |

**204**

### `GET /api/v1/maps/{id}/access`

Which groups may see this map

Needs full access: who else can see a thing is not a read.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, 1–9007199254740991 | **required** |

**200** { items }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `items` | object[] | **required** |  |
| `items[].groupId` | integer | **required** |  |
| `items[].groupName` | string | **required** |  |
| `items[].right` | `none` · `read` · `write` · `full` | **required** |  |
| `items[].grantedAt` | string (date-time) | **required** |  |
| `items[].grantedBy` | string | **required** |  |

### `PUT /api/v1/maps/{id}/access/{groupId}`

Grant a group access to this map

Needs full access, so a write holder may edit the canvas without deciding who else sees it. Granting twice replaces rather than failing: it is a correction.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, 1–9007199254740991 | **required** |
| `groupId` | path | integer, 1–9007199254740991 | **required** |

**Body**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `right` | `none` · `read` · `write` · `full` | **required** |  |

**204**

### `DELETE /api/v1/maps/{id}/access/{groupId}`

Take a group’s access away

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, 1–9007199254740991 | **required** |
| `groupId` | path | integer, 1–9007199254740991 | **required** |

**204**

### `GET /api/v1/public/maps/{token}`

A shared map, with no session at all

The map a share token opens, with every widget resolved. Expired, revoked and never-existed tokens all answer 404 in the same words: telling them apart would say which guesses were once real links. Rate limited per address and per token.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `token` | path | string | **required** |

**200** { name, description, widgets, connectors, problems, hasBackground, geo, tiles }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `name` | string | **required** |  |
| `description` | string |  |  |
| `widgets` | object[] | **required** |  |
| `connectors` | object[] | **required** |  |
| `connectors[].id` | string | **required** |  |
| `connectors[].from` | string | **required** |  |
| `connectors[].to` | string | **required** |  |
| `problems` | object[] | **required** |  |
| `problems[].id` | string | **required** |  |
| `problems[].problem` | string | **required** |  |
| `hasBackground` | boolean | **required** |  |
| `geo` | object | nullable |  |
| `geo.lat` | number | **required** |  |
| `geo.lon` | number | **required** |  |
| `geo.zoom` | integer | **required** |  |
| `geo.publicTiles` | boolean | **required** |  |
| `tiles` | object | nullable |  |
| `tiles.urlTemplate` | string | **required** |  |
| `tiles.attribution` | string | **required** |  |

### `GET /api/v1/public/maps/{token}/background`

The background image behind a shared map

The same bytes and the same ETag as the authenticated route serves.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `token` | path | string | **required** |

**200**

## meta

### `GET /metrics`

Prometheus scrape endpoint — text format, not JSON

Outside `/api/v1` because that is the path every scraper config already assumes, and guarded here explicitly because of it: the scrape body is a map of the installation, and a route outside that prefix would otherwise be public. A scraper authenticates with an API token, which is what `authorization` in a Prometheus `scrape_config` is for. 503 while the core is still starting, because an empty body would be recorded as every series vanishing at once.

**200**

### `GET /api/v1/openapi.json`

This API, as an OpenAPI 3 document

**200** object

### `GET /api/v1/build`

Which build is serving: its version, the commit it was packaged from, and what it contains

**200** { version, commit, dirty, profile, lock, subsystems }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `version` | string | **required** |  |
| `commit` | string | **required** nullable | The full commit this build was packaged from; null when that is not known — a working tree, or a package made before this route existed. |
| `dirty` | boolean | **required** | Packaged with uncommitted changes on top of `commit`, so the commit names the nearest code rather than this code. |
| `profile` | `v1` · `full` | **required** | What the build was packaged to contain: `v1` is the release candidate, without the v2 subsystems; `full` is everything. |
| `lock` | string | **required** nullable | `sha256:<hex>` of the lock its dependencies were installed from, which ships beside them as `app/package-lock.json`; null for a working tree. |
| `subsystems` | object | **required** | Which optional subsystems this server constructed. One that is false has no routes here at all, and a client should not offer it. |
| `subsystems.maps` | boolean | **required** |  |
| `subsystems.reports` | boolean | **required** |  |
| `subsystems.libraries` | boolean | **required** |  |

## notifications

### `GET /api/v1/notification-health`

Whether notifications are actually being delivered

Read from the queue rather than counted in memory, deliberately: a core that restarted five minutes ago would otherwise report a clean sheet over a queue full of undelivered alarms. `down` means an alarm was given up on, or one has been undeliverable long enough that the relay is not coming back on its own; `warning` means something is being retried.

**200** { status, problems, pending, parked, retrying, failed, discarded, oldestPendingAt, oldestPendingAgeMs, lastDeliveredAt, windowMs, staleAfterMs, methods }

**200** is [ms:deliveryHealth](#schema-ms-deliveryhealth)

### `GET /api/v1/notification-requests`

What happened to each notification

Newest first, paged by `before` rather than by offset — notifications arrive while somebody is reading, and an offset page would show a row twice or not at all. `failed` is an alarm nobody received; `discarded` is one nobody was meant to receive any more, which is not the same thing. That is either a notification an activation schedule threw away on purpose (`N-12`), or a recovery or clear dropped because a newer alarm of the same sensor and trigger was delivered first (`N-22`); `lastError` says which. Only notifications about sensors the caller can read appear.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `status` | query | `pending` · `sent` · `failed` · `discarded`, or an array of them, at most 4 items |  |
| `sensorId` | query | integer, at least 1 |  |
| `templateId` | query | integer, at least 1 |  |
| `before` | query | integer, at least 1 |  |
| `limit` | query | integer, 1–200 | default `50` |

**200** { items, nextBefore }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `items` | [ms:notificationRequest](#schema-ms-notificationrequest)[] | **required** |  |
| `nextBefore` | integer | **required** nullable |  |

## objects

### `GET /api/v1/objects`

Flat filtered listing, keyset-paginated. `q` searches names and device hosts as a case-insensitive substring; `host` is an exact match on a device host. `include=path` gives each item its ancestors, so a flat search result can say where each match is. Note: under sort=name an object renamed mid-pagination can be returned twice or missed — inherent to keyset paging and acceptable for a UI. Anything that must be exact (bulk selection, config export) must use sort=id, which is immutable.

| Parameter | In | Type | | Description |
| --- | --- | --- | --- | --- |
| `parentId` | query | integer, at least 1 |  |  |
| `kind` | query | `root` · `probe` · `group` · `device` · `sensor`, or an array of them, at most 5 items |  |  |
| `tag` | query | string or string[], 1–100 characters, at most 50 items, each 1–100 characters |  |  |
| `q` | query | string, at most 500 characters |  | Search: a case-insensitive substring of the name or, on a device, of its host. `%` and `_` are literal. |
| `host` | query | string, at most 255 characters |  | A device's host exactly, case-insensitive. A substring is `q`'s job. |
| `priorityMin` | query | integer, 1–5 |  |  |
| `sort` | query | `name` · `id` · `manual` | default `name` |  |
| `effective` | query | string or string[], 1–100 characters, at most 7 items, each 1–100 characters |  |  |
| `include` | query | string, at most 200 characters |  | Comma-separated expansions. `path` gives every item its ancestors, root first and excluding the item — what `/objects/{id}/ancestors` returns, for the whole page in one walk. |
| `cursor` | query | string, at most 2048 characters |  |  |
| `limit` | query | integer, 1–500 | default `100` |  |

**200** { items, nextCursor }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `items` | [ms:objectSummary](#schema-ms-objectsummary)[] | **required** |  |
| `nextCursor` | string | **required** nullable |  |

### `POST /api/v1/objects`

**Body** — [ms:createObject](#schema-ms-createobject)

**201** { id, kind, parentId, name, tags, priority, comments, inheritsTriggers, version, childCount, createdAt, updatedAt, host, ipVersion, targetPolicyException, gid, sensorType, params, redactedParams, settings, channels, credentials, ancestors }

**201** is [ms:objectDetail](#schema-ms-objectdetail)

### `GET /api/v1/objects/root`

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `include` | query | string, at most 200 characters |  |

**200** { id, kind, parentId, name, tags, priority, comments, inheritsTriggers, version, childCount, createdAt, updatedAt, host, ipVersion, targetPolicyException, gid, sensorType, params, redactedParams, settings, channels, credentials, ancestors }

**200** is [ms:objectDetail](#schema-ms-objectdetail)

### `GET /api/v1/objects/tops`

Where the caller’s tree starts

The objects the caller can read whose parent it cannot. For an account that can read the root, that is the root. For one granted a few branches, it is the top of each: the containers above a granted branch are outside it, so their names are never shown and the tree starts at the branches instead — and a grant re-opened inside a hole the caller cannot see is a top of its own, because no expansion reaches it. Ordered by name.

**200** { items }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `items` | [ms:objectSummary](#schema-ms-objectsummary)[] | **required** |  |

### `POST /api/v1/objects/tree`

Create a whole subtree in one request

Creates many objects at once, under one `parentId`, with nodes naming their parent by `ref` where that parent is also being created here. **One transaction**: the whole subtree appears or none of it does, which is what a discovery run needs — a half-provisioned device is worse than a failed one, because nothing says which half. Every object goes through the same validation, the same hierarchy rules, the same channel declaration and the same audit log as `POST /objects`; what is not paid is a request, a transaction and a tree lock **per object**. Refusals name the node by its index and its `ref`, because a caller sending five thousand cannot act on "invalid request". The answer is ids in the order the nodes were sent, not full objects: five thousand of those is megabytes of response describing what the caller already wrote, and the one thing they could not know is the ids.

**Body** — [ms:createTree](#schema-ms-createtree)

**201** { count, objects }

**201** is [ms:createTreeResult](#schema-ms-createtreeresult)

### `GET /api/v1/objects/{id}`

One object. Send the `ETag` back as `If-None-Match` for a 304 when nothing in the answer has changed: the tag covers what it inherits with `?include=`, and, for an account that does not see everything, what its grants decide, so a grant that changes the answer changes the tag. The answer is `Cache-Control: private`.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `include` | query | string, at most 200 characters |  |
| `id` | path | integer, 1–9007199254740991 | **required** |

**200** { id, kind, parentId, name, tags, priority, comments, inheritsTriggers, version, childCount, createdAt, updatedAt, host, ipVersion, targetPolicyException, gid, sensorType, params, redactedParams, settings, channels, credentials, ancestors }

**200** is [ms:objectDetail](#schema-ms-objectdetail)

### `PATCH /api/v1/objects/{id}`

Changes what it is given and keeps the rest. **Where a sensor sends its inherited credentials** — a device's host or address family, or a sensor parameter its type says chooses the listener — **needs `write` on the object those credentials are stored on** (`A-41`), and is otherwise refused with 403 naming the kind and that object, never the secret. A device's new host also clears the secrets held in its sensors' own parameters, which the audit lists; enter them again.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, 1–9007199254740991 | **required** |

**Body** — [ms:updateObject](#schema-ms-updateobject)

**200** { id, kind, parentId, name, tags, priority, comments, inheritsTriggers, version, childCount, createdAt, updatedAt, host, ipVersion, targetPolicyException, gid, sensorType, params, redactedParams, settings, channels, credentials, ancestors }

**200** is [ms:objectDetail](#schema-ms-objectdetail)

### `DELETE /api/v1/objects/{id}`

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `expectedDescendants` | query | integer, at least 0 |  |
| `id` | path | integer, 1–9007199254740991 | **required** |

**200** { id, kind, name, deleted }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `id` | integer | **required** |  |
| `kind` | `probe` · `group` · `device` · `sensor` | **required** |  |
| `name` | string | **required** |  |
| `deleted` | object | **required** |  |

### `POST /api/v1/objects/{id}/order`

Moves an object within its parent's children, the way PRTG's move up / move down does. Siblings nobody has arranged keep sorting by name, so a tree that has never been ordered by hand reads exactly as it did before. Listings honour the arrangement through `GET /objects?parentId=…&sort=manual` and through the tree endpoint, which always does. A move that changes nothing is a no-op, not an error. **Among the siblings the caller can see** (`A-46`): every other sibling keeps its place, "up" passes the nearest one the caller can see, and the top it can see is the top.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, 1–9007199254740991 | **required** |

**Body**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `move` | `up` · `down` · `first` · `last` | **required** |  |

**200** { id, kind, parentId, name, tags, priority, comments, inheritsTriggers, version, childCount, createdAt, updatedAt, host, ipVersion, targetPolicyException, gid, sensorType, params, redactedParams, settings, channels, credentials, ancestors }

**200** is [ms:objectDetail](#schema-ms-objectdetail)

### `POST /api/v1/objects/{id}/move`

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, 1–9007199254740991 | **required** |

**Body**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `targetParentId` | integer, at least 1 | **required** |  |

**200** { object, fromParentId, toParentId, movedCount, probeChanged, settingsChanged, credentialsChanged, exceptionsCleared }

**200** is [ms:moveResult](#schema-ms-moveresult)

### `POST /api/v1/objects/{id}/clone`

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, 1–9007199254740991 | **required** |

**Body**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `targetParentId` | integer, at least 1 |  |  |
| `name` | string, 1–500 characters |  |  |

**201** { object, grantsNotCarried, clonedCount, droppedCredentialKinds, settingsChanged }

**201** is [ms:cloneResult](#schema-ms-cloneresult)

### `POST /api/v1/objects/bulk`

Applies one operation to a selection. **Each object is atomic and the batch is best-effort**: the report names every object that did not change and why, rather than failing the request. An operator who selects forty sensors and pauses them, one of which a colleague deleted a moment ago, wants thirty-nine paused and a line naming the fortieth — all-or-nothing would give them neither. The selection is explicit ids, never a filter. A client enumerating a selection with `GET /objects` **must** page with `sort=id`: under `sort=name` a keyset scan can return a renamed object twice or skip it, so a bulk delete would miss objects the operator chose. At most 500 objects, because each one takes the tree lock in turn and a larger selection is a filter rather than a selection. Repeated ids are collapsed and counted, never applied twice.

**Body**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `ids` | integer[], 1–500 items, each at least 1 | **required** |  |
| `operation` | `pause` · `resume` · `move` · `clone` · `delete` · `setting` · `revertSetting` | **required** |  |
| `targetParentId` | integer, at least 1 |  | Required by `move` and `clone`. |
| `cascade` | boolean | default `false` | `delete` only. False refuses an object that has children, which is the safe default: a selection of six groups is six subtrees and nobody counted them. |
| `key` | string |  | Required by `setting` and `revertSetting`. |
| `value` | any |  | `setting` only. To go back to the inherited value use `revertSetting` — the same split the single-object routes make between `PUT` and `DELETE`, and not a null here, which is a legitimate stored value for a setting whose schema allows one. |
| `minutes` | integer, at least 1 |  | `pause` only. |
| `until` | string (date-time) |  | `pause` only. |
| `from` | string (date-time) |  | `pause` only. |
| `message` | string, at most 500 characters |  | `pause` only. |

**200** { requested, succeeded, failed, duplicates, outcomes }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `requested` | integer | **required** |  |
| `succeeded` | integer | **required** |  |
| `failed` | integer | **required** |  |
| `duplicates` | integer | **required** |  |
| `outcomes` | object[] | **required** |  |
| `outcomes[].objectId` | integer | **required** |  |
| `outcomes[].ok` | boolean | **required** |  |
| `outcomes[].problem` | string |  |  |
| `outcomes[].code` | string |  |  |
| `outcomes[].createdId` | integer |  |  |
| `outcomes[].grantsNotCarried` | integer |  | `clone` only: the positive grants the copy did not carry, as the single clone’s answer counts them (`A-76`). |
| `outcomes[].deleted` | integer |  |  |

### `GET /api/v1/objects/{id}/tree`

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `maxDepth` | query | integer, 1–20 | default `3` |
| `limit` | query | integer, 1–5000 | default `1000` |
| `kind` | query | `root` · `probe` · `group` · `device` · `sensor`, or an array of them, at most 5 items |  |
| `effective` | query | string or string[], 1–100 characters, at most 7 items, each 1–100 characters |  |
| `id` | path | integer, 1–9007199254740991 | **required** |

**200** { items, truncated }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `items` | [ms:objectSummary](#schema-ms-objectsummary)[] | **required** |  |
| `truncated` | boolean | **required** |  |

### `GET /api/v1/objects/{id}/counts`

Exact totals for a subtree

How many objects of each kind are under this one, and what state its sensors are in. Unlike `/tree` there is no depth and no limit: the counting happens in the database and only the totals cross the wire. Use this wherever a page shows a **number** rather than rows. Counting a page of `/tree` gives the right answer for a small installation and a quietly wrong one for a large installation, which is the worst way for a number to be wrong.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, 1–9007199254740991 | **required** |

**200** { objects, sensorStates }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `objects` | object | **required** |  |
| `objects.probe` | integer | **required** |  |
| `objects.group` | integer | **required** |  |
| `objects.device` | integer | **required** |  |
| `objects.sensor` | integer | **required** |  |
| `objects.total` | integer | **required** | Every object in the subtree, the one asked about included — so for the root it is one more than the four kinds sum to. |
| `sensorStates` | object | **required** |  |
| `sensorStates.unknown` | integer | **required** |  |
| `sensorStates.up` | integer | **required** |  |
| `sensorStates.warning` | integer | **required** |  |
| `sensorStates.down` | integer | **required** |  |
| `sensorStates.down_acknowledged` | integer | **required** |  |
| `sensorStates.down_partial` | integer | **required** |  |
| `sensorStates.unusual` | integer | **required** |  |
| `sensorStates.paused` | integer | **required** |  |

### `GET /api/v1/objects/counts`

Exact totals for everything the caller can see

The same totals as `/objects/:id/counts`, over every object the caller can read rather than under one. For an account that can read the root it is the root’s counts; for one granted a few branches it is theirs, with nothing outside them counted — which the root’s own counts, refused to that account, could not give.

**200** { objects, sensorStates }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `objects` | object | **required** |  |
| `objects.probe` | integer | **required** |  |
| `objects.group` | integer | **required** |  |
| `objects.device` | integer | **required** |  |
| `objects.sensor` | integer | **required** |  |
| `objects.total` | integer | **required** | Every object in the subtree, the one asked about included — so for the root it is one more than the four kinds sum to. |
| `sensorStates` | object | **required** |  |
| `sensorStates.unknown` | integer | **required** |  |
| `sensorStates.up` | integer | **required** |  |
| `sensorStates.warning` | integer | **required** |  |
| `sensorStates.down` | integer | **required** |  |
| `sensorStates.down_acknowledged` | integer | **required** |  |
| `sensorStates.down_partial` | integer | **required** |  |
| `sensorStates.unusual` | integer | **required** |  |
| `sensorStates.paused` | integer | **required** |  |

### `GET /api/v1/objects/{id}/ancestors`

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, 1–9007199254740991 | **required** |

**200** { items }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `items` | [ms:objectRef](#schema-ms-objectref)[] | **required** |  |

### `PUT /api/v1/objects/{id}/target-policy-exception`

Set or clear the addresses one device may reach although its probe’s policy refuses them

The addresses of this device its probe may connect to although `probe.targetPolicy` refuses them (`A-64`), replacing any it had; an empty list clears it. **Only an administrator**, with a `full` token, may change it; anyone who may read the device sees it, as `targetPolicyException` on the device. **A device only, and never inherited**: a group, a probe or the root is refused with 409, and a device has none until one is set here: a clone or a template starts without one. **Addresses, one at a time**: not a name, a range or a zone, not multicast or the unspecified address, and never a cloud instance-metadata service (`169.254.169.254`, `169.254.170.2`, `fd00:ec2::254`), each refused with 400. A sensor on the device whose host is a name connects only when every address the name resolves to is allowed by the policy or named here. Takes `If-Match`. Audited as an update of the device. Reaches a probe at protocol 28 or later; an older probe refuses those addresses as before.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, 1–9007199254740991 | **required** |

**Body**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `addresses` | string[], at most 16 items, each 1–64 characters | **required** |  |

**200** { id, kind, parentId, name, tags, priority, comments, inheritsTriggers, version, childCount, createdAt, updatedAt, host, ipVersion, targetPolicyException, gid, sensorType, params, redactedParams, settings, channels, credentials, ancestors }

**200** is [ms:objectDetail](#schema-ms-objectdetail)

## probes

### `GET /api/v1/probes`

Every probe this core knows, and what was decided about it

Includes the ones waiting for approval, which is the list worth opening: a probe in `pending` is connected and doing nothing, on purpose. `lastAddress` is beside each one because "a probe called backup-01 wants in" is not a decision anybody can make and "from 10.4.2.9" is. `protocolVersion` is what the probe declared at its last handshake that was accepted or was refused over the version itself, and `protocolAcceptedAt` is when an accepted one spoke it: `null` when that handshake was refused, and for a version recorded before the core kept the time. `protocolRefusedAt` is when a hello was last refused over it, the other way round, so a refusal at 0 is not read as nothing recorded. `lastSeenAt` is the last hello that proved it is this probe (its key accepted, not revoked, from an address its filter allows), accepted or refused over its version, so it is not when the version was spoken. `displayName`, `agentVersion` and `lastAddress` are from that hello too: a hello refused before proving its identity changes nothing here, and is in the core log and Core Health `probeHellosUnproven` instead. `skew.kind` is `unknown`, `current`, `outdated`, `ahead` (a probe newer than this core, which is admitted and speaks this core’s version) or `incompatible` (one this core refuses at the handshake).

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `status` | query | `pending` · `approved` · `revoked` |  |

**200** { items }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `items` | object[] | **required** |  |
| `items[].gid` | string | **required** |  |
| `items[].status` | `pending` · `approved` · `revoked` | **required** |  |
| `items[].displayName` | string | **required** |  |
| `items[].agentVersion` | string |  |  |
| `items[].protocolVersion` | integer |  |  |
| `items[].protocolAcceptedAt` | string (date-time) | **required** nullable | When a handshake this core accepted spoke `protocolVersion` (U-33). `null` beside a version a hello was refused over, and for one recorded before the core kept the time. Not `lastSeenAt`, which a hello refused over its version moves too. |
| `items[].protocolRefusedAt` | string (date-time) | **required** nullable | When a hello was last refused over `protocolVersion` (U-35). `null` beside a version a handshake this core accepted, and for one recorded before the core kept the time. Never set beside `protocolAcceptedAt`. A `protocolVersion` of 0 with this set is a probe that claimed 0 and was refused; with neither time it is a probe that has not connected since the core started recording versions. |
| `items[].lastAddress` | string |  |  |
| `items[].allowFrom` | string[] |  |  |
| `items[].hasOwnKey` | boolean |  | Whether a key has been issued to this probe. Never the key — it is sent once, in the welcome that approves it, and no route can read it back. |
| `items[].objectId` | integer | nullable |  |
| `items[].note` | string |  |  |
| `items[].firstSeenAt` | string | **required** |  |
| `items[].lastSeenAt` | string | nullable |  |
| `items[].decidedAt` | string | nullable |  |
| `items[].skew` | object |  | What this probe’s protocol version means against this core (R-06). `outdated` is the one worth reading: such a probe connects and heartbeats normally and is refused every feature listed in `missing`, so a probe below protocol 3 looks healthy while scanning nothing at all. `ahead` is a probe newer than this core (P-178): it is admitted and the pair speaks `ownVersion`, so the end to upgrade is this one. `incompatible` is a version this core refuses at the handshake; its `explanation` says whether the last hello was refused over it (`protocolRefusedAt`) or a core with a lower floor accepted it and this one will refuse it at the next (U-35). `unknown` is a 0 with neither time: nothing recorded. |
| `items[].skew.kind` | `unknown` · `current` · `outdated` · `ahead` · `incompatible` | **required** |  |
| `items[].skew.peerVersion` | integer |  |  |
| `items[].skew.ownVersion` | integer |  |  |
| `items[].skew.missing` | string[] |  | Only on `outdated`: what this probe cannot be asked to do, oldest first, each a phrase for a person that completes "it cannot …". Free text: compare `peerVersion` with `ownVersion` rather than matching on it. |
| `items[].skew.reason` | string |  | Only on `incompatible`: a sentence for a person, naming both versions. Free text: switch on `kind`. |
| `items[].skew.explanation` | string | **required** |  |

### `POST /api/v1/probes/{gid}/approve`

Approve a probe onto a branch of the tree

Binds this identity to a probe object. The probe is issued a key of its own at its **next handshake**, not here: approving a machine that is switched off is an ordinary thing to do, and a key delivered in a welcome it never received would lock it out. Nobody ever sees that key — it goes straight to the probe over the authenticated link, so it never passes through a clipboard or a support ticket. A probe that is already connected has its connection closed and comes back on its own retry — about a second — because the handshake is where both the key and the first configuration are issued. It said "starts scanning without reconnecting" until `P-189`, which was not implemented: the session’s approval is fixed at admission, so a probe approved after it connected sat there scanning nothing.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `gid` | path | string, 1–128 characters | **required** |

**Body**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `objectId` | integer, at least 1 | **required** | The probe object this identity owns from now on. |
| `local` | boolean | default `false` | Whether this is the probe running beside the core. A local probe cannot be deleted, matching PRTG. Said explicitly rather than guessed: an address proves nothing on a host with several interfaces, and "the first one approved" is wrong for anybody who stood up a remote probe first. |

**200** { gid, status, displayName, agentVersion, protocolVersion, protocolAcceptedAt, protocolRefusedAt, lastAddress, allowFrom, hasOwnKey, objectId, note, firstSeenAt, lastSeenAt, decidedAt, skew }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `gid` | string | **required** |  |
| `status` | `pending` · `approved` · `revoked` | **required** |  |
| `displayName` | string | **required** |  |
| `agentVersion` | string |  |  |
| `protocolVersion` | integer |  |  |
| `protocolAcceptedAt` | string (date-time) | **required** nullable | When a handshake this core accepted spoke `protocolVersion` (U-33). `null` beside a version a hello was refused over, and for one recorded before the core kept the time. Not `lastSeenAt`, which a hello refused over its version moves too. |
| `protocolRefusedAt` | string (date-time) | **required** nullable | When a hello was last refused over `protocolVersion` (U-35). `null` beside a version a handshake this core accepted, and for one recorded before the core kept the time. Never set beside `protocolAcceptedAt`. A `protocolVersion` of 0 with this set is a probe that claimed 0 and was refused; with neither time it is a probe that has not connected since the core started recording versions. |
| `lastAddress` | string |  |  |
| `allowFrom` | string[] |  |  |
| `hasOwnKey` | boolean |  | Whether a key has been issued to this probe. Never the key — it is sent once, in the welcome that approves it, and no route can read it back. |
| `objectId` | integer | nullable |  |
| `note` | string |  |  |
| `firstSeenAt` | string | **required** |  |
| `lastSeenAt` | string | nullable |  |
| `decidedAt` | string | nullable |  |
| `skew` | object |  | What this probe’s protocol version means against this core (R-06). `outdated` is the one worth reading: such a probe connects and heartbeats normally and is refused every feature listed in `missing`, so a probe below protocol 3 looks healthy while scanning nothing at all. `ahead` is a probe newer than this core (P-178): it is admitted and the pair speaks `ownVersion`, so the end to upgrade is this one. `incompatible` is a version this core refuses at the handshake; its `explanation` says whether the last hello was refused over it (`protocolRefusedAt`) or a core with a lower floor accepted it and this one will refuse it at the next (U-35). `unknown` is a 0 with neither time: nothing recorded. |
| `skew.kind` | `unknown` · `current` · `outdated` · `ahead` · `incompatible` | **required** |  |
| `skew.peerVersion` | integer |  |  |
| `skew.ownVersion` | integer |  |  |
| `skew.missing` | string[] |  | Only on `outdated`: what this probe cannot be asked to do, oldest first, each a phrase for a person that completes "it cannot …". Free text: compare `peerVersion` with `ownVersion` rather than matching on it. |
| `skew.reason` | string |  | Only on `incompatible`: a sentence for a person, naming both versions. Free text: switch on `kind`. |
| `skew.explanation` | string | **required** |  |

### `POST /api/v1/probes/{gid}/revoke`

Refuse a probe from now on

The record is kept rather than deleted, so the same identity cannot come back by simply reconnecting and so the log of what was refused survives the decision. The branch is released, because the sensors under it — and their history and their thresholds — should outlive the machine that was scanning them.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `gid` | path | string, 1–128 characters | **required** |

**Body**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `note` | string, at most 1000 characters | default `` | Why, for the operator who finds this months later. |

**200** { gid, status, displayName, agentVersion, protocolVersion, protocolAcceptedAt, protocolRefusedAt, lastAddress, allowFrom, hasOwnKey, objectId, note, firstSeenAt, lastSeenAt, decidedAt, skew }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `gid` | string | **required** |  |
| `status` | `pending` · `approved` · `revoked` | **required** |  |
| `displayName` | string | **required** |  |
| `agentVersion` | string |  |  |
| `protocolVersion` | integer |  |  |
| `protocolAcceptedAt` | string (date-time) | **required** nullable | When a handshake this core accepted spoke `protocolVersion` (U-33). `null` beside a version a hello was refused over, and for one recorded before the core kept the time. Not `lastSeenAt`, which a hello refused over its version moves too. |
| `protocolRefusedAt` | string (date-time) | **required** nullable | When a hello was last refused over `protocolVersion` (U-35). `null` beside a version a handshake this core accepted, and for one recorded before the core kept the time. Never set beside `protocolAcceptedAt`. A `protocolVersion` of 0 with this set is a probe that claimed 0 and was refused; with neither time it is a probe that has not connected since the core started recording versions. |
| `lastAddress` | string |  |  |
| `allowFrom` | string[] |  |  |
| `hasOwnKey` | boolean |  | Whether a key has been issued to this probe. Never the key — it is sent once, in the welcome that approves it, and no route can read it back. |
| `objectId` | integer | nullable |  |
| `note` | string |  |  |
| `firstSeenAt` | string | **required** |  |
| `lastSeenAt` | string | nullable |  |
| `decidedAt` | string | nullable |  |
| `skew` | object |  | What this probe’s protocol version means against this core (R-06). `outdated` is the one worth reading: such a probe connects and heartbeats normally and is refused every feature listed in `missing`, so a probe below protocol 3 looks healthy while scanning nothing at all. `ahead` is a probe newer than this core (P-178): it is admitted and the pair speaks `ownVersion`, so the end to upgrade is this one. `incompatible` is a version this core refuses at the handshake; its `explanation` says whether the last hello was refused over it (`protocolRefusedAt`) or a core with a lower floor accepted it and this one will refuse it at the next (U-35). `unknown` is a 0 with neither time: nothing recorded. |
| `skew.kind` | `unknown` · `current` · `outdated` · `ahead` · `incompatible` | **required** |  |
| `skew.peerVersion` | integer |  |  |
| `skew.ownVersion` | integer |  |  |
| `skew.missing` | string[] |  | Only on `outdated`: what this probe cannot be asked to do, oldest first, each a phrase for a person that completes "it cannot …". Free text: compare `peerVersion` with `ownVersion` rather than matching on it. |
| `skew.reason` | string |  | Only on `incompatible`: a sentence for a person, naming both versions. Free text: switch on `kind`. |
| `skew.explanation` | string | **required** |  |

### `PUT /api/v1/probes/{gid}/allow-from`

Narrow where one probe may connect from

Ranges in the same spellings a discovery takes — `10.0.0.0/24`, `10.0.0.1-50`, a single address — with no size cap, because stating that your probes live in `10.0.0.0/8` is a fact about a network rather than a request to enumerate it. An empty list means anywhere, which is the default: a stolen key is worth much less when it only works from one subnet, and only the operator can say which one.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `gid` | path | string, 1–128 characters | **required** |

**Body**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `allowFrom` | string[], at most 64 items, each at most 200 characters | **required** |  |

**200** { gid, status, displayName, agentVersion, protocolVersion, protocolAcceptedAt, protocolRefusedAt, lastAddress, allowFrom, hasOwnKey, objectId, note, firstSeenAt, lastSeenAt, decidedAt, skew }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `gid` | string | **required** |  |
| `status` | `pending` · `approved` · `revoked` | **required** |  |
| `displayName` | string | **required** |  |
| `agentVersion` | string |  |  |
| `protocolVersion` | integer |  |  |
| `protocolAcceptedAt` | string (date-time) | **required** nullable | When a handshake this core accepted spoke `protocolVersion` (U-33). `null` beside a version a hello was refused over, and for one recorded before the core kept the time. Not `lastSeenAt`, which a hello refused over its version moves too. |
| `protocolRefusedAt` | string (date-time) | **required** nullable | When a hello was last refused over `protocolVersion` (U-35). `null` beside a version a handshake this core accepted, and for one recorded before the core kept the time. Never set beside `protocolAcceptedAt`. A `protocolVersion` of 0 with this set is a probe that claimed 0 and was refused; with neither time it is a probe that has not connected since the core started recording versions. |
| `lastAddress` | string |  |  |
| `allowFrom` | string[] |  |  |
| `hasOwnKey` | boolean |  | Whether a key has been issued to this probe. Never the key — it is sent once, in the welcome that approves it, and no route can read it back. |
| `objectId` | integer | nullable |  |
| `note` | string |  |  |
| `firstSeenAt` | string | **required** |  |
| `lastSeenAt` | string | nullable |  |
| `decidedAt` | string | nullable |  |
| `skew` | object |  | What this probe’s protocol version means against this core (R-06). `outdated` is the one worth reading: such a probe connects and heartbeats normally and is refused every feature listed in `missing`, so a probe below protocol 3 looks healthy while scanning nothing at all. `ahead` is a probe newer than this core (P-178): it is admitted and the pair speaks `ownVersion`, so the end to upgrade is this one. `incompatible` is a version this core refuses at the handshake; its `explanation` says whether the last hello was refused over it (`protocolRefusedAt`) or a core with a lower floor accepted it and this one will refuse it at the next (U-35). `unknown` is a 0 with neither time: nothing recorded. |
| `skew.kind` | `unknown` · `current` · `outdated` · `ahead` · `incompatible` | **required** |  |
| `skew.peerVersion` | integer |  |  |
| `skew.ownVersion` | integer |  |  |
| `skew.missing` | string[] |  | Only on `outdated`: what this probe cannot be asked to do, oldest first, each a phrase for a person that completes "it cannot …". Free text: compare `peerVersion` with `ownVersion` rather than matching on it. |
| `skew.reason` | string |  | Only on `incompatible`: a sentence for a person, naming both versions. Free text: switch on `kind`. |
| `skew.explanation` | string | **required** |  |

### `DELETE /api/v1/probes/{gid}`

Forget a probe entirely

Different from revoking: a forgotten probe that connects again enrols as a stranger and waits in the queue. Use it when the machine is genuinely gone.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `gid` | path | string, 1–128 characters | **required** |

**204**

## reports

### `GET /api/v1/reports`

The reports this account may see

By name. An administrator sees every report; everybody else sees the ones a group they belong to has been granted.

**200** { items }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `items` | object[] | **required** |  |
| `items[].id` | integer | **required** |  |
| `items[].name` | string | **required** |  |
| `items[].description` | string | **required** |  |
| `items[].kind` | `graph_and_table` · `table_only` · `graph_only` · `sensor_list` · `installation` · `top_values` · `top_uptime` | **required** |  |
| `items[].subjects` | object | **required** |  |
| `items[].span` | object | **required** |  |
| `items[].span.kind` | `day` · `week` · `month` · `quarter` · `year` · `custom` | **required** |  |
| `items[].span.offset` | integer, 0–1000 |  |  |
| `items[].span.timezone` | string, at most 64 characters |  |  |
| `items[].span.from` | string |  |  |
| `items[].span.to` | string |  |  |
| `items[].span.resolutionSeconds` | integer, at least 1 |  |  |
| `items[].resolved` | object |  |  |
| `items[].resolved.from` | string (date-time) | **required** |  |
| `items[].resolved.to` | string (date-time) | **required** |  |
| `items[].resolved.label` | string | **required** |  |
| `items[].resolved.timezone` | string | **required** |  |
| `items[].resolved.bucketSeconds` | integer | **required** |  |
| `items[].resolved.source` | `sample_1d` · `sample_1h` · `sample_5m` · `sample` | **required** | The table the span would be read from: raw `sample`, or a rollup tier (`sample_5m`, `sample_1h`, `sample_1d`). |
| `items[].resolved.adjustments` | object[] | **required** |  |
| `items[].resolved.adjustments[].kind` | `range-shortened` · `resolution-coarsened` | **required** |  |
| `items[].resolved.adjustments[].reason` | string | **required** | A sentence for a person, naming the rule and its numbers. Free text: switch on `kind`. |
| `items[].unresolvable` | object |  |  |
| `items[].unresolvable.code` | string | **required** |  |
| `items[].unresolvable.message` | string | **required** |  |
| `items[].outputs` | object | **required** |  |
| `items[].outputs.formats` | (`html` · `csv` · `xml` · `pdf`)[], at least 1 item |  |  |
| `items[].outputs.delivery` | `store` · `store-and-email` · `email` |  |  |
| `items[].outputs.recipients` | string[], at most 50 items, each at most 320 characters |  |  |
| `items[].outputs.zip` | boolean |  |  |
| `items[].schedule` | object | **required** |  |
| `items[].schedule.kind` | `manual` · `hourly` · `daily` · `weekly` · `monthly` · `quarterly` · `annual` | **required** |  |
| `items[].schedule.minute` | integer, 0–1439 |  |  |
| `items[].schedule.weekday` | integer, 0–6 |  |  |
| `items[].schedule.dayOfMonth` | integer, 1–31 |  |  |
| `items[].schedule.month` | integer, 1–12 |  |  |
| `items[].schedule.timezone` | string, at most 64 characters |  |  |
| `items[].schedule.scheduleId` | integer, at least 1 |  |  |
| `items[].scheduleSummary` | string | **required** |  |
| `items[].nextRunAt` | string (date-time) | **required** nullable |  |
| `items[].lastRunAt` | string (date-time) | **required** nullable |  |
| `items[].runAs` | object | **required** |  |
| `items[].runAs.login` | string | **required** |  |
| `items[].runAs.available` | boolean | **required** |  |
| `items[].version` | integer | **required** |  |
| `items[].createdAt` | string (date-time) | **required** |  |
| `items[].updatedAt` | string (date-time) | **required** |  |

### `POST /api/v1/reports`

Create a report

The creator’s primary group is granted full access in the same transaction, or a non-administrator would create a report and immediately lose sight of it. `runAs` defaults to the caller: a report renders through somebody’s eyes, and the person making it is the only safe default. **Naming any other account needs an administrator**, and a login that does not exist is refused in the same words as one that does, so the refusal cannot be used to list accounts. `span` names a calendar period — `{ kind, offset, timezone }` for `day`, `week`, `month`, `quarter` and `year`, or `{ kind: "custom", from, to }` with ISO 8601 instants. **`offset` counts periods back and defaults to 1**, the last complete one: a monthly report fires on the 1st, and "this month" would be two hours long. `0` is the period in progress and ends now. Weeks start on Monday (ISO 8601), and the zone defaults to the core’s own. Add `resolutionSeconds` to pin an averaging interval. The response carries `resolved`: the window the span works out to right now, the bucket width, the rollup tier that will answer, and anything the rules changed — a span of 40 days or more is averaged over at least an hour, and one over 500 days is shortened to 365. A span that cannot resolve yet answers `unresolvable` instead.

**Body**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `name` | string, 1–100 characters | **required** |  |
| `description` | string, at most 1000 characters |  |  |
| `kind` | `graph_and_table` · `table_only` · `graph_only` · `sensor_list` · `installation` · `top_values` · `top_uptime` | **required** |  |
| `subjects` | object |  |  |
| `subjects.objectIds` | integer[] | **required** |  |
| `span` | object |  |  |
| `span.kind` | `day` · `week` · `month` · `quarter` · `year` · `custom` | **required** |  |
| `span.offset` | integer, 0–1000 |  |  |
| `span.timezone` | string, at most 64 characters |  |  |
| `span.from` | string |  |  |
| `span.to` | string |  |  |
| `span.resolutionSeconds` | integer, at least 1 |  |  |
| `outputs` | object |  |  |
| `outputs.formats` | (`html` · `csv` · `xml` · `pdf`)[], at least 1 item |  |  |
| `outputs.delivery` | `store` · `store-and-email` · `email` |  |  |
| `outputs.recipients` | string[], at most 50 items, each at most 320 characters |  |  |
| `outputs.zip` | boolean |  |  |
| `schedule` | object |  |  |
| `schedule.kind` | `manual` · `hourly` · `daily` · `weekly` · `monthly` · `quarterly` · `annual` | **required** |  |
| `schedule.minute` | integer, 0–1439 |  |  |
| `schedule.weekday` | integer, 0–6 |  |  |
| `schedule.dayOfMonth` | integer, 1–31 |  |  |
| `schedule.month` | integer, 1–12 |  |  |
| `schedule.timezone` | string, at most 64 characters |  |  |
| `schedule.scheduleId` | integer, at least 1 |  |  |
| `runAs` | string, at most 64 characters |  |  |

**201** { id, name, description, kind, subjects, span, resolved, unresolvable, outputs, schedule, scheduleSummary, nextRunAt, lastRunAt, runAs, version, createdAt, updatedAt }

**201 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `id` | integer | **required** |  |
| `name` | string | **required** |  |
| `description` | string | **required** |  |
| `kind` | `graph_and_table` · `table_only` · `graph_only` · `sensor_list` · `installation` · `top_values` · `top_uptime` | **required** |  |
| `subjects` | object | **required** |  |
| `span` | object | **required** |  |
| `span.kind` | `day` · `week` · `month` · `quarter` · `year` · `custom` | **required** |  |
| `span.offset` | integer, 0–1000 |  |  |
| `span.timezone` | string, at most 64 characters |  |  |
| `span.from` | string |  |  |
| `span.to` | string |  |  |
| `span.resolutionSeconds` | integer, at least 1 |  |  |
| `resolved` | object |  |  |
| `resolved.from` | string (date-time) | **required** |  |
| `resolved.to` | string (date-time) | **required** |  |
| `resolved.label` | string | **required** |  |
| `resolved.timezone` | string | **required** |  |
| `resolved.bucketSeconds` | integer | **required** |  |
| `resolved.source` | `sample_1d` · `sample_1h` · `sample_5m` · `sample` | **required** | The table the span would be read from: raw `sample`, or a rollup tier (`sample_5m`, `sample_1h`, `sample_1d`). |
| `resolved.adjustments` | object[] | **required** |  |
| `resolved.adjustments[].kind` | `range-shortened` · `resolution-coarsened` | **required** |  |
| `resolved.adjustments[].reason` | string | **required** | A sentence for a person, naming the rule and its numbers. Free text: switch on `kind`. |
| `unresolvable` | object |  |  |
| `unresolvable.code` | string | **required** |  |
| `unresolvable.message` | string | **required** |  |
| `outputs` | object | **required** |  |
| `outputs.formats` | (`html` · `csv` · `xml` · `pdf`)[], at least 1 item |  |  |
| `outputs.delivery` | `store` · `store-and-email` · `email` |  |  |
| `outputs.recipients` | string[], at most 50 items, each at most 320 characters |  |  |
| `outputs.zip` | boolean |  |  |
| `schedule` | object | **required** |  |
| `schedule.kind` | `manual` · `hourly` · `daily` · `weekly` · `monthly` · `quarterly` · `annual` | **required** |  |
| `schedule.minute` | integer, 0–1439 |  |  |
| `schedule.weekday` | integer, 0–6 |  |  |
| `schedule.dayOfMonth` | integer, 1–31 |  |  |
| `schedule.month` | integer, 1–12 |  |  |
| `schedule.timezone` | string, at most 64 characters |  |  |
| `schedule.scheduleId` | integer, at least 1 |  |  |
| `scheduleSummary` | string | **required** |  |
| `nextRunAt` | string (date-time) | **required** nullable |  |
| `lastRunAt` | string (date-time) | **required** nullable |  |
| `runAs` | object | **required** |  |
| `runAs.login` | string | **required** |  |
| `runAs.available` | boolean | **required** |  |
| `version` | integer | **required** |  |
| `createdAt` | string (date-time) | **required** |  |
| `updatedAt` | string (date-time) | **required** |  |

### `GET /api/v1/reports/{id}`

One report

A report this account may not read answers 404 rather than 403, so the error cannot be used to enumerate which ids exist. The `ETag` is the version, to send back as `If-Match`.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, 1–9007199254740991 | **required** |

**200** { id, name, description, kind, subjects, span, resolved, unresolvable, outputs, schedule, scheduleSummary, nextRunAt, lastRunAt, runAs, version, createdAt, updatedAt }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `id` | integer | **required** |  |
| `name` | string | **required** |  |
| `description` | string | **required** |  |
| `kind` | `graph_and_table` · `table_only` · `graph_only` · `sensor_list` · `installation` · `top_values` · `top_uptime` | **required** |  |
| `subjects` | object | **required** |  |
| `span` | object | **required** |  |
| `span.kind` | `day` · `week` · `month` · `quarter` · `year` · `custom` | **required** |  |
| `span.offset` | integer, 0–1000 |  |  |
| `span.timezone` | string, at most 64 characters |  |  |
| `span.from` | string |  |  |
| `span.to` | string |  |  |
| `span.resolutionSeconds` | integer, at least 1 |  |  |
| `resolved` | object |  |  |
| `resolved.from` | string (date-time) | **required** |  |
| `resolved.to` | string (date-time) | **required** |  |
| `resolved.label` | string | **required** |  |
| `resolved.timezone` | string | **required** |  |
| `resolved.bucketSeconds` | integer | **required** |  |
| `resolved.source` | `sample_1d` · `sample_1h` · `sample_5m` · `sample` | **required** | The table the span would be read from: raw `sample`, or a rollup tier (`sample_5m`, `sample_1h`, `sample_1d`). |
| `resolved.adjustments` | object[] | **required** |  |
| `resolved.adjustments[].kind` | `range-shortened` · `resolution-coarsened` | **required** |  |
| `resolved.adjustments[].reason` | string | **required** | A sentence for a person, naming the rule and its numbers. Free text: switch on `kind`. |
| `unresolvable` | object |  |  |
| `unresolvable.code` | string | **required** |  |
| `unresolvable.message` | string | **required** |  |
| `outputs` | object | **required** |  |
| `outputs.formats` | (`html` · `csv` · `xml` · `pdf`)[], at least 1 item |  |  |
| `outputs.delivery` | `store` · `store-and-email` · `email` |  |  |
| `outputs.recipients` | string[], at most 50 items, each at most 320 characters |  |  |
| `outputs.zip` | boolean |  |  |
| `schedule` | object | **required** |  |
| `schedule.kind` | `manual` · `hourly` · `daily` · `weekly` · `monthly` · `quarterly` · `annual` | **required** |  |
| `schedule.minute` | integer, 0–1439 |  |  |
| `schedule.weekday` | integer, 0–6 |  |  |
| `schedule.dayOfMonth` | integer, 1–31 |  |  |
| `schedule.month` | integer, 1–12 |  |  |
| `schedule.timezone` | string, at most 64 characters |  |  |
| `schedule.scheduleId` | integer, at least 1 |  |  |
| `scheduleSummary` | string | **required** |  |
| `nextRunAt` | string (date-time) | **required** nullable |  |
| `lastRunAt` | string (date-time) | **required** nullable |  |
| `runAs` | object | **required** |  |
| `runAs.login` | string | **required** |  |
| `runAs.available` | boolean | **required** |  |
| `version` | integer | **required** |  |
| `createdAt` | string (date-time) | **required** |  |
| `updatedAt` | string (date-time) | **required** |  |

### `PATCH /api/v1/reports/{id}`

Change a report

`If-Match` carries the version this edit was made against, and is refused with 428 when missing and 412 `REPORT_CHANGED` when it has moved on. Changing `runAs` needs full access rather than write: it decides whose data the output contains, which is the same class of act as granting access. **Full is enough only to point it at yourself** — naming any other account needs an administrator, as it does on create.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, 1–9007199254740991 | **required** |

**Body**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `name` | string, 1–100 characters |  |  |
| `description` | string, at most 1000 characters |  |  |
| `kind` | `graph_and_table` · `table_only` · `graph_only` · `sensor_list` · `installation` · `top_values` · `top_uptime` |  |  |
| `subjects` | object |  |  |
| `subjects.objectIds` | integer[] | **required** |  |
| `span` | object |  |  |
| `span.kind` | `day` · `week` · `month` · `quarter` · `year` · `custom` | **required** |  |
| `span.offset` | integer, 0–1000 |  |  |
| `span.timezone` | string, at most 64 characters |  |  |
| `span.from` | string |  |  |
| `span.to` | string |  |  |
| `span.resolutionSeconds` | integer, at least 1 |  |  |
| `outputs` | object |  |  |
| `outputs.formats` | (`html` · `csv` · `xml` · `pdf`)[], at least 1 item |  |  |
| `outputs.delivery` | `store` · `store-and-email` · `email` |  |  |
| `outputs.recipients` | string[], at most 50 items, each at most 320 characters |  |  |
| `outputs.zip` | boolean |  |  |
| `schedule` | object |  |  |
| `schedule.kind` | `manual` · `hourly` · `daily` · `weekly` · `monthly` · `quarterly` · `annual` | **required** |  |
| `schedule.minute` | integer, 0–1439 |  |  |
| `schedule.weekday` | integer, 0–6 |  |  |
| `schedule.dayOfMonth` | integer, 1–31 |  |  |
| `schedule.month` | integer, 1–12 |  |  |
| `schedule.timezone` | string, at most 64 characters |  |  |
| `schedule.scheduleId` | integer, at least 1 |  |  |
| `runAs` | string, at most 64 characters |  |  |

**200** { id, name, description, kind, subjects, span, resolved, unresolvable, outputs, schedule, scheduleSummary, nextRunAt, lastRunAt, runAs, version, createdAt, updatedAt }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `id` | integer | **required** |  |
| `name` | string | **required** |  |
| `description` | string | **required** |  |
| `kind` | `graph_and_table` · `table_only` · `graph_only` · `sensor_list` · `installation` · `top_values` · `top_uptime` | **required** |  |
| `subjects` | object | **required** |  |
| `span` | object | **required** |  |
| `span.kind` | `day` · `week` · `month` · `quarter` · `year` · `custom` | **required** |  |
| `span.offset` | integer, 0–1000 |  |  |
| `span.timezone` | string, at most 64 characters |  |  |
| `span.from` | string |  |  |
| `span.to` | string |  |  |
| `span.resolutionSeconds` | integer, at least 1 |  |  |
| `resolved` | object |  |  |
| `resolved.from` | string (date-time) | **required** |  |
| `resolved.to` | string (date-time) | **required** |  |
| `resolved.label` | string | **required** |  |
| `resolved.timezone` | string | **required** |  |
| `resolved.bucketSeconds` | integer | **required** |  |
| `resolved.source` | `sample_1d` · `sample_1h` · `sample_5m` · `sample` | **required** | The table the span would be read from: raw `sample`, or a rollup tier (`sample_5m`, `sample_1h`, `sample_1d`). |
| `resolved.adjustments` | object[] | **required** |  |
| `resolved.adjustments[].kind` | `range-shortened` · `resolution-coarsened` | **required** |  |
| `resolved.adjustments[].reason` | string | **required** | A sentence for a person, naming the rule and its numbers. Free text: switch on `kind`. |
| `unresolvable` | object |  |  |
| `unresolvable.code` | string | **required** |  |
| `unresolvable.message` | string | **required** |  |
| `outputs` | object | **required** |  |
| `outputs.formats` | (`html` · `csv` · `xml` · `pdf`)[], at least 1 item |  |  |
| `outputs.delivery` | `store` · `store-and-email` · `email` |  |  |
| `outputs.recipients` | string[], at most 50 items, each at most 320 characters |  |  |
| `outputs.zip` | boolean |  |  |
| `schedule` | object | **required** |  |
| `schedule.kind` | `manual` · `hourly` · `daily` · `weekly` · `monthly` · `quarterly` · `annual` | **required** |  |
| `schedule.minute` | integer, 0–1439 |  |  |
| `schedule.weekday` | integer, 0–6 |  |  |
| `schedule.dayOfMonth` | integer, 1–31 |  |  |
| `schedule.month` | integer, 1–12 |  |  |
| `schedule.timezone` | string, at most 64 characters |  |  |
| `schedule.scheduleId` | integer, at least 1 |  |  |
| `scheduleSummary` | string | **required** |  |
| `nextRunAt` | string (date-time) | **required** nullable |  |
| `lastRunAt` | string (date-time) | **required** nullable |  |
| `runAs` | object | **required** |  |
| `runAs.login` | string | **required** |  |
| `runAs.available` | boolean | **required** |  |
| `version` | integer | **required** |  |
| `createdAt` | string (date-time) | **required** |  |
| `updatedAt` | string (date-time) | **required** |  |

### `DELETE /api/v1/reports/{id}`

Delete a report

Needs full access, because deleting one takes its grants with it.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, 1–9007199254740991 | **required** |

**204**

### `GET /api/v1/reports/{id}/subjects`

What this report would contain, as its security context sees it

A report renders through a named account, not through whoever is asking (`§6`). This route answers the same question the renderer will: which of the objects the report names that account can actually read. **Reading this needs only `read` on the report, and that is the act-as grant working as designed** — granting somebody access to a report grants them everything its `runAs` account can see, whatever their own rights are. Grant reports the way you would grant the account they run as. `unavailable` lists ids this report will not render, and deliberately does not say whether each is deleted or merely out of scope: a `write` holder on a report needs no access to the object tree, and telling the two apart would make this an existence oracle for every id in the installation. The distinction is in the core log. Answers 422 when the account has been deleted or disabled — understood request, real report, no scope to render it through, and no right the caller could hold would fix it.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, 1–9007199254740991 | **required** |

**200** { runAs, visible, unavailable }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `runAs` | object | **required** |  |
| `runAs.login` | string | **required** |  |
| `runAs.role` | `admin` · `readwrite` · `readonly` | **required** |  |
| `visible` | object[] | **required** |  |
| `visible[].id` | integer | **required** |  |
| `visible[].kind` | `root` · `probe` · `group` · `device` · `sensor` | **required** |  |
| `visible[].name` | string | **required** |  |
| `unavailable` | integer[] | **required** |  |

### `GET /api/v1/reports/{id}/runs`

When this report ran, and what happened

Newest first, at most 50 of them. A run that failed carries the same code the API would have answered with, so an operator reading this and an operator reading a 422 are told the same thing. A run left `failed` with `REPORT_INTERRUPTED` was in flight when the core stopped. It is marked at the next startup rather than left `running` for ever — the partial unique index over `running` would otherwise keep that report unrunnable.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, 1–9007199254740991 | **required** |

**200** { items }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `items` | object[] | **required** |  |
| `items[].id` | integer | **required** |  |
| `items[].reportId` | integer | **required** |  |
| `items[].trigger` | `manual` · `scheduled` | **required** |  |
| `items[].requestedBy` | string | **required** |  |
| `items[].state` | `running` · `succeeded` · `failed` | **required** |  |
| `items[].queuedAt` | string (date-time) | **required** |  |
| `items[].startedAt` | string (date-time) | **required** nullable |  |
| `items[].finishedAt` | string (date-time) | **required** nullable |  |
| `items[].durationMs` | integer | **required** nullable |  |
| `items[].spanLabel` | string | **required** |  |
| `items[].sections` | integer | **required** nullable |  |
| `items[].unavailable` | integer | **required** nullable |  |
| `items[].cells` | integer | **required** nullable |  |
| `items[].errorCode` | string | **required** |  |
| `items[].errorMessage` | string | **required** |  |
| `items[].delivery` | object | **required** |  |
| `items[].delivery.state` | `none` · `pending` · `sent` · `failed` | **required** |  |
| `items[].delivery.attempts` | integer | **required** |  |
| `items[].delivery.error` | string | **required** |  |
| `items[].delivery.nextAttemptAt` | string (date-time) | **required** nullable |  |
| `items[].delivery.deliveredAt` | string (date-time) | **required** nullable |  |
| `items[].outputs` | object[] |  |  |
| `items[].outputs[].format` | `html` · `csv` · `xml` · `pdf` · `zip` | **required** |  |
| `items[].outputs[].filename` | string | **required** |  |
| `items[].outputs[].byteSize` | integer | **required** |  |
| `items[].outputs[].sha256` | string | **required** |  |
| `items[].outputs[].createdAt` | string (date-time) | **required** |  |

### `POST /api/v1/reports/{id}/runs`

Run this report now

Renders the report against its span and its security context, and records the outcome. **Needs `write`, not `read`** — a render is minutes of work against the same database serving live checks, so starting one is a write even though it changes nothing about the report. **One run at a time.** A report already rendering answers 409 rather than queueing: a button pressed six times must not become six renders competing for the same pool. The constraint is a partial unique index, so two requests racing lose at the database rather than in a window between a check and an insert. The rendered document is not kept — `E-09` decides where a report goes. What this records is that it ran, what period it covered, how large it was, and why it failed if it did, which is what tells an operator at 09:00 whether last night worked.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, 1–9007199254740991 | **required** |

**201** { id, reportId, trigger, requestedBy, state, queuedAt, startedAt, finishedAt, durationMs, spanLabel, sections, unavailable, cells, errorCode, errorMessage, delivery, outputs }

**201 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `id` | integer | **required** |  |
| `reportId` | integer | **required** |  |
| `trigger` | `manual` · `scheduled` | **required** |  |
| `requestedBy` | string | **required** |  |
| `state` | `running` · `succeeded` · `failed` | **required** |  |
| `queuedAt` | string (date-time) | **required** |  |
| `startedAt` | string (date-time) | **required** nullable |  |
| `finishedAt` | string (date-time) | **required** nullable |  |
| `durationMs` | integer | **required** nullable |  |
| `spanLabel` | string | **required** |  |
| `sections` | integer | **required** nullable |  |
| `unavailable` | integer | **required** nullable |  |
| `cells` | integer | **required** nullable |  |
| `errorCode` | string | **required** |  |
| `errorMessage` | string | **required** |  |
| `delivery` | object | **required** |  |
| `delivery.state` | `none` · `pending` · `sent` · `failed` | **required** |  |
| `delivery.attempts` | integer | **required** |  |
| `delivery.error` | string | **required** |  |
| `delivery.nextAttemptAt` | string (date-time) | **required** nullable |  |
| `delivery.deliveredAt` | string (date-time) | **required** nullable |  |
| `outputs` | object[] |  |  |
| `outputs[].format` | `html` · `csv` · `xml` · `pdf` · `zip` | **required** |  |
| `outputs[].filename` | string | **required** |  |
| `outputs[].byteSize` | integer | **required** |  |
| `outputs[].sha256` | string | **required** |  |
| `outputs[].createdAt` | string (date-time) | **required** |  |

### `GET /api/v1/reports/{id}/access`

Which groups may see this report

Needs full access: who else can read a report is not a read-only detail.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, 1–9007199254740991 | **required** |

**200** { items }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `items` | object[] | **required** |  |
| `items[].groupId` | integer | **required** |  |
| `items[].groupName` | string | **required** |  |
| `items[].right` | `none` · `read` · `write` · `full` | **required** |  |
| `items[].grantedAt` | string (date-time) | **required** |  |
| `items[].grantedBy` | string | **required** |  |

### `PUT /api/v1/reports/{id}/access/{groupId}`

Grant a group access to this report

Needs full access, so a write holder may edit what a report measures without deciding who else reads it. Granting twice replaces rather than failing.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, 1–9007199254740991 | **required** |
| `groupId` | path | integer, 1–9007199254740991 | **required** |

**Body**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `right` | `none` · `read` · `write` · `full` | **required** |  |

**204**

### `DELETE /api/v1/reports/{id}/access/{groupId}`

Take a group’s access away

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, 1–9007199254740991 | **required** |
| `groupId` | path | integer, 1–9007199254740991 | **required** |

**204**

### `GET /api/v1/reports/{id}/render`

Render this report now, as HTML, CSV, XML or PDF

Runs the report against its span and its security context and answers the document. `?format=html` (the default), `?format=csv`, `?format=xml` or `?format=pdf`. **An interval with no reading is a gap, in every format** — an empty field in CSV, `—` in HTML and in PDF, and `xsi:nil="true"` in XML, never a zero and never the previous value carried forward. A row whose channels are all empty is still printed: dropping it would make the table claim the period was shorter than it was. A PDF is laid out by this service rather than by a browser (`ADR-006`), so it has a page limit as well as a value limit: a report over 400 pages answers 422 with the count and what to narrow. Subjects the report’s account cannot read are counted in the document rather than omitted from it, and answer as ids without saying which are deleted (`E-03`). A report whose account has been deleted or disabled answers 422, and one that would render more values than the limit answers 422 with the count and what to narrow — refused rather than truncated, because a report quietly missing its last four hundred sensors is the failure this whole surface exists to avoid.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, 1–9007199254740991 | **required** |

**200**

### `GET /api/v1/reports/{id}/runs/{runId}/{format}`

Download what a run produced

The stored document, as `html`, `csv`, `xml`, `pdf` or `zip` depending on what the report was set to render. The bytes carry their own SHA-256 as a strong `ETag`; send `If-None-Match` and a second download is a 304. **An email-only report keeps nothing once it has been delivered** (`ADR-005` Decision 4) and answers 404 here. It is stored between rendering and sending because a retry needs the bytes, and a re-render months later is a different document.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, 1–9007199254740991 | **required** |
| `runId` | path | integer, 1–9007199254740991 | **required** |
| `format` | path | `html` · `csv` · `xml` · `pdf` · `zip` | **required** |

**200**

## schedules

### `GET /api/v1/schedules`

Every schedule, with what it means right now

`active` and `nextChangeAt` are evaluated at the moment the request is served, so a list is also the answer to "what is suspended at the moment".

**200** { items }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `items` | [ms:schedule](#schema-ms-schedule)[] | **required** |  |

### `POST /api/v1/schedules`

Create a schedule

Give either `periods` (`fr:19:00-mo:06:00`, space or comma separated) or `grid` (7 × 24 booleans, Monday first) — never both. `polarity` says which one the periods describe: `active` is when monitoring runs, `inactive` is when it is suspended. It applies to `periods` only: a grid’s marked cells *are* the monitored hours, so a polarity sent beside a grid is ignored.

**Body** — [ms:scheduleInput](#schema-ms-scheduleinput)

**201** { id, name, description, polarity, authoredAs, timezone, effectiveTimezone, periods, grid, gridIsExact, builtIn, active, nextChangeAt, usedBy, createdAt, updatedAt }

**201** is [ms:schedule](#schema-ms-schedule)

### `GET /api/v1/schedules/{id}`

One schedule

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, at least 1 | **required** |

**200** { id, name, description, polarity, authoredAs, timezone, effectiveTimezone, periods, grid, gridIsExact, builtIn, active, nextChangeAt, usedBy, createdAt, updatedAt }

**200** is [ms:schedule](#schema-ms-schedule)

### `PUT /api/v1/schedules/{id}`

Replace a schedule

Whole-document: a partial update of a period list is a merge nobody can define. Sensors under this schedule are re-evaluated in the same transaction, so a window that has just closed pauses them before the response is sent.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, at least 1 | **required** |

**Body** — [ms:scheduleInput](#schema-ms-scheduleinput)

**200** { id, name, description, polarity, authoredAs, timezone, effectiveTimezone, periods, grid, gridIsExact, builtIn, active, nextChangeAt, usedBy, createdAt, updatedAt }

**200** is [ms:schedule](#schema-ms-schedule)

### `DELETE /api/v1/schedules/{id}`

Delete a schedule

Refused while any object still assigns it — the refusal names them — and refused outright for the schedules this build ships. **The refusal names and counts only the objects, and the rediscovery rules, the caller can see** (`A-16`); `details.outsideView` is true when others outside the caller’s view are in the way too, and says nothing of how many. An administrator is shown every one.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, at least 1 | **required** |

**200** { id, deleted }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `id` | integer | **required** |  |
| `deleted` | boolean | **required** |  |

## sensor-types

### `GET /api/v1/sensor-types`

List the registered sensor types

Every type this installation can run, with the JSON Schema its parameters are validated against. An empty list means no sensor can be created.

**200** { items }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `items` | object[] | **required** |  |
| `items[].id` | string | **required** |  |
| `items[].category` | string | **required** |  |
| `items[].costHint` | `light` · `medium` · `heavy` | **required** |  |
| `items[].paramsSchema` | object | **required** |  |
| `items[].hasPreview` | boolean | **required** |  |
| `items[].listener` | string |  | The probe listener that feeds this type (`snmp-trap`, `syslog`, `flow`), where one does. A sensor of such a type reads nothing on a probe whose listener is off. |

### `POST /api/v1/sensor-types/{id}/preview`

Run this type’s mapping language over a pasted response

For types whose parameters contain paths into a document — `rest.custom`’s `extract` array is the one — this answers what each path selects against a response the operator pasted, what the aggregate makes of it, and whether the check would pass. **The type’s own code runs**, the same functions a real check runs, so a path proved here works against the device. **Nothing is fetched and nothing is stored.** The document comes from the request; no sensor is created, no credential is read, and no reading enters history. Types with no mapping language answer 409, and `hasPreview` on the type list says which those are without a request. A path that does not parse is reported on its own row rather than failing the request: the form this feeds has a half-typed path in it every few keystrokes.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | string, at most 100 characters | **required** |

**Body**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `document` | string, at most 262144 characters | **required** | The response, pasted verbatim. Bounded well below what the sensor itself will read: this one is walked once per path while somebody types, and a preview is for finding out whether a path is right, not for proving a sensor can survive the whole document. |
| `contentType` | string, at most 200 characters | default `` | What the server called it, where that is known. Empty is honest and common — the format is then guessed from the document exactly as the sensor guesses it. |
| `params` | object | **required** | The parameters as the form currently holds them. **Not validated first**: the form asking for this has a half-finished parameter set in it by definition, and a preview that refused until everything was valid would be unavailable exactly when it is needed. |

**200** { format, error, rows, expectations, problems }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `format` | string | **required** | How the document was read — `auto` resolved. |
| `error` | string |  | Set when the document itself did not parse. |
| `rows` | object[] | **required** |  |
| `rows[].key` | string | **required** |  |
| `rows[].path` | string | **required** |  |
| `rows[].error` | string |  |  |
| `rows[].selected` | object[] | **required** |  |
| `rows[].selected[].text` | string | **required** |  |
| `rows[].selected[].numeric` | boolean | **required** |  |
| `rows[].selectedCount` | integer | **required** |  |
| `rows[].value` | number | **required** nullable |  |
| `expectations` | object[] | **required** |  |
| `expectations[].path` | string | **required** |  |
| `expectations[].error` | string |  |  |
| `expectations[].actual` | string | **required** |  |
| `expectations[].ok` | boolean | **required** |  |
| `problems` | string[] | **required** |  |

## sensors

### `GET /api/v1/sensors/{id}/values`

Each channel's current reading, for a sensor detail page's channel table. A `null` value means no reading inside the window, which is a gap and never a zero: the window is three scan intervals (at least a minute), so a sensor that has stopped reporting shows nothing rather than its last healthy figure dressed as current. `at` is when the reading shown was actually taken.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, 1–9007199254740991 | **required** |

**200** { sensorId, readAt, notBefore, intervalSeconds, channels }

**200** is [ms:sensorValues](#schema-ms-sensorvalues)

### `GET /api/v1/sensors/{id}/history`

Historic channel data for a sensor. The resolution is snapped up to a supported averaging interval (15s upwards); ranges over 500 days are shortened to 365, and ranges of 40 days or more are averaged over at least 60 minutes. Everything the rules change is reported in `adjustments`. In `avg`, `min`, `max` and `count`, null is a gap — a period the sensor produced no readings — and never a zero.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `from` | query | string, at most 64 characters |  |
| `to` | query | string, at most 64 characters |  |
| `resolutionSeconds` | query | integer, 1–86400 |  |
| `id` | path | integer, 1–9007199254740991 | **required** |

**200** { sensorId, from, to, resolutionSeconds, bucketCount, source, segments, adjustments, buckets, channels }

**200** is [ms:sensorHistory](#schema-ms-sensorhistory)

### `POST /api/v1/sensors/{id}/check`

Run this sensor’s check now and return what it said

Asks the probe that owns the sensor to run **exactly** the check a scheduled scan would run — the same parameters, the same credentials, the same target — and hands back the result. **Nothing is stored**: a reading taken outside the schedule is not history, and ten presses of the button would otherwise draw ten spikes into a channel whose interval is a minute. `stored` says so on every response. A check that *fails* is a 200 carrying `outcome: "error"` and the reason, because that is the answer somebody pressed the button to get. The error statuses are for the query failing rather than the check: 503 the probe is not connected or is already running as many of these as it will, 504 it did not answer in time, 409 it is too old to be asked at all — or, as `OBJECT_CREDENTIALS_WITHHELD`, the sensor is not being sent its credentials because nobody who may still write where they are stored vouches for where it sends them (`A-41`); the message says what fixes it. A **paused** sensor can still be checked. A pause stops the monitoring; it does not stop an operator asking whether the thing they just fixed is working, which is exactly when a sensor is most likely to be paused.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, 1–9007199254740991 | **required** |

**Body**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `timeoutMs` | integer, 1000–120000 |  | How long to wait. Bounded well below the sensor’s own timeout allowance because a person is waiting: a check that may run for an hour is not something to hold an HTTP request open for. The probe is told the same number and abandons the work when it expires. |

**200** { sensorId, at, outcome, message, durationMs, channels, stored }

**200** is [ms:checkResult](#schema-ms-checkresult)

### `GET /api/v1/sensors/{id}/state`

A sensor’s current state, why it is in it, and since when. `pausedBy` lists every pause source holding the sensor, not only the one `cause` reports: the four are an independent set, so clearing the reported one does not necessarily resume it.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, 1–9007199254740991 | **required** |

**200** { sensorId, state, cause, message, since, lastResultAt, consecutiveFailures, pausedBy, acknowledged, acknowledgedUntil, acknowledgedBy, simulatedError }

**200** is [ms:sensorState](#schema-ms-sensorstate)

## settings

### `GET /api/v1/setting-definitions`

**200** { items }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `items` | object[] | **required** |  |
| `items[].key` | string | **required** |  |
| `items[].schema` | object | **required** |  |
| `items[].default` | any | **required** |  |
| `items[].description` | string | **required** |  |

### `GET /api/v1/objects/{id}/settings`

Effective and own values together. ?asChildOf=<parentId> projects what the object would resolve to under a different parent — the move confirmation dialog, without performing the move.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `asChildOf` | query | integer, at least 1 |  |
| `id` | path | integer, 1–9007199254740991 | **required** |

**200** { objectId, asChildOf, settings }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `objectId` | integer | **required** |  |
| `asChildOf` | integer | **required** nullable |  |
| `settings` | [ms:settingView](#schema-ms-settingview)[] | **required** |  |

### `PUT /api/v1/objects/{id}/settings/{key}`

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, 1–9007199254740991 | **required** |
| `key` | path | string, 1–100 characters | **required** |

**Body**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `value` | any | **required** |  |

**200** { key, description, schema, effective, inherited, own }

**200** is [ms:settingView](#schema-ms-settingview)

### `DELETE /api/v1/objects/{id}/settings/{key}`

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, 1–9007199254740991 | **required** |
| `key` | path | string, 1–100 characters | **required** |

**200** { key, reverted, effective, own }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `key` | string | **required** |  |
| `reverted` | boolean | **required** |  |
| `effective` | object | **required** |  |
| `effective.value` | any | **required** |  |
| `effective.source` | [ms:settingSource](#schema-ms-settingsource) | **required** |  |
| `own` | null | **required** |  |

## state

### `GET /api/v1/objects/{id}/pause`

Whether this object is paused, why, until when, and whether this is the one that can be resumed.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, 1–9007199254740991 | **required** |

**200** { objectId, paused, pending, resumable, source, pausedAt, startsAt, pausedUntil, message, actor, inheritedFrom, schedule, dependency }

**200** is [ms:pauseView](#schema-ms-pauseview)

### `POST /api/v1/objects/{id}/pause`

Pauses an object and every sensor beneath it. Give `minutes` for a duration, `until` for a moment, or neither to pause indefinitely — until a person says otherwise. A UI offers 5, 15, 60, 180, 1440 minutes as presets, but any duration is accepted. Takes effect immediately: the sensors change state in this request, and their probe stops being told to scan them. Pausing an already-paused object replaces the reason and the deadline rather than stacking, which is what extending a maintenance window means. Give `from` with `until` for a **maintenance window** — the same pause, scheduled rather than immediate. Nothing is paused until it starts; the object reads `pending` until then and can be cancelled at any point by resuming it.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, 1–9007199254740991 | **required** |

**Body**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `minutes` | integer, 1–525600 |  |  |
| `until` | string, 1–64 characters |  |  |
| `from` | string, 1–64 characters |  |  |
| `message` | string, at most 500 characters |  |  |

- `minutes` and `until` are not allowed together
- `minutes` and `from` are not allowed together
- `from` requires `until`

**200** { objectId, paused, pending, resumable, source, pausedAt, startsAt, pausedUntil, message, actor, inheritedFrom, schedule, dependency }

**200** is [ms:pauseView](#schema-ms-pauseview)

### `DELETE /api/v1/objects/{id}/pause`

Resumes an object, or cancels a maintenance window it has not reached yet. Only the object that was directly paused can be resumed — a sensor paused because its device is paused has nothing of its own to clear, and the 409 names the object to resume instead. **By id alone when the caller cannot see it** (`A-16`): a pause inherited from a container above the caller’s branch, or a master in another branch, is named in the 409 as `GET` names it, with `pausedByName` or `masterName` null. A resumed sensor reads Unknown until its next scan, never the state it had before the pause, which the system has not checked since.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, 1–9007199254740991 | **required** |

**200** { objectId, paused, pending, resumable, source, pausedAt, startsAt, pausedUntil, message, actor, inheritedFrom, schedule, dependency }

**200** is [ms:pauseView](#schema-ms-pauseview)

### `POST /api/v1/objects/{id}/acknowledge`

Acknowledges a Down alarm: the sensor reads Down (Acknowledged), notifications stop, and monitoring carries on exactly as before. Give `minutes` for a duration, `until` for a moment, or neither to acknowledge indefinitely. A UI offers 5, 15, 60, 180, 1440 minutes as presets. On a device or a group this acknowledges every sensor beneath it that is Down **at this moment** — a snapshot, not a rule, so a sensor that fails later is a new alarm — and that the caller could acknowledge by naming it; the rest are listed in `skipped`. The message becomes the sensor’s last message. It clears on recovery, on expiry, on pause-then-resume, or by DELETE.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, 1–9007199254740991 | **required** |

**Body**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `minutes` | integer, 1–525600 |  |  |
| `until` | string, 1–64 characters |  |  |
| `message` | string, at most 500 characters |  |  |

- `minutes` and `until` are not allowed together

**200** { objectId, acknowledged, refused, skipped, acknowledgedAt, acknowledgedUntil, message }

**200** is [ms:acknowledgementView](#schema-ms-acknowledgementview)

### `DELETE /api/v1/objects/{id}/acknowledge`

Withdraws an acknowledgement, so the alarm reads Down again and notifications resume. The three things that clear one on their own — recovery, expiry and pause-then-resume — are all events; this is the one for "I acknowledged the wrong sensor".

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, 1–9007199254740991 | **required** |

**200** { objectId, acknowledged, refused, skipped, acknowledgedAt, acknowledgedUntil, message }

**200** is [ms:acknowledgementView](#schema-ms-acknowledgementview)

### `POST /api/v1/objects/{id}/simulate-error`

Forces sensors Down so a notification chain can be tested end to end. **This fires the real chain at real people** — which is the point, since a chain nobody has seen fire is a chain nobody knows works. The sensor reads Down with cause `simulated`, never `scan`, so a forced outage cannot be mistaken for a real one; the message becomes its last message; the action is audited. On a device or a group this forces **every** sensor beneath it, whatever state it was in, that the caller may write; the rest are listed in `skipped`. Pausing still wins, so a sensor somebody switched off will not start paging anyone.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, 1–9007199254740991 | **required** |

**Body**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `message` | string, at most 500 characters |  |  |

**200** { objectId, simulated, sensors, skipped, message }

**200** is [ms:simulatedErrorView](#schema-ms-simulatederrorview)

### `DELETE /api/v1/objects/{id}/simulate-error`

Lifts a simulated error. The sensors return to what they actually measure straight away — unlike a resume, which yields Unknown, because a forced sensor never stopped being scanned: the force changes what its readings *mean*, not whether it takes any.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, 1–9007199254740991 | **required** |

**200** { objectId, simulated, sensors, skipped, message }

**200** is [ms:simulatedErrorView](#schema-ms-simulatederrorview)

### `GET /api/v1/state-log`

Every state change, newest first

What changed, when, from what, why, and how long it lasted. Scope to a branch with `objectId` — a sensor id gives that sensor’s log. Filter with `state` and `cause`, both repeatable. Page with `before`, using `nextBefore` from the previous page. `durationMs` is null on the state a sensor is still in, and is measured against the real next transition rather than the next one on this page. Only sensors the caller can read appear. A deleted sensor’s history outlives it, but nothing records which branch it was in, so only an administrator sees it.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `objectId` | query | integer, at least 1 |  |
| `from` | query | string, at most 64 characters |  |
| `to` | query | string, at most 64 characters |  |
| `state` | query | `unknown` · `up` · `warning` · `down` · `down_acknowledged` · `down_partial` · `unusual` · `paused`, or an array of them, at most 8 items |  |
| `cause` | query | `scan` · `limit` · `lookup` · `user` · `schedule` · `dependency` · `parent` · `probe` · `access` · `simulated`, or an array of them, at most 10 items |  |
| `before` | query | string, at most 40 characters |  |
| `limit` | query | integer, 1–500 | default `100` |

**200** { items, nextBefore }

**200** is [ms:stateLogPage](#schema-ms-statelogpage)

### `GET /api/v1/alarms`

Every sensor that is currently in an alarm state, worst first, and every held return

Down, Down (Partial), Down (Acknowledged), Warning and Unusual — the five states `WORKFLOW.MD §7` names. **Paused and Unknown are absent by design**: a paused sensor is deliberately silent, and Unknown means nothing has scanned it yet, which is a gap in coverage rather than a fault. Reporting either as an alarm is how a list becomes one an operator scrolls past. `objectId` scopes to that object and everything beneath it. `counts` is per state across the whole scope and ignores the `state` filter, so a severity chip can still say how many it is hiding. A sensor that is back while its alarm waits to see the return last (`M-18`) is listed too, after everything still happening, with `recovering` saying when it is over. It counts as `recovering` rather than as its state, unless that state is one of the five, and `state=recovering` filters to those. `now` is the core's clock, to time the moment a hold ends against: that is not a state change, and the state stream does not announce it. Only sensors the caller can read are listed or counted, and `path` and `pathNames` carry only the steps the caller can read.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `objectId` | query | integer, at least 1 |  |
| `state` | query | `down` · `down_partial` · `down_acknowledged` · `warning` · `unusual` · `recovering`, or an array of them, at most 6 items |  |
| `priorityMin` | query | integer, 1–5 |  |
| `includeAcknowledged` | query | boolean | default `true` |
| `sort` | query | `priority` · `duration` | default `priority` |
| `limit` | query | integer, 1–500 | default `100` |

**200** { items, total, counts, now }

**200** is [ms:alarmPage](#schema-ms-alarmpage)

## stream

### `GET /api/v1/stream`

Live sensor state changes

A WebSocket. Send `{"subscribe":{"objectId":42}}` to scope to a subtree, or `{"subscribe":{}}` for everything; the server answers with a `snapshot` frame and then a `state` frame per change. Subscribing again replaces the subscription and takes a fresh snapshot, which is also how a client resyncs — there is no cursor. A client that cannot keep up is sent `overflow` and detached rather than being quietly trimmed, because a tree missing a change looks exactly like a tree that is up to date. "Everything" is everything the caller can read: sensors it cannot are neither in the snapshot nor streamed, and every `path` carries only the steps it can read. Subscribing to an object it cannot read is answered with a `problem` frame. When what the caller may see changes — a grant revoked, a group left — the socket is sent `overflow` with that reason, and subscribing again takes a snapshot of the new view. Send `{"subscribe":{"probeId":7}}` to watch one probe itself rather than the sensors beneath it. The server answers `{"type":"watching","probeId":7}` and then sends `{"type":"probe","probeId":7}` whenever that probe connects, drops, or sends a report that differs in which listeners it says are running. The frame carries no value: it means "ask `GET /probes/7/health` again", which is where what the caller may know about the probe is decided. It is sent only to a caller who can read that probe, and a watch on a probe the caller cannot read — or on an id that is not a probe — is answered with `problem`. Changes that arrive faster than the socket takes them are folded into one frame, so a `probe` frame means "at least once since the last", and the frames are not numbered. `objectId` and `probeId` together are refused. A watch whose caller loses the probe is sent nothing when the probe next changes; it is sent `overflow` within seconds of the grant changing, on a timer of the core’s own, so that when it arrives says nothing about the probe. `seq` numbers the `state` frames this socket has been sent, from 1 and across every subscription it makes; `hello` carries 0 and a `snapshot` the number of the last `state` frame before it. It is the socket’s own count, so a gap means a frame was lost and never that something changed outside what the caller can see. A socket is closed with 1008 when it subscribes more than 30 times in a minute, or sends more than 5 frames the stream cannot use — each of those is answered with `problem` — and closed outright when it stops reading and 16 MiB queue up unsent. A socket is closed with 4401 when what authenticated it no longer does — its session ended or expired, its token was revoked or expired, or its account was disabled. Nothing that changed after that is sent to it: from the first change the core would have sent, the socket is sent nothing at all, and it is closed on a timer of the core’s own, within five seconds, so that when the close arrives says nothing about what changed or when. A frame the client sends in that time is not answered, and closes the socket at once. Do not reconnect on 4401: sign in again. An open stream does not count as activity, so a session used for nothing else reaches its idle timeout. The five seconds are from a database that answers. While the core cannot ask whether a credential still authenticates, no socket is closed with 4401; one already being sent nothing stays that way. A frame the client sends waits for that answer however long it takes, so a slow database makes a late snapshot and closes nothing. Only when the question fails is the frame not acted on and the socket closed with 1013, signed in or not: reconnect and subscribe again, waiting longer each time until a subscription is answered — `hello` is sent to every socket and is not an answer. A change is not held for that answer longer than two seconds. While the core cannot get it, a change goes only to a socket the core has found signed in within the last five seconds; any other socket is sent nothing from that change on, and is sent `overflow` — subscribe again — once the core can say it is still signed in.

## templates

### `GET /api/v1/notification-methods`

The delivery methods this build understands

Each carries the JSON Schema its settings are validated against, which is also what a UI builds the form from. Fields marked `writeOnly` are credentials: they are accepted, stored and used, and never returned by any route, to anyone.

**200** { items }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `items` | [ms:notificationMethod](#schema-ms-notificationmethod)[] | **required** |  |

### `GET /api/v1/summarisation-modes`

How eagerly a template may send during a storm

The six modes of `CAPABILITIES.MD §5.2`. The distinction that matters is between the *first* modes and the *all* modes: "first Down immediately" turns a forty-sensor outage into one message and a digest, while "all Downs immediately" sends forty. A method whose `summarisable` is false ignores all of this and is stored as `always-immediate`.

**200** { items, default }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `items` | [ms:summarisationMode](#schema-ms-summarisationmode)[] | **required** |  |
| `default` | string | **required** |  |

### `GET /api/v1/notification-placeholders`

The placeholders a template’s subject and body may use

Case-insensitive: `%Sensor` and `%SENSOR` are `%sensor`. A name this build does not know is refused when the template is saved rather than blanked when it is sent — a message that quietly loses a fact reads perfectly and says nothing. Write `%%` for a literal per cent sign.

**200** { items }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `items` | [ms:placeholder](#schema-ms-placeholder)[] | **required** |  |

### `GET /api/v1/templates`

Every notification template

**200** { items }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `items` | [ms:template](#schema-ms-template)[] | **required** |  |

### `POST /api/v1/templates`

Create a template

Only an administrator may name an account or a group as a recipient (`M-20`); anybody else gets 403 `AUTH_FORBIDDEN` for one, and may name addresses (`A-44`).

**Body** — [ms:templateInput](#schema-ms-templateinput)

**201** { id, name, description, method, methodName, settings, redactedSettings, subject, body, recipients, priority, enabled, summary, summarisable, summarisation, summaryWindowSeconds, scheduleId, scheduleName, whenInactive, createdAt, updatedAt }

**201** is [ms:template](#schema-ms-template)

### `GET /api/v1/templates/{id}`

One template

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, at least 1 | **required** |

**200** { id, name, description, method, methodName, settings, redactedSettings, subject, body, recipients, priority, enabled, summary, summarisable, summarisation, summaryWindowSeconds, scheduleId, scheduleName, whenInactive, createdAt, updatedAt }

**200** is [ms:template](#schema-ms-template)

### `PUT /api/v1/templates/{id}`

Replace a template

Whole-document, with one exception: a secret the request does not carry is **kept**, because the form it came from was rendered without it. Send an explicit `null` to clear one. **A secret is kept only while it goes where it went:** a request that changes a webhook's `url`, or a program's `path` or any of its `args`, clears the secrets sent there unless it carries them again, so re-pointing a template never sends a token somebody else set to a new destination. A field left out counts as its default: a program with no `args` keeps its `secretArgs` through an edit that sends none. **Only an administrator may add an account or a group recipient** (`M-20`, `A-44`): anybody else may keep or remove the ones the template has, and gets 403 `AUTH_FORBIDDEN` for one it did not have.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, at least 1 | **required** |

**Body** — [ms:templateInput](#schema-ms-templateinput)

**200** { id, name, description, method, methodName, settings, redactedSettings, subject, body, recipients, priority, enabled, summary, summarisable, summarisation, summaryWindowSeconds, scheduleId, scheduleName, whenInactive, createdAt, updatedAt }

**200** is [ms:template](#schema-ms-template)

### `DELETE /api/v1/templates/{id}`

Remove a template

Refused while a trigger still names it, with the list of triggers to fix: deleting one out from under a trigger would leave that trigger firing into nothing. **Only triggers on objects the caller can see are listed or counted** (`A-16`); `details.outsideView` is true when others outside the caller’s view use it too, and says nothing of how many. An administrator is shown every one.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, at least 1 | **required** |

**200** { id, deleted }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `id` | integer | **required** |  |
| `deleted` | boolean | **required** |  |

### `GET /api/v1/templates/{id}/used-by`

Which triggers name this template

`CAPABILITIES.MD §5.2`’s reverse lookup, and the reason a delete can be refused with a list rather than a shrug. A trigger names its templates inside a JSON document, so no foreign key can enforce the reference — this is the query that stands in for one. Only triggers on objects the caller can read are listed.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, at least 1 | **required** |

**200** { templateId, items }

**200** is [ms:templateUsedBy](#schema-ms-templateusedby)

### `GET /api/v1/templates/{id}/preview`

What this template would say about one sensor, right now

Rendered against the sensor’s actual state, not an invented one. An operator writing `%device / %sensor: %lastmessage` has no way to know whether that reads well until they see it against something real, and finding out from the first genuine outage is finding out too late. Nothing is sent and nothing is written.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `sensorId` | query | integer, at least 1 | **required** |
| `id` | path | integer, at least 1 | **required** |

**200** { templateId, sensorId, subject, body, unknown }

**200** is [ms:templatePreview](#schema-ms-templatepreview)

### `POST /api/v1/templates/preview`

What an unsaved draft would say about one sensor

The same rendering as the saved preview, against a template that does not exist yet — what an editor needs to show the text in the box rather than the text on disk (`U-10`). The draft goes through the same validation a write does, so one that could not be saved is refused here rather than previewing something the operator cannot keep. Nothing is sent, nothing is written, and no template is created.

**Body**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `template` | [ms:templateInput](#schema-ms-templateinput) | **required** |  |
| `sensorId` | integer, at least 1 | **required** |  |

**200** { templateId, sensorId, subject, body, unknown }

**200** is [ms:templatePreview](#schema-ms-templatepreview)

### `POST /api/v1/templates/{id}/test`

Send a test notification through this template

**This really sends.** The same rendering, the same transport, the same settings and the same recipients — testing an on-call template at three in the morning pages whoever is on call, which is why it is written to the audit log. What it skips is the queue: nothing is retried, summarised or suppressed by an activation schedule, because those would each turn "did my relay work" into "wait fifteen minutes and find out". `notes` reports what a real notification would have run into instead, so a green test on a template that is switched off cannot be mistaken for a working alarm. Without `sensorId` the message is rendered against an example sensor, which is what an installation with no sensors yet needs. Anybody the template names and the send missed is named in `detail` or `error` for an administrator, and counted by reason for anybody else — `not sent to 2 recipients (1 disabled, 1 no email address)` — because the names are the account and group lists, which are an administrator’s (`A-44`). **`subject` and `body` are the message as the caller may read it** (`A-16`): `%probe`, `%group`, `%device` and `%host` for a container outside the caller’s view read `(outside your view)`, as in a preview, and `notes` says so. What is sent is the real message.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, at least 1 | **required** |

**Body**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `sensorId` | integer, at least 1 |  |  |

**200** { templateId, templateName, method, methodName, sensorId, sensorName, subject, body, recipients, unknownPlaceholders, delivered, detail, error, retryable, durationMs, notes }

**200** is [ms:templateTestResult](#schema-ms-templatetestresult)

## triggers

### `GET /api/v1/trigger-kinds`

The kinds of trigger this build understands

Each carries the JSON Schema its settings are validated against, which is also what a UI builds the form from — one declaration rather than a form and a validator that can disagree.

**200** { items }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `items` | [ms:triggerKind](#schema-ms-triggerkind)[] | **required** |  |

### `GET /api/v1/objects/{id}/triggers`

Every trigger in effect on an object, its own first

Own and inherited together, nearest first, each naming the object it is defined on — which is the only place it can be edited or removed. A trigger on the root applies to every sensor in the installation. Unlike an inherited *setting*, an inherited trigger does not displace a nearer one: both fire. A trigger inherited from an object the caller cannot see is still listed, because it still fires — with that object’s name null.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, at least 1 | **required** |

**200** { objectId, items }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `objectId` | integer | **required** |  |
| `items` | [ms:trigger](#schema-ms-trigger)[] | **required** |  |

### `POST /api/v1/objects/{id}/triggers`

Add a trigger to an object

The settings are validated against the kind’s own schema, with its defaults filled in — so a state trigger with only a state is a complete trigger that notifies immediately and never escalates.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, at least 1 | **required** |

**Body** — [ms:triggerInput](#schema-ms-triggerinput)

**201** { id, kind, kindName, settings, enabled, summary, inherited, definedOn, createdAt, updatedAt }

**201** is [ms:trigger](#schema-ms-trigger)

### `PUT /api/v1/triggers/{id}`

Replace a trigger

Whole-document: a latency without the notification it delays is not half a trigger, it is a broken one.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, at least 1 | **required** |

**Body** — [ms:triggerInput](#schema-ms-triggerinput)

**200** { id, kind, kindName, settings, enabled, summary, inherited, definedOn, createdAt, updatedAt }

**200** is [ms:trigger](#schema-ms-trigger)

### `DELETE /api/v1/triggers/{id}`

Remove a trigger

From the object it is defined on. Deleting an inherited trigger means deleting it where it lives, which the effective set names.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer, at least 1 | **required** |

**200** { id, deleted }

**200 response**

| Field | Type | | Description |
| --- | --- | --- | --- |
| `id` | integer | **required** |  |
| `deleted` | boolean | **required** |  |

---

## Schemas

The shapes routes share, each declared once in the code and rendered once here.

<a id="schema-ms-acknowledgementview"></a>

### `ms:acknowledgementView`

| Field | Type | | Description |
| --- | --- | --- | --- |
| `objectId` | integer | **required** |  |
| `acknowledged` | integer[] | **required** |  |
| `refused` | integer[] | **required** |  |
| `skipped` | integer[] | **required** |  |
| `acknowledgedAt` | string | **required** nullable |  |
| `acknowledgedUntil` | string | **required** nullable |  |
| `message` | string | **required** |  |

<a id="schema-ms-alarm"></a>

### `ms:alarm`

| Field | Type | | Description |
| --- | --- | --- | --- |
| `sensorId` | integer | **required** |  |
| `sensorName` | string | **required** |  |
| `state` | `unknown` · `up` · `warning` · `down` · `down_acknowledged` · `down_partial` · `unusual` · `paused` | **required** | The sensor's state now. For a held return (`recovering` is not null) that is the state it came back to, usually `up`; `recovering` is a `state` filter value, not a state. |
| `cause` | `scan` · `limit` · `lookup` · `user` · `schedule` · `dependency` · `parent` · `probe` · `access` · `simulated` | **required** | What put the sensor in that state. |
| `message` | string | **required** |  |
| `since` | string | **required** |  |
| `priority` | integer | **required** |  |
| `path` | integer[] | **required** |  |
| `pathNames` | string[] | **required** |  |
| `acknowledged` | boolean | **required** |  |
| `acknowledgedUntil` | string | **required** nullable |  |
| `consecutiveFailures` | integer | **required** |  |
| `recovering` | object | **required** nullable | The return its alarm is holding (`M-18`), or null. `confirmsAt` is when the alarm is over if the sensor does not fail again. |
| `recovering.since` | string | **required** |  |
| `recovering.confirmsAt` | string | **required** nullable |  |

<a id="schema-ms-alarmpage"></a>

### `ms:alarmPage`

| Field | Type | | Description |
| --- | --- | --- | --- |
| `items` | [ms:alarm](#schema-ms-alarm)[] | **required** |  |
| `total` | integer | **required** |  |
| `counts` | map of integer | **required** |  |
| `counts.*` | integer |  |  |
| `now` | string | **required** | The core's clock when the list was read. A held return's end is not a state change, so a client that wants to see it go asks again at `confirmsAt`, measured from this. |

<a id="schema-ms-auditactor"></a>

### `ms:auditActor`

one of 4 shapes, by `kind`

| Field | Type | | Description |
| --- | --- | --- | --- |
| `{kind=user}` | object |  |  |
| `{kind=user}.kind` | `user` | **required** |  |
| `{kind=user}.userId` | integer | **required** |  |
| `{kind=user}.login` | string | **required** |  |
| `{kind=token}` | object |  |  |
| `{kind=token}.kind` | `token` | **required** |  |
| `{kind=token}.tokenId` | integer | **required** |  |
| `{kind=system}` | object |  |  |
| `{kind=system}.kind` | `system` | **required** |  |
| `{kind=system}.component` | string | **required** |  |
| `{kind=anonymous}` | object |  |  |
| `{kind=anonymous}.kind` | `anonymous` | **required** |  |
| `{kind=anonymous}.remoteAddress` | string | **required** |  |

<a id="schema-ms-auditentry"></a>

### `ms:auditEntry`

| Field | Type | | Description |
| --- | --- | --- | --- |
| `id` | string | **required** |  |
| `at` | string | **required** |  |
| `action` | string | **required** |  |
| `objectId` | integer | **required** nullable |  |
| `objectKind` | `root` · `probe` · `group` · `device` · `sensor` | **required** nullable |  |
| `actor` | [ms:auditActor](#schema-ms-auditactor) | **required** |  |
| `summary` | object | **required** |  |
| `diff` | object[] | **required** |  |
| `diff[].field` | string | **required** |  |
| `diff[].before` | any | **required** |  |
| `diff[].after` | any | **required** |  |

<a id="schema-ms-auditpage"></a>

### `ms:auditPage`

| Field | Type | | Description |
| --- | --- | --- | --- |
| `items` | [ms:auditEntry](#schema-ms-auditentry)[] | **required** |  |
| `nextBefore` | string | **required** nullable |  |

<a id="schema-ms-channellimits"></a>

### `ms:channelLimits`

| Field | Type | | Description |
| --- | --- | --- | --- |
| `enabled` | boolean | **required** |  |
| `upperError` | number | **required** nullable |  |
| `upperWarning` | number | **required** nullable |  |
| `lowerWarning` | number | **required** nullable |  |
| `lowerError` | number | **required** nullable |  |
| `errorMessage` | string | **required** |  |
| `warningMessage` | string | **required** |  |

<a id="schema-ms-channelrecord"></a>

### `ms:channelRecord`

| Field | Type | | Description |
| --- | --- | --- | --- |
| `id` | integer | **required** |  |
| `sensorId` | integer | **required** |  |
| `key` | string | **required** |  |
| `name` | string | **required** |  |
| `unit` | string | **required** |  |
| `isPrimary` | boolean | **required** |  |
| `scaleMul` | string | **required** |  |
| `scaleDiv` | string | **required** |  |
| `decimals` | integer | **required** nullable |  |
| `limits` | [ms:channelLimits](#schema-ms-channellimits) | **required** |  |
| `spikeMin` | number | **required** nullable |  |
| `spikeMax` | number | **required** nullable |  |
| `showInGraph` | boolean | **required** |  |
| `showInTable` | boolean | **required** |  |
| `lookupId` | string | **required** nullable |  |
| `retired` | boolean | **required** | Nothing will read this channel again: the sensor’s type declares every channel it reports, and the sensor’s parameters no longer declare this one (an edit took it out), and it has no reading newer than the sensor’s last change, which a probe running a newer build than the core could still send. A reading is timed by the probe’s clock, so after each change such a channel can read `true` for one scan interval plus however far that probe’s clock runs behind the core’s database. Its history is kept, and putting it back makes it live again. Worked out from the type on every read. `false` also where the type cannot say: one whose readings can name channels it does not declare, such as a script’s. |

<a id="schema-ms-channelvalue"></a>

### `ms:channelValue`

| Field | Type | | Description |
| --- | --- | --- | --- |
| `id` | integer | **required** |  |
| `key` | string | **required** |  |
| `name` | string | **required** |  |
| `unit` | string | **required** |  |
| `decimals` | integer | **required** nullable |  |
| `value` | number | **required** nullable |  |
| `at` | string | **required** nullable |  |

<a id="schema-ms-checkchannel"></a>

### `ms:checkChannel`

| Field | Type | | Description |
| --- | --- | --- | --- |
| `key` | string | **required** |  |
| `value` | number | **required** |  |
| `name` | string |  |  |
| `unit` | string |  |  |
| `counter` | string |  |  |
| `counterBits` | integer |  |  |

<a id="schema-ms-checkresult"></a>

### `ms:checkResult`

| Field | Type | | Description |
| --- | --- | --- | --- |
| `sensorId` | integer | **required** |  |
| `at` | string | **required** |  |
| `outcome` | `ok` · `error` | **required** |  |
| `message` | string | **required** |  |
| `durationMs` | number | **required** |  |
| `channels` | [ms:checkChannel](#schema-ms-checkchannel)[] | **required** |  |
| `stored` | boolean | **required** |  |

<a id="schema-ms-cloneresult"></a>

### `ms:cloneResult`

| Field | Type | | Description |
| --- | --- | --- | --- |
| `object` | [ms:objectDetail](#schema-ms-objectdetail) | **required** |  |
| `grantsNotCarried` | integer, at least 0 | **required** | How many positive grants on what was copied the copy did not carry, because only a caller who may grant (the admin role with full scope) carries them (`A-76`). Anybody else’s copy carries each `none`, and each `read` that narrows what its group holds where the copy landed, and no other group’s `write` or `full`. This counts the `write` and `full` grants left behind. A `read` left behind because it would widen where the copy landed is not counted, since whether it would depends on grants there the caller may not read. Every grant left behind is in the copy’s history as `grant.notCarried`. Always 0 for a caller who may grant, whose copy carries every grant. |
| `clonedCount` | object | **required** |  |
| `clonedCount.group` | integer | **required** |  |
| `clonedCount.device` | integer | **required** |  |
| `clonedCount.sensor` | integer | **required** |  |
| `clonedCount.channel` | integer | **required** |  |
| `clonedCount.setting` | integer | **required** |  |
| `clonedCount.trigger` | integer | **required** | Notification triggers copied with the objects that own them (`P-141`). The clone already carried the trigger *fence* and none of the triggers behind it, so a cloned object with the fence up notified nobody and looked identical to one that did. |
| `clonedCount.total` | integer | **required** |  |
| `droppedCredentialKinds` | (`snmp` · `windows` · `ssh` · `vmware` · `database` · `http` · `mail`)[] | **required** |  |
| `settingsChanged` | object[] | **required** |  |
| `settingsChanged[].key` | string | **required** |  |
| `settingsChanged[].before` | [ms:resolvedSetting](#schema-ms-resolvedsetting) | **required** |  |
| `settingsChanged[].after` | [ms:resolvedSetting](#schema-ms-resolvedsetting) | **required** |  |

<a id="schema-ms-createobject"></a>

### `ms:createObject`

| Field | Type | | Description |
| --- | --- | --- | --- |
| `kind` | `probe` · `group` · `device` · `sensor` | **required** |  |
| `parentId` | integer | **required** |  |
| `name` | string, 1–500 characters | **required** |  |
| `tags` | string[], at most 50 items, each 1–100 characters |  |  |
| `priority` | integer, 1–5 |  |  |
| `comments` | string, at most 10000 characters |  |  |
| `host` | string, 1–255 characters |  |  |
| `ipVersion` | `auto` · `v4` · `v6` |  |  |
| `sensorType` | string, at most 100 characters, matches `^[a-z0-9]+(\.[a-z0-9-]+)+$` |  |  |
| `params` | object |  |  |
| `gid` | string, 1–128 characters | nullable | Binds this probe branch to a connected probe. R-01 replaces setting it by hand with an enrolment flow; until then it is how a probe is told which subtree it owns. |

- when `kind` is `device`, `host` is required
- when `kind` is `sensor`, `sensorType` is required
- when `kind` is `probe` or `group`, neither `host` nor `sensorType` is allowed
- when `kind` is `group` or `device` or `sensor`, `gid` is not allowed
- when `kind` is `device`, `sensorType` is not allowed
- when `kind` is `sensor`, `host` is not allowed

<a id="schema-ms-createtree"></a>

### `ms:createTree`

| Field | Type | | Description |
| --- | --- | --- | --- |
| `parentId` | integer, at least 1 | **required** |  |
| `nodes` | [ms:treeNode](#schema-ms-treenode)[], 1–5000 items | **required** |  |

<a id="schema-ms-createtreeresult"></a>

### `ms:createTreeResult`

| Field | Type | | Description |
| --- | --- | --- | --- |
| `count` | integer | **required** |  |
| `objects` | object[] | **required** |  |
| `objects[].ref` | string |  |  |
| `objects[].id` | integer | **required** |  |
| `objects[].kind` | `root` · `probe` · `group` · `device` · `sensor` | **required** |  |

<a id="schema-ms-credentialview"></a>

### `ms:credentialView`

| Field | Type | | Description |
| --- | --- | --- | --- |
| `kind` | `snmp` · `windows` · `ssh` · `vmware` · `database` · `http` · `mail` | **required** |  |
| `publicParams` | object | **required** |  |
| `source` | [ms:settingSource](#schema-ms-settingsource) | **required** |  |
| `updatedAt` | string | **required** |  |
| `bounded` | boolean | **required** | Whether `allowedTargets`, or an SSH set's `hostKeys` with strict checking, bound where the set goes (`A-41b`). False means `write` on the object it is stored on is trust with it. |
| `secretsSet` | string[] |  | The names of the secret fields that hold a value, never the values (`U-21`). Only on a set stored on the object asked about, for its form to offer keep, replace and clear. |

<a id="schema-ms-credentialwrite"></a>

### `ms:credentialWrite`

| Field | Type | | Description |
| --- | --- | --- | --- |
| `kind` | `snmp` · `windows` · `ssh` · `vmware` · `database` · `http` · `mail` | **required** |  |
| `publicParams` | object | **required** |  |
| `source` | [ms:settingSource](#schema-ms-settingsource) | **required** |  |
| `updatedAt` | string | **required** |  |
| `bounded` | boolean | **required** | Whether `allowedTargets`, or an SSH set's `hostKeys` with strict checking, bound where the set goes (`A-41b`). False means `write` on the object it is stored on is trust with it. |
| `secretsSet` | string[] |  | The names of the secret fields that hold a value, never the values (`U-21`). Only on a set stored on the object asked about, for its form to offer keep, replace and clear. |
| `withholds` | integer, at least 0 | **required** | How many sensors beneath this set its allowed targets keep it from now, of those the caller can see: a sensor whose device's address is outside them, or whose device is entered by name where the targets are addresses and the sensor’s type cannot be held to an address its probe checked. They are not sent the set and read Unknown. Zero for a set with no targets. |
| `withheldBefore` | integer, at least 0 | **required** | Of the sensors this set reaches now and the caller can see, how many a set’s targets kept it from before this write (`A-55`): this set’s as it was, or an ancestor’s where this write stores the first set of the kind here. `withholds` is this, plus `newlyWithheld`, less `noLongerWithheld`. |
| `newlyWithheld` | integer, at least 0 | **required** | How many sensors this write puts outside (`A-55`): kept from the set after it and not before, of those the caller can see. What a narrowing takes to Unknown. |
| `noLongerWithheld` | integer, at least 0 | **required** | How many sensors this write brings back inside (`A-55`): kept from a set before it and sent this one after, of those the caller can see. |
| `byReason` | object | **required** | The four counts above for each of the two reasons a sensor is outside (`A-59`), over the same sensors the caller can see, so each count above is the sum of its two parts. A sensor outside after the write is counted for the reason that holds after it, and one outside before for the reason that held then, so a sensor that stays outside for another reason moves between the two without being newly outside. |
| `byReason.outside` | object | **required** | Sensors on a device whose address, or whose name, the allowed targets do not cover. |
| `byReason.outside.withholds` | integer, at least 0 | **required** |  |
| `byReason.outside.withheldBefore` | integer, at least 0 | **required** |  |
| `byReason.outside.newlyWithheld` | integer, at least 0 | **required** |  |
| `byReason.outside.noLongerWithheld` | integer, at least 0 | **required** |  |
| `byReason.unpinnable` | object | **required** | Sensors on a device entered by name, where the targets that could cover it are addresses and the sensor’s type cannot be held to an address its probe checked: the set is not sent whatever the name resolves to. |
| `byReason.unpinnable.withholds` | integer, at least 0 | **required** |  |
| `byReason.unpinnable.withheldBefore` | integer, at least 0 | **required** |  |
| `byReason.unpinnable.newlyWithheld` | integer, at least 0 | **required** |  |
| `byReason.unpinnable.noLongerWithheld` | integer, at least 0 | **required** |  |
| `secretsCleared` | string[] | **required** | The secrets this write cleared because it widened where the set may go and did not send them again. |

<a id="schema-ms-deliveryhealth"></a>

### `ms:deliveryHealth`

| Field | Type | | Description |
| --- | --- | --- | --- |
| `status` | `ok` · `warning` · `down` | **required** |  |
| `problems` | string[] | **required** |  |
| `pending` | integer | **required** |  |
| `parked` | integer | **required** |  |
| `retrying` | integer | **required** |  |
| `failed` | integer | **required** |  |
| `discarded` | integer | **required** |  |
| `oldestPendingAt` | string | **required** nullable |  |
| `oldestPendingAgeMs` | integer | **required** |  |
| `lastDeliveredAt` | string | **required** nullable |  |
| `windowMs` | integer | **required** |  |
| `staleAfterMs` | integer | **required** |  |
| `methods` | [ms:deliveryMethodHealth](#schema-ms-deliverymethodhealth)[] | **required** |  |

<a id="schema-ms-deliverymethodhealth"></a>

### `ms:deliveryMethodHealth`

| Field | Type | | Description |
| --- | --- | --- | --- |
| `method` | string | **required** |  |
| `pending` | integer | **required** |  |
| `parked` | integer | **required** |  |
| `retrying` | integer | **required** |  |
| `failed` | integer | **required** |  |
| `discarded` | integer | **required** |  |
| `oldestPendingAt` | string | **required** nullable |  |
| `lastDeliveredAt` | string | **required** nullable |  |
| `lastError` | string | **required** nullable |  |

<a id="schema-ms-discoveryrun"></a>

### `ms:discoveryRun`

| Field | Type | | Description |
| --- | --- | --- | --- |
| `id` | integer | **required** |  |
| `groupId` | integer | **required** |  |
| `probeId` | integer | **required** |  |
| `range` | string | **required** |  |
| `total` | integer | **required** |  |
| `cursor` | integer | **required** |  |
| `found` | integer | **required** |  |
| `failed` | integer | **required** |  |
| `status` | `queued` · `running` · `identifying` · `done` · `cancelled` · `failed` | **required** |  |
| `level` | `ping` · `standard` · `detailed` |  |  |
| `templates` | string[] |  |  |
| `identified` | integer |  |  |
| `scheduleId` | integer | nullable |  |
| `devicesCreated` | integer |  |  |
| `devicesMatched` | integer |  |  |
| `sensorsCreated` | integer |  |  |
| `provisionedAt` | string | nullable |  |
| `message` | string |  |  |
| `timeoutMs` | integer |  |  |
| `concurrency` | integer |  |  |
| `ratePerSecond` | number |  |  |
| `createdAt` | string |  |  |
| `startedAt` | string | nullable |  |
| `finishedAt` | string | nullable |  |

<a id="schema-ms-error"></a>

### `ms:error`

| Field | Type | | Description |
| --- | --- | --- | --- |
| `error` | object | **required** |  |
| `error.code` | string | **required** |  |
| `error.message` | string | **required** |  |
| `error.context` | object | **required** |  |
| `error.details` | object | **required** |  |
| `error.correlationId` | string |  |  |

<a id="schema-ms-historychannel"></a>

### `ms:historyChannel`

| Field | Type | | Description |
| --- | --- | --- | --- |
| `id` | integer | **required** |  |
| `key` | string | **required** |  |
| `name` | string | **required** |  |
| `unit` | string | **required** |  |
| `decimals` | integer | **required** nullable |  |
| `avg` | number[] | **required** |  |
| `min` | number[] | **required** |  |
| `max` | number[] | **required** |  |
| `count` | number[] | **required** |  |

<a id="schema-ms-library"></a>

### `ms:library`

| Field | Type | | Description |
| --- | --- | --- | --- |
| `id` | integer | **required** |  |
| `name` | string | **required** |  |
| `description` | string | **required** |  |
| `priority` | integer, 1–5 | **required** |  |
| `nodes` | [ms:libraryNode](#schema-ms-librarynode)[] | **required** |  |
| `version` | integer | **required** |  |
| `createdAt` | string (date-time) | **required** |  |
| `updatedAt` | string (date-time) | **required** |  |

<a id="schema-ms-libraryinput"></a>

### `ms:libraryInput`

| Field | Type | | Description |
| --- | --- | --- | --- |
| `name` | string, 1–100 characters | **required** |  |
| `description` | string, at most 1000 characters |  |  |
| `priority` | integer, 1–5 |  |  |
| `nodes` | [ms:libraryNode](#schema-ms-librarynode)[], at most 200 items |  |  |

<a id="schema-ms-librarynode"></a>

### `ms:libraryNode`

| Field | Type | | Description |
| --- | --- | --- | --- |
| `id` | string, matches `^[A-Za-z0-9_-]{1,40}$` | **required** |  |
| `name` | string, 1–100 characters | **required** |  |
| `rule` | object | nullable |  |
| `rule.roots` | integer[], at most 50 items, each at least 1 |  |  |
| `rule.types` | string[], at most 50 items, each matches `^[a-z0-9]+(\.[a-z0-9-]+)+$` |  |  |
| `rule.tags` | string[], at most 50 items, each 1–100 characters |  |  |
| `rule.states` | (`unknown` · `up` · `warning` · `down` · `down_acknowledged` · `down_partial` · `unusual` · `paused`)[], at most 8 items |  |  |
| `children` | [ms:libraryNode](#schema-ms-librarynode)[], at most 200 items |  |  |

<a id="schema-ms-lookupdetail"></a>

### `ms:lookupDetail`

| Field | Type | | Description |
| --- | --- | --- | --- |
| `id` | string | **required** |  |
| `name` | string | **required** |  |
| `description` | string | **required** |  |
| `type` | `singleInt` · `range` | **required** |  |
| `undefinedState` | `up` · `warning` · `down` | **required** |  |
| `entries` | object[] | **required** |  |
| `entries[].value` | number |  |  |
| `entries[].from` | number |  |  |
| `entries[].to` | number |  |  |
| `entries[].state` | `up` · `warning` · `down` | **required** |  |
| `entries[].text` | string | **required** |  |

<a id="schema-ms-lookupproblem"></a>

### `ms:lookupProblem`

| Field | Type | | Description |
| --- | --- | --- | --- |
| `id` | string | **required** |  |
| `source` | string | **required** | `built-in`, or the path of the file that was refused. |
| `problems` | string[] | **required** |  |

<a id="schema-ms-lookupsummary"></a>

### `ms:lookupSummary`

| Field | Type | | Description |
| --- | --- | --- | --- |
| `id` | string | **required** |  |
| `name` | string | **required** |  |
| `description` | string | **required** |  |
| `type` | `singleInt` · `range` | **required** |  |
| `undefinedState` | `up` · `warning` · `down` | **required** |  |
| `entryCount` | integer | **required** |  |
| `overridesBuiltIn` | boolean |  |  |
| `source` | string | **required** | `built-in`, or the path of the file the definition was read from. |

<a id="schema-ms-moveresult"></a>

### `ms:moveResult`

| Field | Type | | Description |
| --- | --- | --- | --- |
| `object` | [ms:objectDetail](#schema-ms-objectdetail) | **required** |  |
| `fromParentId` | integer | **required** |  |
| `toParentId` | integer | **required** |  |
| `movedCount` | integer | **required** |  |
| `probeChanged` | object | **required** nullable |  |
| `probeChanged.from` | object | **required** nullable |  |
| `probeChanged.from.id` | integer | **required** |  |
| `probeChanged.from.kind` | `root` · `probe` · `group` · `device` · `sensor` | **required** |  |
| `probeChanged.from.name` | string | **required** nullable |  |
| `probeChanged.to` | object | **required** nullable |  |
| `probeChanged.to.id` | integer | **required** |  |
| `probeChanged.to.kind` | `root` · `probe` · `group` · `device` · `sensor` | **required** |  |
| `probeChanged.to.name` | string | **required** nullable |  |
| `settingsChanged` | object[] | **required** |  |
| `settingsChanged[].key` | string | **required** |  |
| `settingsChanged[].before` | [ms:resolvedSetting](#schema-ms-resolvedsetting) | **required** |  |
| `settingsChanged[].after` | [ms:resolvedSetting](#schema-ms-resolvedsetting) | **required** |  |
| `credentialsChanged` | object[] | **required** |  |
| `credentialsChanged[].kind` | `snmp` · `windows` · `ssh` · `vmware` · `database` · `http` · `mail` | **required** |  |
| `credentialsChanged[].before` | `own` · `inherited` · `none` | **required** |  |
| `credentialsChanged[].after` | `own` · `inherited` · `none` | **required** |  |
| `exceptionsCleared` | integer, at least 0 | **required** | Devices whose exception to the target policy the move cleared because it took them to another probe (`A-64`). Only an administrator’s move does; anybody else’s is refused. |

<a id="schema-ms-notificationmethod"></a>

### `ms:notificationMethod`

| Field | Type | | Description |
| --- | --- | --- | --- |
| `id` | string | **required** |  |
| `name` | string | **required** |  |
| `description` | string | **required** |  |
| `settingsSchema` | object | **required** |  |
| `usesRecipients` | boolean | **required** |  |
| `summarisable` | boolean | **required** |  |

<a id="schema-ms-notificationrequest"></a>

### `ms:notificationRequest`

| Field | Type | | Description |
| --- | --- | --- | --- |
| `id` | integer | **required** |  |
| `at` | string | **required** |  |
| `sensorId` | integer | **required** |  |
| `sensorName` | string | **required** nullable |  |
| `templateId` | integer | **required** nullable |  |
| `templateName` | string | **required** nullable |  |
| `method` | string | **required** nullable |  |
| `triggerKind` | string | **required** | The kind of trigger that queued it, kept when the trigger is deleted: `state` or `threshold` in this version. Not an enum on purpose: one queued by a newer build is still listed after a downgrade. `GET /trigger-kinds` lists the kinds this build knows. |
| `reason` | `initial` · `escalation` · `repeat` · `recovery` · `threshold` · `clear` | **required** |  |
| `state` | `unknown` · `up` · `warning` · `down` · `down_acknowledged` · `down_partial` · `unusual` · `paused` | **required** |  |
| `message` | string | **required** |  |
| `status` | `pending` · `sent` · `failed` · `discarded` | **required** |  |
| `disposition` | `undecided` · `immediate` · `held` | **required** | Sent on its own (`immediate`) or folded into a digest (`held`); `undecided` until the template's summarisation has decided. |
| `attempts` | integer | **required** |  |
| `deliveredAt` | string | **required** nullable |  |
| `nextAttemptAt` | string | **required** nullable |  |
| `lastError` | string | **required** nullable |  |
| `skippedRecipients` | string |  | Who a message named and did not reach, and why — a disabled account, one with no address, one that may not see the sensor. Empty when it reached everybody (`M-19`). By name for an administrator; for anybody else, by count and reason only — `2 recipients (1 disabled, 1 may not see this sensor)` — because the names are the account and group lists, which are an administrator’s (`A-44`). |

<a id="schema-ms-objectdetail"></a>

### `ms:objectDetail`

| Field | Type | | Description |
| --- | --- | --- | --- |
| `id` | integer | **required** |  |
| `kind` | `root` · `probe` · `group` · `device` · `sensor` | **required** |  |
| `parentId` | integer | **required** nullable |  |
| `name` | string | **required** |  |
| `tags` | string[] | **required** |  |
| `priority` | integer | **required** |  |
| `comments` | string | **required** |  |
| `inheritsTriggers` | boolean | **required** |  |
| `version` | integer | **required** |  |
| `childCount` | integer | **required** |  |
| `createdAt` | string | **required** |  |
| `updatedAt` | string | **required** |  |
| `host` | string |  |  |
| `ipVersion` | `auto` · `v4` · `v6` |  |  |
| `targetPolicyException` | string[] |  |  |
| `gid` | string | nullable |  |
| `sensorType` | string |  |  |
| `params` | object |  |  |
| `redactedParams` | string[] |  |  |
| `settings` | [ms:settingView](#schema-ms-settingview)[] |  |  |
| `channels` | [ms:channelRecord](#schema-ms-channelrecord)[] |  |  |
| `credentials` | [ms:credentialView](#schema-ms-credentialview)[] |  |  |
| `ancestors` | [ms:objectRef](#schema-ms-objectref)[] |  |  |

<a id="schema-ms-objectref"></a>

### `ms:objectRef`

| Field | Type | | Description |
| --- | --- | --- | --- |
| `id` | integer | **required** |  |
| `kind` | `root` · `probe` · `group` · `device` · `sensor` | **required** |  |
| `name` | string | **required** |  |

<a id="schema-ms-objectsummary"></a>

### `ms:objectSummary`

| Field | Type | | Description |
| --- | --- | --- | --- |
| `id` | integer | **required** |  |
| `parentId` | integer | **required** nullable |  |
| `kind` | `root` · `probe` · `group` · `device` · `sensor` | **required** |  |
| `name` | string | **required** |  |
| `tags` | string[] | **required** |  |
| `priority` | integer | **required** |  |
| `version` | integer | **required** |  |
| `hasChildren` | boolean | **required** |  |
| `depth` | integer |  |  |
| `host` | string |  |  |
| `sensorType` | string |  |  |
| `state` | `unknown` · `up` · `warning` · `down` · `down_acknowledged` · `down_partial` · `unusual` · `paused` |  |  |
| `paused` | boolean |  |  |
| `effective` | map of [ms:resolvedSetting](#schema-ms-resolvedsetting) |  |  |
| `effective.*` | [ms:resolvedSetting](#schema-ms-resolvedsetting) |  |  |
| `path` | [ms:objectRef](#schema-ms-objectref)[] |  | Ancestors, root first, excluding the object. Only when asked for. |

<a id="schema-ms-pauseview"></a>

### `ms:pauseView`

| Field | Type | | Description |
| --- | --- | --- | --- |
| `objectId` | integer | **required** |  |
| `paused` | boolean | **required** |  |
| `pending` | boolean | **required** |  |
| `resumable` | boolean | **required** |  |
| `source` | `manual` · `parent` · `schedule` · `dependency` | **required** nullable |  |
| `pausedAt` | string | **required** nullable |  |
| `startsAt` | string | **required** nullable |  |
| `pausedUntil` | string | **required** nullable |  |
| `message` | string | **required** |  |
| `actor` | object | nullable |  |
| `actor.kind` | `user` · `token` · `system` · `anonymous` | **required** |  |
| `actor.label` | string | **required** nullable |  |
| `inheritedFrom` | object | **required** nullable |  |
| `inheritedFrom.objectId` | integer | **required** |  |
| `inheritedFrom.name` | string | **required** nullable |  |
| `schedule` | object | **required** nullable |  |
| `schedule.id` | integer | **required** |  |
| `schedule.name` | string | **required** |  |
| `schedule.active` | boolean | **required** |  |
| `schedule.nextChangeAt` | string | **required** nullable |  |
| `schedule.definedOn` | integer | **required** |  |
| `dependency` | object | **required** nullable |  |
| `dependency.masterId` | integer | **required** |  |
| `dependency.masterName` | string | **required** nullable |  |
| `dependency.masterState` | `unknown` · `up` · `warning` · `down` · `down_acknowledged` · `down_partial` · `unusual` · `paused` | **required** nullable |  |
| `dependency.holding` | boolean | **required** |  |
| `dependency.releasesAt` | string | **required** nullable |  |
| `dependency.definedOn` | integer | **required** |  |

<a id="schema-ms-placeholder"></a>

### `ms:placeholder`

| Field | Type | | Description |
| --- | --- | --- | --- |
| `name` | string | **required** |  |
| `description` | string | **required** |  |

<a id="schema-ms-queryadjustment"></a>

### `ms:queryAdjustment`

one of 2 shapes, by `kind`

| Field | Type | | Description |
| --- | --- | --- | --- |
| `{kind=range-shortened}` | object |  |  |
| `{kind=range-shortened}.kind` | `range-shortened` | **required** |  |
| `{kind=range-shortened}.reason` | string | **required** | A sentence for a person, naming the rule and its numbers. Free text: switch on `kind`. |
| `{kind=range-shortened}.requestedDays` | number | **required** |  |
| `{kind=range-shortened}.effectiveDays` | number | **required** |  |
| `{kind=resolution-coarsened}` | object |  |  |
| `{kind=resolution-coarsened}.kind` | `resolution-coarsened` | **required** |  |
| `{kind=resolution-coarsened}.reason` | string | **required** | A sentence for a person, naming the rule and its numbers. Free text: switch on `kind`. |
| `{kind=resolution-coarsened}.requestedSeconds` | integer | **required** |  |
| `{kind=resolution-coarsened}.effectiveSeconds` | integer | **required** |  |

<a id="schema-ms-resolvedsetting"></a>

### `ms:resolvedSetting`

| Field | Type | | Description |
| --- | --- | --- | --- |
| `key` | string | **required** |  |
| `value` | any | **required** |  |
| `source` | [ms:settingSource](#schema-ms-settingsource) | **required** |  |

<a id="schema-ms-schedule"></a>

### `ms:schedule`

| Field | Type | | Description |
| --- | --- | --- | --- |
| `id` | integer | **required** |  |
| `name` | string | **required** |  |
| `description` | string | **required** |  |
| `polarity` | `active` · `inactive` | **required** |  |
| `authoredAs` | `grid` · `periods` | **required** |  |
| `timezone` | string | **required** nullable |  |
| `effectiveTimezone` | string | **required** |  |
| `periods` | string | **required** |  |
| `grid` | (boolean[])[] | **required** |  |
| `gridIsExact` | boolean | **required** |  |
| `builtIn` | boolean | **required** |  |
| `active` | boolean | **required** |  |
| `nextChangeAt` | string (date-time) | **required** nullable |  |
| `usedBy` | integer | **required** |  |
| `createdAt` | string (date-time) | **required** |  |
| `updatedAt` | string (date-time) | **required** |  |

<a id="schema-ms-scheduleinput"></a>

### `ms:scheduleInput`

| Field | Type | | Description |
| --- | --- | --- | --- |
| `name` | string, 1–200 characters | **required** |  |
| `description` | string, at most 500 characters |  |  |
| `polarity` | `active` · `inactive` | default `active` |  |
| `timezone` | string, at most 80 characters | nullable |  |
| `periods` | string, at most 4000 characters |  |  |
| `grid` | (boolean[])[], exactly 7 items, each exactly 24 items |  |  |

<a id="schema-ms-sensorhistory"></a>

### `ms:sensorHistory`

| Field | Type | | Description |
| --- | --- | --- | --- |
| `sensorId` | integer | **required** |  |
| `from` | string | **required** |  |
| `to` | string | **required** |  |
| `resolutionSeconds` | integer | **required** |  |
| `bucketCount` | integer | **required** |  |
| `source` | `sample_1d` · `sample_1h` · `sample_5m` · `sample` | **required** | The table that served the bulk of the range: raw `sample`, or a rollup tier (`sample_5m`, `sample_1h`, `sample_1d`). |
| `segments` | object[] | **required** |  |
| `segments[].table` | `sample_1d` · `sample_1h` · `sample_5m` · `sample` | **required** |  |
| `segments[].from` | string | **required** |  |
| `segments[].to` | string | **required** |  |
| `adjustments` | [ms:queryAdjustment](#schema-ms-queryadjustment)[] | **required** |  |
| `buckets` | string[] | **required** |  |
| `channels` | [ms:historyChannel](#schema-ms-historychannel)[] | **required** |  |

<a id="schema-ms-sensorstate"></a>

### `ms:sensorState`

| Field | Type | | Description |
| --- | --- | --- | --- |
| `sensorId` | integer | **required** |  |
| `state` | `unknown` · `up` · `warning` · `down` · `down_acknowledged` · `down_partial` · `unusual` · `paused` | **required** |  |
| `cause` | `scan` · `limit` · `lookup` · `user` · `schedule` · `dependency` · `parent` · `probe` · `access` · `simulated` | **required** |  |
| `message` | string | **required** |  |
| `since` | string | **required** |  |
| `lastResultAt` | string | **required** nullable |  |
| `consecutiveFailures` | integer | **required** |  |
| `pausedBy` | (`parent` · `dependency` · `schedule` · `manual`)[] | **required** |  |
| `acknowledged` | boolean | **required** |  |
| `acknowledgedUntil` | string | nullable |  |
| `acknowledgedBy` | object | **required** nullable |  |
| `acknowledgedBy.kind` | `user` · `token` · `system` · `anonymous` | **required** |  |
| `acknowledgedBy.label` | string | **required** nullable |  |
| `simulatedError` | boolean | **required** |  |

<a id="schema-ms-sensorvalues"></a>

### `ms:sensorValues`

| Field | Type | | Description |
| --- | --- | --- | --- |
| `sensorId` | integer | **required** |  |
| `readAt` | string | **required** |  |
| `notBefore` | string | **required** |  |
| `intervalSeconds` | integer | **required** |  |
| `channels` | [ms:channelValue](#schema-ms-channelvalue)[] | **required** |  |

<a id="schema-ms-settingsource"></a>

### `ms:settingSource`

one of 3 shapes, by `kind`

| Field | Type | | Description |
| --- | --- | --- | --- |
| `{kind=own}` | object |  |  |
| `{kind=own}.kind` | `own` | **required** |  |
| `{kind=own}.objectId` | integer | **required** |  |
| `{kind=inherited}` | object |  |  |
| `{kind=inherited}.kind` | `inherited` | **required** |  |
| `{kind=inherited}.objectId` | integer | **required** |  |
| `{kind=inherited}.depth` | integer | **required** |  |
| `{kind=default}` | object |  |  |
| `{kind=default}.kind` | `default` | **required** |  |

<a id="schema-ms-settingview"></a>

### `ms:settingView`

| Field | Type | | Description |
| --- | --- | --- | --- |
| `key` | string | **required** |  |
| `description` | string | **required** |  |
| `schema` | object | **required** |  |
| `effective` | object | **required** |  |
| `effective.value` | any | **required** |  |
| `effective.source` | [ms:settingSource](#schema-ms-settingsource) | **required** |  |
| `inherited` | object | **required** |  |
| `inherited.value` | any | **required** |  |
| `inherited.source` | [ms:settingSource](#schema-ms-settingsource) | **required** |  |
| `own` | object | **required** nullable |  |
| `own.value` | any | **required** |  |

<a id="schema-ms-simulatederrorview"></a>

### `ms:simulatedErrorView`

| Field | Type | | Description |
| --- | --- | --- | --- |
| `objectId` | integer | **required** |  |
| `simulated` | boolean | **required** |  |
| `sensors` | integer[] | **required** |  |
| `skipped` | integer[] | **required** |  |
| `message` | string | **required** |  |

<a id="schema-ms-statelogentry"></a>

### `ms:stateLogEntry`

| Field | Type | | Description |
| --- | --- | --- | --- |
| `at` | string | **required** |  |
| `sensorId` | integer | **required** |  |
| `sensorName` | string | **required** |  |
| `state` | `unknown` · `up` · `warning` · `down` · `down_acknowledged` · `down_partial` · `unusual` · `paused` | **required** |  |
| `previousState` | `unknown` · `up` · `warning` · `down` · `down_acknowledged` · `down_partial` · `unusual` · `paused` | **required** nullable |  |
| `cause` | `scan` · `limit` · `lookup` · `user` · `schedule` · `dependency` · `parent` · `probe` · `access` · `simulated` | **required** |  |
| `message` | string | **required** |  |
| `durationMs` | integer | **required** nullable |  |
| `carried` | boolean | **required** |  |

<a id="schema-ms-statelogpage"></a>

### `ms:stateLogPage`

| Field | Type | | Description |
| --- | --- | --- | --- |
| `items` | [ms:stateLogEntry](#schema-ms-statelogentry)[] | **required** |  |
| `nextBefore` | string | **required** nullable |  |

<a id="schema-ms-summarisationmode"></a>

### `ms:summarisationMode`

| Field | Type | | Description |
| --- | --- | --- | --- |
| `id` | string | **required** |  |
| `description` | string | **required** |  |

<a id="schema-ms-template"></a>

### `ms:template`

| Field | Type | | Description |
| --- | --- | --- | --- |
| `id` | integer | **required** |  |
| `name` | string | **required** |  |
| `description` | string | **required** |  |
| `method` | string | **required** |  |
| `methodName` | string | **required** |  |
| `settings` | object | **required** |  |
| `redactedSettings` | string[] | **required** |  |
| `subject` | string | **required** |  |
| `body` | string | **required** |  |
| `recipients` | object[] | **required** |  |
| `recipients[].kind` | `address` · `user` · `userGroup` | **required** |  |
| `recipients[].value` | string, 1–320 characters | **required** |  |
| `priority` | integer | **required** |  |
| `enabled` | boolean | **required** |  |
| `summary` | string | **required** |  |
| `summarisable` | boolean | **required** |  |
| `summarisation` | `always-immediate` · `first-down` · `first-down-and-up` · `downs-immediate` · `downs-and-ups-immediate` · `always-summarise` | **required** |  |
| `summaryWindowSeconds` | integer | **required** |  |
| `scheduleId` | integer | **required** nullable |  |
| `scheduleName` | string | **required** nullable |  |
| `whenInactive` | `queue` · `discard` | **required** |  |
| `createdAt` | string | **required** |  |
| `updatedAt` | string | **required** |  |

<a id="schema-ms-templateinput"></a>

### `ms:templateInput`

| Field | Type | | Description |
| --- | --- | --- | --- |
| `name` | string, 1–200 characters | **required** |  |
| `description` | string, at most 1000 characters |  |  |
| `method` | string, 1–40 characters | **required** |  |
| `settings` | object | **required** |  |
| `subject` | string, at most 500 characters |  |  |
| `body` | string, at most 20000 characters |  |  |
| `recipients` | object[], at most 200 items |  |  |
| `recipients[].kind` | `address` · `user` · `userGroup` | **required** |  |
| `recipients[].value` | string, 1–320 characters | **required** |  |
| `priority` | integer, 1–5 |  |  |
| `enabled` | boolean |  |  |
| `summarisation` | `always-immediate` · `first-down` · `first-down-and-up` · `downs-immediate` · `downs-and-ups-immediate` · `always-summarise` |  |  |
| `summaryWindowSeconds` | integer, 60–86400 |  |  |
| `scheduleId` | integer, at least 1 | nullable |  |
| `whenInactive` | `queue` · `discard` |  |  |

<a id="schema-ms-templatepreview"></a>

### `ms:templatePreview`

| Field | Type | | Description |
| --- | --- | --- | --- |
| `templateId` | integer | **required** nullable |  |
| `sensorId` | integer | **required** |  |
| `subject` | string | **required** |  |
| `body` | string | **required** |  |
| `unknown` | string[] | **required** |  |

<a id="schema-ms-templatetestresult"></a>

### `ms:templateTestResult`

| Field | Type | | Description |
| --- | --- | --- | --- |
| `templateId` | integer | **required** |  |
| `templateName` | string | **required** |  |
| `method` | string | **required** |  |
| `methodName` | string | **required** |  |
| `sensorId` | integer | **required** nullable |  |
| `sensorName` | string | **required** |  |
| `subject` | string | **required** |  |
| `body` | string | **required** |  |
| `recipients` | object[] | **required** |  |
| `recipients[].kind` | `address` · `user` · `userGroup` | **required** |  |
| `recipients[].value` | string, 1–320 characters | **required** |  |
| `unknownPlaceholders` | string[] | **required** |  |
| `delivered` | boolean | **required** |  |
| `detail` | string | **required** nullable |  |
| `error` | string | **required** nullable |  |
| `retryable` | boolean | **required** nullable |  |
| `durationMs` | integer | **required** |  |
| `notes` | string[] | **required** |  |

<a id="schema-ms-templateusedby"></a>

### `ms:templateUsedBy`

| Field | Type | | Description |
| --- | --- | --- | --- |
| `templateId` | integer | **required** |  |
| `items` | object[] | **required** |  |
| `items[].triggerId` | integer | **required** |  |
| `items[].triggerKind` | string | **required** | One of the ids `GET /trigger-kinds` lists. A trigger of a kind this build does not know cannot be read for the templates it names, so it is not listed here. |
| `items[].objectId` | integer | **required** |  |
| `items[].objectName` | string | **required** |  |
| `items[].summary` | string | **required** |  |

<a id="schema-ms-treenode"></a>

### `ms:treeNode`

| Field | Type | | Description |
| --- | --- | --- | --- |
| `kind` | `probe` · `group` · `device` · `sensor` | **required** |  |
| `ref` | string, 1–128 characters |  | A handle for this node, unique in the request, so later nodes can hang off it. |
| `parentRef` | string, 1–128 characters |  | The `ref` of this node’s parent. Absent means the request’s own `parentId`. |
| `name` | string, 1–500 characters | **required** |  |
| `tags` | string[], at most 50 items, each 1–100 characters |  |  |
| `priority` | integer, 1–5 |  |  |
| `comments` | string, at most 10000 characters |  |  |
| `host` | string, 1–255 characters |  |  |
| `ipVersion` | `auto` · `v4` · `v6` |  |  |
| `sensorType` | string, at most 100 characters, matches `^[a-z0-9]+(\.[a-z0-9-]+)+$` |  |  |
| `params` | object |  |  |
| `gid` | string, 1–128 characters | nullable |  |

- when `kind` is `device`, `host` is required
- when `kind` is `sensor`, `sensorType` is required
- when `kind` is `probe` or `group`, neither `host` nor `sensorType` is allowed
- when `kind` is `group` or `device` or `sensor`, `gid` is not allowed
- when `kind` is `device`, `sensorType` is not allowed
- when `kind` is `sensor`, `host` is not allowed

<a id="schema-ms-trigger"></a>

### `ms:trigger`

| Field | Type | | Description |
| --- | --- | --- | --- |
| `id` | integer | **required** |  |
| `kind` | string | **required** | One of the ids `GET /trigger-kinds` lists (`state` or `threshold` in this version), and not an enum on purpose: a trigger saved by a newer build is still listed after a downgrade, with `kindName` the kind itself and a `summary` saying this build does not know it, so that it can be found and deleted. |
| `kindName` | string | **required** |  |
| `settings` | object | **required** |  |
| `enabled` | boolean | **required** |  |
| `summary` | string | **required** |  |
| `inherited` | boolean | **required** |  |
| `definedOn` | object | **required** |  |
| `definedOn.objectId` | integer | **required** |  |
| `definedOn.name` | string | **required** nullable |  |
| `createdAt` | string | **required** |  |
| `updatedAt` | string | **required** |  |

<a id="schema-ms-triggerinput"></a>

### `ms:triggerInput`

| Field | Type | | Description |
| --- | --- | --- | --- |
| `kind` | string, 1–40 characters | **required** | One of the ids `GET /trigger-kinds` lists. Any other is refused with 400 `TRIGGER_INVALID`: a kind this build cannot validate is one it must not save. |
| `settings` | object | **required** |  |
| `enabled` | boolean | default `true` |  |

<a id="schema-ms-triggerkind"></a>

### `ms:triggerKind`

| Field | Type | | Description |
| --- | --- | --- | --- |
| `id` | string | **required** |  |
| `name` | string | **required** |  |
| `description` | string | **required** |  |
| `settingsSchema` | object | **required** |  |

<a id="schema-ms-updateobject"></a>

### `ms:updateObject`

| Field | Type | | Description |
| --- | --- | --- | --- |
| `kind` | `root` · `probe` · `group` · `device` · `sensor` | **required** |  |
| `name` | string, 1–500 characters |  |  |
| `tags` | string[], at most 50 items, each 1–100 characters |  |  |
| `priority` | integer, 1–5 |  |  |
| `comments` | string, at most 10000 characters |  |  |
| `inheritsTriggers` | boolean |  |  |
| `host` | string, 1–255 characters |  |  |
| `ipVersion` | `auto` · `v4` · `v6` |  |  |
| `params` | object |  |  |
| `gid` | string, 1–128 characters | nullable |  |

- at least 2 fields must be given
- when `kind` is `root` or `probe` or `group`, neither `host` nor `params` is allowed
- when `kind` is `root` or `group` or `device` or `sensor`, `gid` is not allowed
- when `kind` is `device`, `params` is not allowed
- when `kind` is `sensor`, neither `host` nor `ipVersion` is allowed
