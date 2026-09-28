# MonitoringSystem API reference

**Generated from the OpenAPI document by `scripts/docs/api-reference.mjs`. Do not edit.** Every route is declared with a JSON Schema that Fastify validates against, so this is a rendering of what runs rather than a description of it, and `packages/core/test/build-hygiene.test.ts` fails when the two disagree.

The live document is at `GET /api/v1/openapi.json` on any running installation, and is the one to feed to a client generator. This page is for reading.

164 routes.

## Conventions

- **Everything is under `/api/v1`.** The version is in the path and will change only for a breaking change.
- **Authentication** is a session cookie or an API token in `Authorization: Bearer`. Token rights are the account's rights, never more.
- **Writes need the CSRF header** when they authenticate by cookie — see `docs/administration.md`.
- **Errors** share one shape: `{ error: { code, message } }`, with the code taken from a fixed set (`OBJECT_INVALID`, `NOT_FOUND`, `CONFLICT`, `FORBIDDEN`, …) so a client can branch on it without matching on prose.
- **Credentials are never returned.** Parameters a sensor type marks `writeOnly` are stripped from every response in one place; reads carry `redactedParams` instead.
- **Concurrent edits** use `If-Match` with the object's `version`; a stale one is `409`.
- **A body whose schema requires nothing may be left out.** It is read as `{}`, defaults and all. A body that is present has to be JSON: an empty one sent as `application/json` is a `400`.

---

## access

### `GET /api/v1/objects/{id}/access`

The grants sitting directly on this object

Only the explicit ones. What an account may actually do here is the *resolved* right, which walks the ancestors — see /objects/:id/access/effective.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer | **required** |

**200** { items }

### `GET /api/v1/objects/{id}/access/effective`

What an account may actually do with this object

Resolves the three rules — inheritance up the tree, explicit beats inherited, highest wins across groups — and reports where the winning grant came from, which is what makes a refusal debuggable. Without `userId` it answers about the calling account; asking about somebody else needs an administrator.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `userId` | query | integer |  |
| `id` | path | integer | **required** |

**200** { right, sourceObjectId, sourceGroupId, inherited, viaAdminGroup, cappedByRole, cappedByToken }

### `PUT /api/v1/objects/{id}/access/{groupId}`

Grant a group a right on this object

Replaces any grant this group already had here. Everything beneath inherits it, until something lower overrides it for the same group.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer | **required** |
| `groupId` | path | integer | **required** |

**Body**

| Field | Type | |
| --- | --- | --- |
| `right` | `none` · `read` · `write` · `full` | **required** |

**200** { items }

### `DELETE /api/v1/objects/{id}/access/{groupId}`

Remove a grant, so the object falls back to what it inherits

Not the same as granting `none`, which overrides inheritance rather than restoring it. An administrator needs both: one undoes a mistake, the other carves a hole in a branch somebody else has access to.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer | **required** |
| `groupId` | path | integer | **required** |

**200** { removed, items }

## audit

### `GET /api/v1/objects/{id}/audit`

An object's configuration history, newest first: who changed it, when, and what changed. Page with `before`, using the `nextBefore` from the previous page. Sensor parameters changed are listed in `summary.paramsChanged` by key. Values appear in `diff` for parameters the sensor type does not mark `writeOnly`; a credential never appears in either, in any entry, at any age. **Grant entries are an administrator's**, as the grants themselves are: `full` on an object does not let an account read who else may see it, so for anybody else they are left out and a page is still a full page of the rest.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `before` | query | string |  |
| `limit` | query | integer |  |
| `id` | path | integer | **required** |

**200** { items, nextBefore }

### `GET /api/v1/audit`

Configuration history across the whole installation, newest first — the object history third of the Logs view (`CAPABILITIES.MD §6`). Filter by `category` (the action's first segment), by `actorKind`, by time, or to one object. **`objectId` is that object exactly, never its subtree**: the entry most worth reading is the one recording a deletion, and an object that has been deleted has no parent left to be found through, so a subtree walk would drop precisely those. Page with `before`.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `objectId` | query | integer |  |
| `category` | query | object |  |
| `actorKind` | query | object |  |
| `actorRef` | query | string |  |
| `from` | query | string |  |
| `to` | query | string |  |
| `before` | query | string |  |
| `limit` | query | integer |  |

**200** { items, nextBefore }

## auth

### `POST /api/v1/auth/login`

Exchange a login and password for a session

Every failure answers 401 with the same code and the same sentence. Distinguishing "no such account" from "wrong password" would let a caller test which logins exist, and a login is half a credential — so which it was goes to the core log instead.

**Body**

| Field | Type | |
| --- | --- | --- |
| `login` | string | **required** |
| `password` | string | **required** |
| `code` | string |  |

**200** { userId, login, role, mustChangePassword }

### `POST /api/v1/auth/logout`

End the current session

Idempotent, and public: logging out with a session that has already expired is the ordinary case and must not answer 401, or a client can be stuck unable to clear it.

**204**

### `GET /api/v1/auth/me`

Who this session belongs to

**200** { userId, login, role, mustChangePassword }

### `GET /api/v1/auth/session`

Whether this installation needs a login, and whether this caller has one

Public, and the first call a browser client makes (`U-17`). `GET /auth/me` cannot answer this: it refuses an anonymous caller with 401, and a 401 from it means both "log in" and "this installation does not need you to" — with `api.requireAuthentication` off, an anonymous caller may use the whole API and still gets that 401 from this one route. A client unable to tell those apart has to choose between demanding a login the core does not want and rendering an application whose every request will be refused. Nothing is disclosed that an unauthenticated request does not already reveal by being answered or refused.

**200** { requireAuthentication, authenticated, principal }

### `GET /api/v1/auth/mfa`

Whether this account has, or needs, a second factor

`required` and `confirmed` are reported separately because the gap between them is the interesting state: an account a policy now demands MFA of, which has not set it up, has to be walked through enrolment before it can do anything.

**200** { enrolled, confirmed, required, recoveryCodesLeft }

### `POST /api/v1/auth/mfa/enrol`

Begin enrolment

Returns a secret and an otpauth:// URI for a QR code. **Nothing changes until the enrolment is confirmed with a code from the device** — an unconfirmed secret does nothing at all, which is what stops a mistyped setup locking somebody out.

**200** { secret, uri }

### `POST /api/v1/auth/mfa/confirm`

Confirm enrolment with a code, and receive recovery codes

The recovery codes are in this response and nowhere else, ever again. They exist because an installation that can only be entered with a device somebody is holding is one that a dropped phone takes down.

**Body**

| Field | Type | |
| --- | --- | --- |
| `code` | string | **required** |

**200** { recoveryCodes }

### `POST /api/v1/auth/mfa/disable`

Turn off multi-factor authentication

Needs the account password. Turning off a second factor from a session alone would make a stolen session enough to remove the thing protecting against stolen sessions.

**Body**

| Field | Type | |
| --- | --- | --- |
| `password` | string | **required** |

**204**

### `POST /api/v1/auth/mfa/recovery-codes`

Issue a fresh set of recovery codes

The previous set stops working immediately.

**200** { recoveryCodes }

### `POST /api/v1/auth/password`

Change your own password

Ends every *other* session this account holds. The reason somebody changes a password is usually that they think somebody else knows it, and leaving the sessions it opened is leaving the door they were worried about. The session making the change survives, so changing your password does not log you out of the tab you did it in.

**Body**

| Field | Type | |
| --- | --- | --- |
| `currentPassword` | string | **required** |
| `newPassword` | string | **required** |

**200** { endedSessions }

### `GET /api/v1/auth/tokens`

The API tokens this account holds

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `includeRevoked` | query | `true` · `false` |  |

**200** { items }

### `POST /api/v1/auth/tokens`

Issue an API token

The secret is in this response and nowhere else, ever again — only its hash is stored. A scope higher than the account’s own role is lowered to it rather than refused, because the request is coherent and the answer is simply "that is as much as you have".

**Body**

| Field | Type | |
| --- | --- | --- |
| `name` | string | **required** |
| `scope` | `none` · `read` · `write` · `full` |  |
| `expiresAt` | string |  |

**201** { token, secret }

### `DELETE /api/v1/auth/tokens/{id}`

Revoke one of this account’s tokens

Scoped to the caller’s own tokens: a token id is a small integer, and revoking somebody else’s would otherwise be one guess away.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer | **required** |

**204**

## channels

### `GET /api/v1/objects/{id}/channels`

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer | **required** |

**200** { items }

### `PATCH /api/v1/objects/{id}/channels/{key}`

Sets a channel’s error and warning limits, the lookup that decides its state, or both. `limits` is a patch: `null` clears one threshold, an absent field leaves it alone. Both are immediate — a reading past an error limit, or one a lookup maps to an error, sets the sensor Down on the very first sample with no two-step rule. A channel with a lookup is judged by it *instead of* its limits. Limits that contradict each other are refused with the reason; a `lookupId` this installation has not loaded is accepted and reported, because a sensor type may ship ahead of its lookup file. `processing` sets the scaling factors, the spike filter and the decimal places — scaling is applied before anything judges the reading, and before the spike filter, so both bounds and limits are numbers in the channel’s own unit. Changing a factor does not rewrite readings already stored, so the graph steps at the moment of the change.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer | **required** |
| `key` | path | string | **required** |

**Body**

| Field | Type | |
| --- | --- | --- |
| `limits` | object |  |
| `lookupId` | string,null |  |
| `processing` | object |  |

**200** { id, sensorId, key, name, unit, isPrimary, scaleMul, scaleDiv, decimals, limits, spikeMin, spikeMax, showInGraph, showInTable, lookupId }

## credentials

### `GET /api/v1/objects/{id}/credentials`

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `effective` | query | `true` · `false` |  |
| `id` | path | integer | **required** |

**200** { items }

### `GET /api/v1/credential-kinds`

The credential kinds this build can use, with the JSON Schema a form is generated from (`A-05`). Fields marked `writeOnly` are the secret half: they are encrypted at rest and **never returned by any route, to anyone**, so a form renders them as "set" with Replace and Clear rather than as a filled input. A kind absent from this list has no transport behind it yet, and storing a password nothing authenticates with is worse than not offering the field.

**200** { items }

### `PUT /api/v1/objects/{id}/credentials/{kind}`

Stores the credential set of this kind on this object, where everything below it inherits it (`CAPABILITIES.MD §10`). **A secret this omits is kept**, exactly as a sensor's `writeOnly` parameter is: a read never returns the value, so a client cannot send it back, and replacing the whole record would delete the community string every time somebody corrected the SNMP version beside it. Send the field with a value to rotate it, or `null` to remove it. The response carries no secret.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer | **required** |
| `kind` | path | string | **required** |

**Body**

| Field | Type | |
| --- | --- | --- |
| `values` | object | **required** |

**200** { kind, publicParams, source, updatedAt }

### `DELETE /api/v1/objects/{id}/credentials/{kind}`

Removes the credential set defined *on this object*. It does not leave the object without credentials: whatever an ancestor defines comes back into force, and the response says which, so removing a device-level community string tells you the group's one is now in use rather than leaving it to be discovered.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer | **required** |
| `kind` | path | string | **required** |

**200** { kind, removed, nowInherited }

## dependencies

### `PUT /api/v1/objects/{id}/dependency`

Sets what this object depends on. `parent` inherits from above, `object` names a master sensor, `none` depends on nothing, and `device` makes **this sensor** the master for its parent device — which is what auto-discovery sets on a Ping sensor, and what pauses the rest of a device when it stops answering. A master pauses its dependents only when it is genuinely Down or Down (Acknowledged); pausing a master by hand or by schedule does not. `delaySeconds` keeps dependents paused after the master recovers, so a flapping link does not alarm on every bounce. A dependency that would form a loop is refused: a loop of masters can never recover.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer | **required** |

**Body**

| Field | Type | |
| --- | --- | --- |
| `mode` | `parent` · `object` · `device` · `none` | **required** |
| `masterId` | integer |  |
| `delaySeconds` | integer |  |

**200** { objectId, paused, pending, resumable, source, pausedAt, startsAt, pausedUntil, message, actor, inheritedFrom, schedule, dependency }

## discovery

### `POST /api/v1/discovery/preview`

What a range means, and what each level would cost

Parses a range and estimates every level, so an operator picks one knowing what it costs rather than finding out. The same parser and the same level table the run uses, so a range that previews is a range that will start and an estimate is about the run that actually happens.

**Body**

| Field | Type | |
| --- | --- | --- |
| `range` | string | **required** |
| `timeoutMs` | integer |  |
| `concurrency` | integer |  |

**200** { range, total, levels }

### `POST /api/v1/discovery`

Start a discovery run

Sweeps a range from one probe into one group. The probe is named rather than chosen: discovery is a local-network job, so the probe that can reach 10.0.0.0/24 is the one on that network.

**Body**

| Field | Type | |
| --- | --- | --- |
| `groupId` | integer | **required** |
| `probeId` | integer | **required** |
| `range` | string | **required** |
| `timeoutMs` | integer |  |
| `concurrency` | integer |  |
| `ratePerSecond` | number |  |
| `level` | `ping` · `standard` · `detailed` |  |
| `templates` | string[] |  |
| `snmpCommunity` | string |  |

**201** { id, groupId, probeId, range, total, cursor, found, failed, status, level, templates, identified, scheduleId, devicesCreated, devicesMatched, sensorsCreated, provisionedAt, message, timeoutMs, concurrency, ratePerSecond, createdAt, startedAt, finishedAt }

### `GET /api/v1/discovery/{id}`

A run and how far it has got

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer | **required** |

**200** { id, groupId, probeId, range, total, cursor, found, failed, status, level, templates, identified, scheduleId, devicesCreated, devicesMatched, sensorsCreated, provisionedAt, message, timeoutMs, concurrency, ratePerSecond, createdAt, startedAt, finishedAt }

### `GET /api/v1/discovery/{id}/summary`

What a run did — scanned, found, created, errors

Derived from the run and its hosts rather than stored, so it cannot drift from what happened and a second provisioning pass updates it for free. `headline` is one sentence for the top of a page; everything under it is the same story precisely. The errors are here rather than behind a second request, because a run that created eleven devices and could not create two is exactly the case where somebody stops reading at the good number.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer | **required** |

**200** { runId, groupId, probeId, scheduleId, range, level, status, headline, scanned, found, created, errors, timing }

### `GET /api/v1/discovery/{id}/hosts`

The addresses a run found alive

In address order rather than the order they answered, because an operator reading a list of them is looking for gaps.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `limit` | query | integer |  |
| `id` | path | integer | **required** |

**200** { items }

### `POST /api/v1/discovery/{id}/cancel`

Stop a run

Recorded immediately and sent to the probe as well, so a cancel works even while the probe is disconnected — otherwise the sweep would resume the moment it came back.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer | **required** |

**200** { id, groupId, probeId, range, total, cursor, found, failed, status, level, templates, identified, scheduleId, devicesCreated, devicesMatched, sensorsCreated, provisionedAt, message, timeoutMs, concurrency, ratePerSecond, createdAt, startedAt, finishedAt }

### `POST /api/v1/discovery/{id}/provision`

Create the devices and sensors this run found

**Idempotent.** Devices are matched on address, then reverse name, then short name within the target group, and only sensors that are not already there are created — so running this twice creates nothing the second time. That matters because a discovery is re-run: on a schedule, or by an operator who has configured a credential and wants the sensors it unlocks.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer | **required** |

**200** { devicesCreated, matched, sensorsCreated, sensorsSkipped, mastersSet, problems, devices }

### `GET /api/v1/discovery/{id}/problems`

What a run could not create, and why

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer | **required** |

**200** { items }

### `GET /api/v1/objects/{id}/discovery`

What this group has been discovering, newest first

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `limit` | query | integer |  |
| `id` | path | integer | **required** |

**200** { items }

### `GET /api/v1/discovery/schedules`

Rediscovery schedules

Empty on almost every installation, because there is no schedule until somebody creates one and a new one is created **disabled**. Surprise objects are a support burden, and a monitoring system that invents devices on its own is one an operator stops trusting.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `groupId` | query | integer |  |

**200** { items }

### `POST /api/v1/discovery/schedules`

Create a rediscovery schedule

Created **disabled** unless `enabled` says otherwise, and with `autoProvision` off: a rediscovery then sweeps and identifies, and an operator reviews the plan at `GET /discovery/:id/plan` before anything is created. Turning `autoProvision` on is safe because provisioning is idempotent — it creates what has appeared since and nothing else.

**Body**

| Field | Type | |
| --- | --- | --- |
| `groupId` | integer | **required** |
| `probeId` | integer | **required** |
| `name` | string | **required** |
| `range` | string | **required** |
| `cadence` | `hourly` · `daily` · `weekly` | **required** |
| `cadenceMinute` | integer |  |
| `cadenceWeekday` | integer |  |
| `timezone` | string,null |  |
| `level` | `ping` · `standard` · `detailed` |  |
| `templates` | string[] |  |
| `snmpCommunity` | string |  |
| `timeoutMs` | integer |  |
| `concurrency` | integer |  |
| `ratePerSecond` | number |  |
| `autoProvision` | boolean |  |
| `scheduleId` | integer,null |  |
| `enabled` | boolean |  |

**201** { id, groupId, probeId, name, enabled, range, level, templates, timeoutMs, concurrency, ratePerSecond, cadence, cadenceMinute, cadenceWeekday, timezone, autoProvision, scheduleId, lastRunAt, lastRunId, lastProblem, nextRunAt, description, version }

### `POST /api/v1/discovery/schedules/{id}/enabled`

Turn a schedule on or off

Enabling computes the next run; disabling clears it, so a schedule that is off cannot be found by the sweep even if something else went wrong.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer | **required** |

**Body**

| Field | Type | |
| --- | --- | --- |
| `enabled` | boolean | **required** |

**200** { id, groupId, probeId, name, enabled, range, level, templates, timeoutMs, concurrency, ratePerSecond, cadence, cadenceMinute, cadenceWeekday, timezone, autoProvision, scheduleId, lastRunAt, lastRunId, lastProblem, nextRunAt, description, version }

### `PATCH /api/v1/discovery/schedules/{id}`

Change a schedule

`If-Match` carries the version the edit was made against (`W/"3"`, from the rule’s `version` or the `ETag` of the answer that returned it). Without it the request is refused with 428, and against a version that is no longer current with 412: two people editing one rule must not have the second silently undo the first. Whether it is on has its own route. The group cannot change — a rule in another group is another rule — and the probe must be the one the group is under. `snmpCommunity` left out keeps the stored one, and an empty one clears it; it is never returned. An edit that changes something clears `lastProblem`, and one that changes nothing keeps its version.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer | **required** |

**Body**

| Field | Type | |
| --- | --- | --- |
| `probeId` | integer |  |
| `name` | string |  |
| `range` | string |  |
| `cadence` | `hourly` · `daily` · `weekly` |  |
| `cadenceMinute` | integer |  |
| `cadenceWeekday` | integer |  |
| `timezone` | string,null |  |
| `level` | `ping` · `standard` · `detailed` |  |
| `templates` | string[] |  |
| `snmpCommunity` | string |  |
| `timeoutMs` | integer |  |
| `concurrency` | integer |  |
| `ratePerSecond` | number |  |
| `autoProvision` | boolean |  |
| `scheduleId` | integer,null |  |

**200** { id, groupId, probeId, name, enabled, range, level, templates, timeoutMs, concurrency, ratePerSecond, cadence, cadenceMinute, cadenceWeekday, timezone, autoProvision, scheduleId, lastRunAt, lastRunId, lastProblem, nextRunAt, description, version }

### `DELETE /api/v1/discovery/schedules/{id}`

Delete a schedule

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer | **required** |

**204**

### `GET /api/v1/device-templates`

Every device template, and anything that was refused

Refused templates are reported rather than hidden: one that failed to load creates none of the sensors it names, and nobody notices until the day one of them mattered.

**200** { items, problems }

### `GET /api/v1/device-templates/{templateId}`

One template, in full

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `templateId` | path | string | **required** |

**200** object

### `POST /api/v1/device-templates/plan`

What a fingerprint would produce

The answer `D-04` will act on, before it acts on it. Takes a fingerprint — one of the ones a discovery run recorded — and reports which templates matched and which sensors would actually be created, given the credential kinds available.

**Body**

| Field | Type | |
| --- | --- | --- |
| `fingerprint` | object | **required** |
| `credentials` | string[] |  |

**200** { templates, sensors, tags }

### `GET /api/v1/discovery/{id}/plan`

What a run’s hosts would produce

The whole run at once, which is what an operator wants to look at before letting `D-04` create anything. Hosts with no fingerprint yet are reported with the generic plan, because that is what they would get.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `credentials` | query | string |  |
| `limit` | query | integer |  |
| `id` | path | integer | **required** |

**200** { items }

### `POST /api/v1/objects/{id}/as-template`

A template file, from a device already set up

Returns the JSON to save under the template directory — it is not registered here, because a template is a file an operator edits and one source of truth is enough. **The match rule matches nothing until you fill it in**: only you know whether this is for this model, this vendor, or every switch, and a template that matched everything by accident would put this sensor set on every printer in the estate.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer | **required** |

**Body**

| Field | Type | |
| --- | --- | --- |
| `id` | string | **required** |
| `name` | string | **required** |
| `description` | string |  |
| `match` | object |  |

**200** object

## groups

### `GET /api/v1/groups`

Every user group, built-in ones first

**200** { items }

### `POST /api/v1/groups`

Create a user group

**Body**

| Field | Type | |
| --- | --- | --- |
| `name` | string | **required** |
| `description` | string |  |
| `isAdmin` | boolean |  |

**201** { id, name, description, isAdmin, isDefault, isBuiltin, memberCount }

### `PUT /api/v1/groups/{id}`

Rename a group, describe it, or change what it grants

A built-in group accepts only a description. Renaming Administrators or clearing its admin flag is a one-way door out of your own installation.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer | **required** |

**Body**

| Field | Type | |
| --- | --- | --- |
| `name` | string |  |
| `description` | string |  |
| `isAdmin` | boolean |  |

**200** { id, name, description, isAdmin, isDefault, isBuiltin, memberCount }

### `DELETE /api/v1/groups/{id}`

Delete a group

Members are not deleted with it, and anybody whose primary group this was is given another — a user with groups and no primary among them is a state object ownership has no answer for.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer | **required** |

**204**

### `GET /api/v1/groups/{id}/members`

Who is in this group

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer | **required** |

**200** { items }

### `PUT /api/v1/groups/{id}/members/{userId}`

Add an account to a group

Idempotent. The first group an account joins becomes its primary one; adding it to a second does not move that unless asked.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer | **required** |
| `userId` | path | integer | **required** |

**Body**

| Field | Type | |
| --- | --- | --- |
| `primary` | boolean |  |

**200** { items }

### `DELETE /api/v1/groups/{id}/members/{userId}`

Remove an account from a group

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer | **required** |
| `userId` | path | integer | **required** |

**200** { items }

### `GET /api/v1/accounts/{id}/groups`

Every group an account belongs to, primary first

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer | **required** |

**200** { items }

### `PUT /api/v1/accounts/{id}/primary-group/{groupId}`

Choose which of an account’s groups is its primary one

Refused for a group the account does not belong to — a rule the schema cannot express, since a foreign key could not say "and they must be a member of it".

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer | **required** |
| `groupId` | path | integer | **required** |

**200** { items }

## health

### `GET /api/v1/core-health`

How the core itself is doing, right now

The same numbers the Core Health sensor records, read live. **A `null` is a gap and never a zero** — CPU is null on the first reading after a start because it is a rate and there is nothing to measure against yet, and a rollup tier that has never run is not a tier that is infinitely behind. `rollupLag` is the excess over a tier’s own bucket width, so a healthy daily tier reads 0 rather than 86,400.

**200** { at, channels } · **503** { error }

### `GET /api/v1/probes/{id}/health`

How one probe is doing, right now

**Answers for a probe that is not connected**, which is the whole reason Probe Health is evaluated by the core: a probe cannot report its own absence. `connected` is 0 then and every other channel is `null` — a gap, because the probe’s numbers are not zero, they are unknown, and a scheduler lag of 0 ms from a probe that is gone would be the most misleading reading this system could produce. A probe below protocol 7 cannot send its own numbers either; the message says so in words rather than leaving the channels silently absent.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer | **required** |

**200** { at, probeId, message, channels } · **503** { error }

## libraries

### `GET /api/v1/libraries`

The libraries this account may see

Highest priority first, then by name. An administrator sees every library; everybody else sees the ones a group they belong to has been granted.

**200** { items }

### `POST /api/v1/libraries`

Create a library

The creator’s primary group is granted full access in the same transaction — access is per group and a new library has no grants, so otherwise the person who made it could not see it. At most 200 nodes, six levels deep, each id used once: a document that does not fit is refused whole, naming the node that is wrong.

**Body**

| Field | Type | |
| --- | --- | --- |
| `name` | string | **required** |
| `description` | string |  |
| `priority` | integer |  |
| `nodes` | object[] |  |

**201** { id, name, description, priority, nodes, version, createdAt, updatedAt }

### `GET /api/v1/libraries/{id}`

One library, with its nodes and their rules

The document, not what it shows: each node’s rule is evaluated when the library is viewed, through the viewer’s own rights. A library this account may not read answers 404 rather than 403, so the error cannot be used to enumerate which ids exist.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | string | **required** |

**200** { id, name, description, priority, nodes, version, createdAt, updatedAt }

### `PATCH /api/v1/libraries/{id}`

Change a library

`If-Match` carries the version this edit was made against, and without it the request is refused with 428: two people arranging one library is two people in a designer. `nodes`, when sent, replaces every node — there is no merging of one tree into another.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | string | **required** |

**Body**

| Field | Type | |
| --- | --- | --- |
| `name` | string |  |
| `description` | string |  |
| `priority` | integer |  |
| `nodes` | object[] |  |

**200** { id, name, description, priority, nodes, version, createdAt, updatedAt }

### `DELETE /api/v1/libraries/{id}`

Delete a library

Needs full access. The grants on it go with it; no sensor does, because a library holds rules and never sensors.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | string | **required** |

**204**

### `GET /api/v1/libraries/{id}/access`

Which groups may see this library

Needs full access: who else can see a thing is not a read.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | string | **required** |

**200** { items }

### `PUT /api/v1/libraries/{id}/access/{groupId}`

Grant a group access to this library

Needs full access, so a write holder may arrange the nodes without deciding who else sees them. Granting twice replaces rather than failing: it is a correction.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | string | **required** |
| `groupId` | path | string | **required** |

**Body**

| Field | Type | |
| --- | --- | --- |
| `right` | `none` · `read` · `write` · `full` | **required** |

**204**

### `DELETE /api/v1/libraries/{id}/access/{groupId}`

Take a group’s access away

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | string | **required** |
| `groupId` | path | string | **required** |

**204**

## lookups

### `GET /api/v1/lookups`

List the lookups this installation has loaded

Every definition available to a channel, plus every one that was refused and why. A refused lookup leaves its channels judged by nothing, so the failures are served beside the successes rather than left in the journal.

**200** { items, problems }

### `GET /api/v1/lookups/{id}`

One lookup, with every entry

What each value maps to. `undefinedState` is what a value no entry covers becomes — it has no default, because whether an undocumented status code is fine or a problem depends entirely on the device.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | string | **required** |

**200** { id, name, description, type, undefinedState, entries }

## maps

### `GET /api/v1/maps`

The maps this account may see

Highest priority first, then by name. An administrator sees every map; everybody else sees the ones a group they belong to has been granted.

**200** { items }

### `POST /api/v1/maps`

Create a map

The creator’s primary group is granted full access in the same transaction — access is per group and a new map has no grants, so otherwise the person who made it could not see it.

**Body**

| Field | Type | |
| --- | --- | --- |
| `name` | string | **required** |
| `description` | string |  |
| `priority` | integer |  |
| `layout` | object |  |

**201** { id, name, description, priority, layout, version, createdAt, updatedAt }

### `GET /api/v1/maps/{id}`

One map, with its canvas

A map this account may not read answers 404 rather than 403, so the error cannot be used to enumerate which ids exist.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | string | **required** |

**200** { id, name, description, priority, layout, version, createdAt, updatedAt }

### `PATCH /api/v1/maps/{id}`

Change a map

`If-Match` carries the version this edit was made against. Without it the request is refused with 428: a designer is a thing two people open at once, and last-write-wins there means somebody’s afternoon disappears without a message.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | string | **required** |

**Body**

| Field | Type | |
| --- | --- | --- |
| `name` | string |  |
| `description` | string |  |
| `priority` | integer |  |
| `layout` | object |  |

**200** { id, name, description, priority, layout, version, createdAt, updatedAt }

### `DELETE /api/v1/maps/{id}`

Delete a map

Needs full access. The grants on it go with it.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | string | **required** |

**204**

### `GET /api/v1/maps/{id}/view`

One map with its widgets filled in

What a map draws, rather than the document it is stored as. A widget naming an object that has been deleted, or one this account may not see, comes back as `unavailable` and stays on the canvas — a dashboard that quietly stops mentioning what failed is worse than one with a hole in it. **Which of the two it is, is told to nobody**: anybody who may write can make a map, so telling its author would answer "does this id exist?" for any id they chose.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | string | **required** |

**200** { map, widgets, connectors, problems, geo, tiles }

### `GET /api/v1/maps/{id}/shares`

The public share links on this map

Needs full access: a share link is a grant to everybody, and `full` is the right that decides a map’s audience. The tokens themselves are not here and cannot be — only their hashes are stored, so a URL is shown once when it is made.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | string | **required** |

**200** { items }

### `POST /api/v1/maps/{id}/shares`

Make a public share link

Answers with the URL’s token **once**. Only its hash is stored, so it cannot be shown again — which is what keeps a database backup from being a set of working share links. An expiry is required (`ADR-002`): a link without one is a permanent unauthenticated route nobody remembers creating.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | string | **required** |

**Body**

| Field | Type | |
| --- | --- | --- |
| `label` | string | **required** |
| `expiresAt` | string | **required** |

**201** { share, token }

### `DELETE /api/v1/maps/{id}/shares/{shareId}`

Revoke a share link

The link stops working immediately. The row stays, revoked, so the record of what existed outlives the decision to stop it.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | string | **required** |
| `shareId` | path | string | **required** |

**204**

### `GET /api/v1/maps/{id}/background`

The background image behind a map

The stored bytes, with the SHA-256 of them as a strong ETag. Send `If-None-Match` and a wall display re-opens without downloading the floor plan again.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | string | **required** |

**200**

### `POST /api/v1/maps/{id}/background`

Put a background image behind a map

PNG, JPEG or WebP, at most 2 MiB and 4096 pixels on a side. The format is decided by reading the file’s own header — the declared content type is a claim by the client and is never trusted. SVG is refused: it is a document rather than an image, and a background is drawn in the application’s own page (`ADR-003`). Needs `write`, the same right as moving a widget. The body is the file itself, not JSON.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | string | **required** |

**200** { mediaType, digest, width, height, bytes, uploadedAt, uploadedBy }

### `DELETE /api/v1/maps/{id}/background`

Take the background off a map

Silent when there was none: the map ends up without one either way.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | string | **required** |

**204**

### `GET /api/v1/maps/{id}/access`

Which groups may see this map

Needs full access: who else can see a thing is not a read.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | string | **required** |

**200** { items }

### `PUT /api/v1/maps/{id}/access/{groupId}`

Grant a group access to this map

Needs full access, so a write holder may edit the canvas without deciding who else sees it. Granting twice replaces rather than failing: it is a correction.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | string | **required** |
| `groupId` | path | string | **required** |

**Body**

| Field | Type | |
| --- | --- | --- |
| `right` | `none` · `read` · `write` · `full` | **required** |

**204**

### `DELETE /api/v1/maps/{id}/access/{groupId}`

Take a group’s access away

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | string | **required** |
| `groupId` | path | string | **required** |

**204**

### `GET /api/v1/public/maps/{token}`

A shared map, with no session at all

The map a share token opens, with every widget resolved. Expired, revoked and never-existed tokens all answer 404 in the same words: telling them apart would say which guesses were once real links. Rate limited per address and per token.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `token` | path | string | **required** |

**200** { name, description, widgets, connectors, problems, hasBackground, geo, tiles }

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

**200** { version, commit, dirty, profile, subsystems }

## notifications

### `GET /api/v1/notification-health`

Whether notifications are actually being delivered

Read from the queue rather than counted in memory, deliberately: a core that restarted five minutes ago would otherwise report a clean sheet over a queue full of undelivered alarms. `down` means an alarm was given up on, or one has been undeliverable long enough that the relay is not coming back on its own; `warning` means something is being retried.

**200** { status, problems, pending, parked, retrying, failed, discarded, oldestPendingAt, oldestPendingAgeMs, lastDeliveredAt, windowMs, staleAfterMs, methods }

### `GET /api/v1/notification-requests`

What happened to each notification

Newest first, paged by `before` rather than by offset — notifications arrive while somebody is reading, and an offset page would show a row twice or not at all. `failed` is an alarm nobody received; `discarded` is one an activation schedule threw away on purpose (`N-12`), which is not the same thing. Only notifications about sensors the caller can read appear.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `status` | query | object |  |
| `sensorId` | query | integer |  |
| `templateId` | query | integer |  |
| `before` | query | integer |  |
| `limit` | query | integer |  |

**200** { items, nextBefore }

## objects

### `GET /api/v1/objects`

Flat filtered listing, keyset-paginated. `q` searches names and device hosts as a case-insensitive substring; `host` is an exact match on a device host. `include=path` gives each item its ancestors, so a flat search result can say where each match is. Note: under sort=name an object renamed mid-pagination can be returned twice or missed — inherent to keyset paging and acceptable for a UI. Anything that must be exact (bulk selection, config export) must use sort=id, which is immutable.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `parentId` | query | integer |  |
| `kind` | query | object |  |
| `tag` | query | string,array |  |
| `q` | query | string |  |
| `host` | query | string |  |
| `priorityMin` | query | integer |  |
| `sort` | query | `name` · `id` · `manual` |  |
| `effective` | query | string,array |  |
| `include` | query | string |  |
| `cursor` | query | string |  |
| `limit` | query | integer |  |

**200** { items, nextCursor }

### `POST /api/v1/objects`

**Body**

| Field | Type | |
| --- | --- | --- |
| `kind` | `probe` · `group` · `device` · `sensor` | **required** |
| `parentId` | integer | **required** |
| `name` | string | **required** |
| `tags` | string[] |  |
| `priority` | integer |  |
| `comments` | string |  |
| `host` | string |  |
| `ipVersion` | `auto` · `v4` · `v6` |  |
| `sensorType` | string |  |
| `params` | object |  |
| `gid` | string,null |  |

**201** { id, kind, parentId, name, tags, priority, comments, inheritsTriggers, version, childCount, createdAt, updatedAt, host, ipVersion, gid, sensorType, params, redactedParams, settings, channels, credentials, ancestors }

### `GET /api/v1/objects/root`

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `include` | query | string |  |

**200** { id, kind, parentId, name, tags, priority, comments, inheritsTriggers, version, childCount, createdAt, updatedAt, host, ipVersion, gid, sensorType, params, redactedParams, settings, channels, credentials, ancestors }

### `GET /api/v1/objects/tops`

Where the caller’s tree starts

The objects the caller can read whose parent it cannot. For an account that can read the root, that is the root. For one granted a few branches, it is the top of each: the containers above a granted branch are outside it, so their names are never shown and the tree starts at the branches instead — and a grant re-opened inside a hole the caller cannot see is a top of its own, because no expansion reaches it. Ordered by name.

**200** { items }

### `POST /api/v1/objects/tree`

Create a whole subtree in one request

Creates many objects at once, under one `parentId`, with nodes naming their parent by `ref` where that parent is also being created here. **One transaction**: the whole subtree appears or none of it does, which is what a discovery run needs — a half-provisioned device is worse than a failed one, because nothing says which half. Every object goes through the same validation, the same hierarchy rules, the same channel declaration and the same audit log as `POST /objects`; what is not paid is a request, a transaction and a tree lock **per object**. Refusals name the node by its index and its `ref`, because a caller sending five thousand cannot act on "invalid request". The answer is ids in the order the nodes were sent, not full objects: five thousand of those is megabytes of response describing what the caller already wrote, and the one thing they could not know is the ids.

**Body**

| Field | Type | |
| --- | --- | --- |
| `parentId` | integer | **required** |
| `nodes` | object[] | **required** |

**201** { count, objects }

### `GET /api/v1/objects/{id}`

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `include` | query | string |  |
| `id` | path | integer | **required** |

**200** { id, kind, parentId, name, tags, priority, comments, inheritsTriggers, version, childCount, createdAt, updatedAt, host, ipVersion, gid, sensorType, params, redactedParams, settings, channels, credentials, ancestors }

### `PATCH /api/v1/objects/{id}`

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer | **required** |

**Body**

| Field | Type | |
| --- | --- | --- |
| `kind` | `root` · `probe` · `group` · `device` · `sensor` | **required** |
| `name` | string |  |
| `tags` | string[] |  |
| `priority` | integer |  |
| `comments` | string |  |
| `inheritsTriggers` | boolean |  |
| `host` | string |  |
| `ipVersion` | `auto` · `v4` · `v6` |  |
| `params` | object |  |
| `gid` | string,null |  |

**200** { id, kind, parentId, name, tags, priority, comments, inheritsTriggers, version, childCount, createdAt, updatedAt, host, ipVersion, gid, sensorType, params, redactedParams, settings, channels, credentials, ancestors }

### `DELETE /api/v1/objects/{id}`

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `expectedDescendants` | query | integer |  |
| `id` | path | integer | **required** |

**200** { id, kind, name, deleted }

### `POST /api/v1/objects/{id}/order`

Moves an object within its parent's children, the way PRTG's move up / move down does. Siblings nobody has arranged keep sorting by name, so a tree that has never been ordered by hand reads exactly as it did before. Listings honour the arrangement through `GET /objects?parentId=…&sort=manual` and through the tree endpoint, which always does. A move that changes nothing is a no-op, not an error.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer | **required** |

**Body**

| Field | Type | |
| --- | --- | --- |
| `move` | `up` · `down` · `first` · `last` | **required** |

**200** { id, kind, parentId, name, tags, priority, comments, inheritsTriggers, version, childCount, createdAt, updatedAt, host, ipVersion, gid, sensorType, params, redactedParams, settings, channels, credentials, ancestors }

### `POST /api/v1/objects/{id}/move`

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer | **required** |

**Body**

| Field | Type | |
| --- | --- | --- |
| `targetParentId` | integer | **required** |

**200** { object, fromParentId, toParentId, movedCount, probeChanged, settingsChanged, credentialsChanged }

### `POST /api/v1/objects/{id}/clone`

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer | **required** |

**Body**

| Field | Type | |
| --- | --- | --- |
| `targetParentId` | integer |  |
| `name` | string |  |

**201** { object, clonedCount, droppedCredentialKinds, settingsChanged }

### `POST /api/v1/objects/bulk`

Applies one operation to a selection. **Each object is atomic and the batch is best-effort**: the report names every object that did not change and why, rather than failing the request. An operator who selects forty sensors and pauses them, one of which a colleague deleted a moment ago, wants thirty-nine paused and a line naming the fortieth — all-or-nothing would give them neither. The selection is explicit ids, never a filter. A client enumerating a selection with `GET /objects` **must** page with `sort=id`: under `sort=name` a keyset scan can return a renamed object twice or skip it, so a bulk delete would miss objects the operator chose. At most 500 objects, because each one takes the tree lock in turn and a larger selection is a filter rather than a selection. Repeated ids are collapsed and counted, never applied twice.

**Body**

| Field | Type | |
| --- | --- | --- |
| `ids` | integer[] | **required** |
| `operation` | `pause` · `resume` · `move` · `clone` · `delete` · `setting` · `revertSetting` | **required** |
| `targetParentId` | integer |  |
| `cascade` | boolean |  |
| `key` | string |  |
| `value` | object |  |
| `minutes` | integer |  |
| `until` | string |  |
| `from` | string |  |
| `message` | string |  |

**200** { requested, succeeded, failed, duplicates, outcomes }

### `GET /api/v1/objects/{id}/tree`

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `maxDepth` | query | integer |  |
| `limit` | query | integer |  |
| `kind` | query | object |  |
| `effective` | query | string,array |  |
| `id` | path | integer | **required** |

**200** { items, truncated }

### `GET /api/v1/objects/{id}/counts`

Exact totals for a subtree

How many objects of each kind are under this one, and what state its sensors are in. Unlike `/tree` there is no depth and no limit: the counting happens in the database and only the totals cross the wire. Use this wherever a page shows a **number** rather than rows. Counting a page of `/tree` gives the right answer for a small installation and a quietly wrong one for a large installation, which is the worst way for a number to be wrong.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer | **required** |

**200** { objects, sensorStates }

### `GET /api/v1/objects/counts`

Exact totals for everything the caller can see

The same totals as `/objects/:id/counts`, over every object the caller can read rather than under one. For an account that can read the root it is the root’s counts; for one granted a few branches it is theirs, with nothing outside them counted — which the root’s own counts, refused to that account, could not give.

**200** { objects, sensorStates }

### `GET /api/v1/objects/{id}/ancestors`

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer | **required** |

**200** { items }

## probes

### `GET /api/v1/probes`

Every probe this core knows, and what was decided about it

Includes the ones waiting for approval, which is the list worth opening: a probe in `pending` is connected and doing nothing, on purpose. `lastAddress` is beside each one because "a probe called backup-01 wants in" is not a decision anybody can make and "from 10.4.2.9" is.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `status` | query | `pending` · `approved` · `revoked` |  |

**200** { items }

### `POST /api/v1/probes/{gid}/approve`

Approve a probe onto a branch of the tree

Binds this identity to a probe object. The probe is issued a key of its own at its **next handshake**, not here: approving a machine that is switched off is an ordinary thing to do, and a key delivered in a welcome it never received would lock it out. Nobody ever sees that key — it goes straight to the probe over the authenticated link, so it never passes through a clipboard or a support ticket. A probe that is already connected has its connection closed and comes back on its own retry — about a second — because the handshake is where both the key and the first configuration are issued. It said "starts scanning without reconnecting" until `P-189`, which was not implemented: the session’s approval is fixed at admission, so a probe approved after it connected sat there scanning nothing.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `gid` | path | string | **required** |

**Body**

| Field | Type | |
| --- | --- | --- |
| `objectId` | integer | **required** |
| `local` | boolean |  |

**200** { gid, status, displayName, agentVersion, protocolVersion, lastAddress, allowFrom, hasOwnKey, objectId, note, firstSeenAt, lastSeenAt, decidedAt, skew }

### `POST /api/v1/probes/{gid}/revoke`

Refuse a probe from now on

The record is kept rather than deleted, so the same identity cannot come back by simply reconnecting and so the log of what was refused survives the decision. The branch is released, because the sensors under it — and their history and their thresholds — should outlive the machine that was scanning them.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `gid` | path | string | **required** |

**Body**

| Field | Type | |
| --- | --- | --- |
| `note` | string |  |

**200** { gid, status, displayName, agentVersion, protocolVersion, lastAddress, allowFrom, hasOwnKey, objectId, note, firstSeenAt, lastSeenAt, decidedAt, skew }

### `PUT /api/v1/probes/{gid}/allow-from`

Narrow where one probe may connect from

Ranges in the same spellings a discovery takes — `10.0.0.0/24`, `10.0.0.1-50`, a single address — with no size cap, because stating that your probes live in `10.0.0.0/8` is a fact about a network rather than a request to enumerate it. An empty list means anywhere, which is the default: a stolen key is worth much less when it only works from one subnet, and only the operator can say which one.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `gid` | path | string | **required** |

**Body**

| Field | Type | |
| --- | --- | --- |
| `allowFrom` | string[] | **required** |

**200** { gid, status, displayName, agentVersion, protocolVersion, lastAddress, allowFrom, hasOwnKey, objectId, note, firstSeenAt, lastSeenAt, decidedAt, skew }

### `DELETE /api/v1/probes/{gid}`

Forget a probe entirely

Different from revoking: a forgotten probe that connects again enrols as a stranger and waits in the queue. Use it when the machine is genuinely gone.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `gid` | path | string | **required** |

**204**

## reports

### `GET /api/v1/reports`

The reports this account may see

By name. An administrator sees every report; everybody else sees the ones a group they belong to has been granted.

**200** { items }

### `POST /api/v1/reports`

Create a report

The creator’s primary group is granted full access in the same transaction, or a non-administrator would create a report and immediately lose sight of it. `runAs` defaults to the caller: a report renders through somebody’s eyes, and the person making it is the only safe default. **Naming any other account needs an administrator**, and a login that does not exist is refused in the same words as one that does, so the refusal cannot be used to list accounts. `span` names a calendar period — `{ kind, offset, timezone }` for `day`, `week`, `month`, `quarter` and `year`, or `{ kind: "custom", from, to }` with ISO 8601 instants. **`offset` counts periods back and defaults to 1**, the last complete one: a monthly report fires on the 1st, and "this month" would be two hours long. `0` is the period in progress and ends now. Weeks start on Monday (ISO 8601), and the zone defaults to the core’s own. Add `resolutionSeconds` to pin an averaging interval. The response carries `resolved`: the window the span works out to right now, the bucket width, the rollup tier that will answer, and anything the rules changed — a span of 40 days or more is averaged over at least an hour, and one over 500 days is shortened to 365. A span that cannot resolve yet answers `unresolvable` instead.

**Body**

| Field | Type | |
| --- | --- | --- |
| `name` | string | **required** |
| `description` | string |  |
| `kind` | `graph_and_table` · `table_only` · `graph_only` · `sensor_list` · `installation` · `top_values` · `top_uptime` | **required** |
| `subjects` | object |  |
| `span` | object |  |
| `outputs` | object |  |
| `schedule` | object |  |
| `runAs` | string |  |

**201** { id, name, description, kind, subjects, span, resolved, unresolvable, outputs, schedule, scheduleSummary, nextRunAt, lastRunAt, runAs, version, createdAt, updatedAt }

### `GET /api/v1/reports/{id}`

One report

A report this account may not read answers 404 rather than 403, so the error cannot be used to enumerate which ids exist.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | string | **required** |

**200** { id, name, description, kind, subjects, span, resolved, unresolvable, outputs, schedule, scheduleSummary, nextRunAt, lastRunAt, runAs, version, createdAt, updatedAt }

### `PATCH /api/v1/reports/{id}`

Change a report

`If-Match` carries the version this edit was made against, and is refused with 428 when missing. Changing `runAs` needs full access rather than write: it decides whose data the output contains, which is the same class of act as granting access. **Full is enough only to point it at yourself** — naming any other account needs an administrator, as it does on create.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | string | **required** |

**Body**

| Field | Type | |
| --- | --- | --- |
| `name` | string |  |
| `description` | string |  |
| `kind` | `graph_and_table` · `table_only` · `graph_only` · `sensor_list` · `installation` · `top_values` · `top_uptime` |  |
| `subjects` | object |  |
| `span` | object |  |
| `outputs` | object |  |
| `schedule` | object |  |
| `runAs` | string |  |

**200** { id, name, description, kind, subjects, span, resolved, unresolvable, outputs, schedule, scheduleSummary, nextRunAt, lastRunAt, runAs, version, createdAt, updatedAt }

### `DELETE /api/v1/reports/{id}`

Delete a report

Needs full access, because deleting one takes its grants with it.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | string | **required** |

**204**

### `GET /api/v1/reports/{id}/subjects`

What this report would contain, as its security context sees it

A report renders through a named account, not through whoever is asking (`§6`). This route answers the same question the renderer will: which of the objects the report names that account can actually read. **Reading this needs only `read` on the report, and that is the act-as grant working as designed** — granting somebody access to a report grants them everything its `runAs` account can see, whatever their own rights are. Grant reports the way you would grant the account they run as. `unavailable` lists ids this report will not render, and deliberately does not say whether each is deleted or merely out of scope: a `write` holder on a report needs no access to the object tree, and telling the two apart would make this an existence oracle for every id in the installation. The distinction is in the core log. Answers 422 when the account has been deleted or disabled — understood request, real report, no scope to render it through, and no right the caller could hold would fix it.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | string | **required** |

**200** { runAs, visible, unavailable }

### `GET /api/v1/reports/{id}/runs`

When this report ran, and what happened

Newest first, at most 50 of them. A run that failed carries the same code the API would have answered with, so an operator reading this and an operator reading a 422 are told the same thing. A run left `failed` with `REPORT_INTERRUPTED` was in flight when the core stopped. It is marked at the next startup rather than left `running` for ever — the partial unique index over `running` would otherwise keep that report unrunnable.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | string | **required** |

**200** { items }

### `POST /api/v1/reports/{id}/runs`

Run this report now

Renders the report against its span and its security context, and records the outcome. **Needs `write`, not `read`** — a render is minutes of work against the same database serving live checks, so starting one is a write even though it changes nothing about the report. **One run at a time.** A report already rendering answers 409 rather than queueing: a button pressed six times must not become six renders competing for the same pool. The constraint is a partial unique index, so two requests racing lose at the database rather than in a window between a check and an insert. The rendered document is not kept — `E-09` decides where a report goes. What this records is that it ran, what period it covered, how large it was, and why it failed if it did, which is what tells an operator at 09:00 whether last night worked.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | string | **required** |

**201** { id, reportId, trigger, requestedBy, state, queuedAt, startedAt, finishedAt, durationMs, spanLabel, sections, unavailable, cells, errorCode, errorMessage, delivery, outputs }

### `GET /api/v1/reports/{id}/access`

Which groups may see this report

Needs full access: who else can read a report is not a read-only detail.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | string | **required** |

**200** { items }

### `PUT /api/v1/reports/{id}/access/{groupId}`

Grant a group access to this report

Needs full access, so a write holder may edit what a report measures without deciding who else reads it. Granting twice replaces rather than failing.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | string | **required** |
| `groupId` | path | string | **required** |

**Body**

| Field | Type | |
| --- | --- | --- |
| `right` | `none` · `read` · `write` · `full` | **required** |

**204**

### `DELETE /api/v1/reports/{id}/access/{groupId}`

Take a group’s access away

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | string | **required** |
| `groupId` | path | string | **required** |

**204**

### `GET /api/v1/reports/{id}/render`

Render this report now, as HTML, CSV, XML or PDF

Runs the report against its span and its security context and answers the document. `?format=html` (the default), `?format=csv`, `?format=xml` or `?format=pdf`. **An interval with no reading is a gap, in every format** — an empty field in CSV, `—` in HTML and in PDF, and `xsi:nil="true"` in XML, never a zero and never the previous value carried forward. A row whose channels are all empty is still printed: dropping it would make the table claim the period was shorter than it was. A PDF is laid out by this service rather than by a browser (`ADR-006`), so it has a page limit as well as a value limit: a report over 400 pages answers 422 with the count and what to narrow. Subjects the report’s account cannot read are counted in the document rather than omitted from it, and answer as ids without saying which are deleted (`E-03`). A report whose account has been deleted or disabled answers 422, and one that would render more values than the limit answers 422 with the count and what to narrow — refused rather than truncated, because a report quietly missing its last four hundred sensors is the failure this whole surface exists to avoid.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | string | **required** |

**200**

### `GET /api/v1/reports/{id}/runs/{runId}/{format}`

Download what a run produced

The stored document, as `html`, `csv`, `xml`, `pdf` or `zip` depending on what the report was set to render. The bytes carry their own SHA-256 as a strong `ETag`; send `If-None-Match` and a second download is a 304. **An email-only report keeps nothing once it has been delivered** (`ADR-005` Decision 4) and answers 404 here. It is stored between rendering and sending because a retry needs the bytes, and a re-render months later is a different document.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | string | **required** |
| `runId` | path | string | **required** |
| `format` | path | string | **required** |

**200**

## schedules

### `GET /api/v1/schedules`

Every schedule, with what it means right now

`active` and `nextChangeAt` are evaluated at the moment the request is served, so a list is also the answer to "what is suspended at the moment".

**200** { items }

### `POST /api/v1/schedules`

Create a schedule

Give either `periods` (`fr:19:00-mo:06:00`, space or comma separated) or `grid` (7 × 24 booleans, Monday first) — never both. `polarity` says which one the periods describe: `active` is when monitoring runs, `inactive` is when it is suspended. It applies to `periods` only: a grid’s marked cells *are* the monitored hours, so a polarity sent beside a grid is ignored.

**Body**

| Field | Type | |
| --- | --- | --- |
| `name` | string | **required** |
| `description` | string |  |
| `polarity` | `active` · `inactive` |  |
| `timezone` | string,null |  |
| `periods` | string |  |
| `grid` | boolean[][] |  |

**201** { id, name, description, polarity, authoredAs, timezone, effectiveTimezone, periods, grid, gridIsExact, builtIn, active, nextChangeAt, usedBy, createdAt, updatedAt }

### `GET /api/v1/schedules/{id}`

One schedule

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer | **required** |

**200** { id, name, description, polarity, authoredAs, timezone, effectiveTimezone, periods, grid, gridIsExact, builtIn, active, nextChangeAt, usedBy, createdAt, updatedAt }

### `PUT /api/v1/schedules/{id}`

Replace a schedule

Whole-document: a partial update of a period list is a merge nobody can define. Sensors under this schedule are re-evaluated in the same transaction, so a window that has just closed pauses them before the response is sent.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer | **required** |

**Body**

| Field | Type | |
| --- | --- | --- |
| `name` | string | **required** |
| `description` | string |  |
| `polarity` | `active` · `inactive` |  |
| `timezone` | string,null |  |
| `periods` | string |  |
| `grid` | boolean[][] |  |

**200** { id, name, description, polarity, authoredAs, timezone, effectiveTimezone, periods, grid, gridIsExact, builtIn, active, nextChangeAt, usedBy, createdAt, updatedAt }

### `DELETE /api/v1/schedules/{id}`

Delete a schedule

Refused while any object still assigns it — the refusal names them — and refused outright for the schedules this build ships.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer | **required** |

**200** { id, deleted }

## sensor-types

### `GET /api/v1/sensor-types`

List the registered sensor types

Every type this installation can run, with the JSON Schema its parameters are validated against. An empty list means no sensor can be created.

**200** { items }

### `POST /api/v1/sensor-types/{id}/preview`

Run this type’s mapping language over a pasted response

For types whose parameters contain paths into a document — `rest.custom`’s `extract` array is the one — this answers what each path selects against a response the operator pasted, what the aggregate makes of it, and whether the check would pass. **The type’s own code runs**, the same functions a real check runs, so a path proved here works against the device. **Nothing is fetched and nothing is stored.** The document comes from the request; no sensor is created, no credential is read, and no reading enters history. Types with no mapping language answer 409, and `hasPreview` on the type list says which those are without a request. A path that does not parse is reported on its own row rather than failing the request: the form this feeds has a half-typed path in it every few keystrokes.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | string | **required** |

**Body**

| Field | Type | |
| --- | --- | --- |
| `document` | string | **required** |
| `contentType` | string |  |
| `params` | object | **required** |

**200** { format, error, rows, expectations, problems }

## sensors

### `GET /api/v1/sensors/{id}/values`

Each channel's current reading, for a sensor detail page's channel table. A `null` value means no reading inside the window, which is a gap and never a zero: the window is three scan intervals (at least a minute), so a sensor that has stopped reporting shows nothing rather than its last healthy figure dressed as current. `at` is when the reading shown was actually taken.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer | **required** |

**200** { sensorId, readAt, notBefore, intervalSeconds, channels }

### `GET /api/v1/sensors/{id}/history`

Historic channel data for a sensor. The resolution is snapped up to a supported averaging interval (15s upwards); ranges over 500 days are shortened to 365, and ranges of 40 days or more are averaged over at least 60 minutes. Everything the rules change is reported in `adjustments`. In `avg`, `min`, `max` and `count`, null is a gap — a period the sensor produced no readings — and never a zero.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `from` | query | string |  |
| `to` | query | string |  |
| `resolutionSeconds` | query | integer |  |
| `id` | path | integer | **required** |

**200** { sensorId, from, to, resolutionSeconds, bucketCount, source, segments, adjustments, buckets, channels }

### `POST /api/v1/sensors/{id}/check`

Run this sensor’s check now and return what it said

Asks the probe that owns the sensor to run **exactly** the check a scheduled scan would run — the same parameters, the same credentials, the same target — and hands back the result. **Nothing is stored**: a reading taken outside the schedule is not history, and ten presses of the button would otherwise draw ten spikes into a channel whose interval is a minute. `stored` says so on every response. A check that *fails* is a 200 carrying `outcome: "error"` and the reason, because that is the answer somebody pressed the button to get. The error statuses are for the query failing rather than the check: 503 the probe is not connected or is already running as many of these as it will, 504 it did not answer in time, 409 it is too old to be asked at all. A **paused** sensor can still be checked. A pause stops the monitoring; it does not stop an operator asking whether the thing they just fixed is working, which is exactly when a sensor is most likely to be paused.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer | **required** |

**Body**

| Field | Type | |
| --- | --- | --- |
| `timeoutMs` | integer |  |

**200** { sensorId, at, outcome, message, durationMs, channels, stored }

### `GET /api/v1/sensors/{id}/state`

A sensor’s current state, why it is in it, and since when. `pausedBy` lists every pause source holding the sensor, not only the one `cause` reports: the four are an independent set, so clearing the reported one does not necessarily resume it.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer | **required** |

**200** { sensorId, state, cause, message, since, lastResultAt, consecutiveFailures, pausedBy, acknowledged, acknowledgedUntil, acknowledgedBy, simulatedError }

## settings

### `GET /api/v1/setting-definitions`

**200** { items }

### `GET /api/v1/objects/{id}/settings`

Effective and own values together. ?asChildOf=<parentId> projects what the object would resolve to under a different parent — the move confirmation dialog, without performing the move.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `asChildOf` | query | integer |  |
| `id` | path | integer | **required** |

**200** { objectId, asChildOf, settings }

### `PUT /api/v1/objects/{id}/settings/{key}`

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer | **required** |
| `key` | path | string | **required** |

**Body**

| Field | Type | |
| --- | --- | --- |
| `value` | object | **required** |

**200** { key, description, schema, effective, inherited, own }

### `DELETE /api/v1/objects/{id}/settings/{key}`

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer | **required** |
| `key` | path | string | **required** |

**200** { key, reverted, effective, own }

## state

### `GET /api/v1/objects/{id}/pause`

Whether this object is paused, why, until when, and whether this is the one that can be resumed.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer | **required** |

**200** { objectId, paused, pending, resumable, source, pausedAt, startsAt, pausedUntil, message, actor, inheritedFrom, schedule, dependency }

### `POST /api/v1/objects/{id}/pause`

Pauses an object and every sensor beneath it. Give `minutes` for a duration, `until` for a moment, or neither to pause indefinitely — until a person says otherwise. A UI offers 5, 15, 60, 180, 1440 minutes as presets, but any duration is accepted. Takes effect immediately: the sensors change state in this request, and their probe stops being told to scan them. Pausing an already-paused object replaces the reason and the deadline rather than stacking, which is what extending a maintenance window means. Give `from` with `until` for a **maintenance window** — the same pause, scheduled rather than immediate. Nothing is paused until it starts; the object reads `pending` until then and can be cancelled at any point by resuming it.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer | **required** |

**Body**

| Field | Type | |
| --- | --- | --- |
| `minutes` | integer |  |
| `until` | string |  |
| `from` | string |  |
| `message` | string |  |

**200** { objectId, paused, pending, resumable, source, pausedAt, startsAt, pausedUntil, message, actor, inheritedFrom, schedule, dependency }

### `DELETE /api/v1/objects/{id}/pause`

Resumes an object, or cancels a maintenance window it has not reached yet. Only the object that was directly paused can be resumed — a sensor paused because its device is paused has nothing of its own to clear, and the 409 names the object to resume instead. A resumed sensor reads Unknown until its next scan, never the state it had before the pause, which the system has not checked since.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer | **required** |

**200** { objectId, paused, pending, resumable, source, pausedAt, startsAt, pausedUntil, message, actor, inheritedFrom, schedule, dependency }

### `POST /api/v1/objects/{id}/acknowledge`

Acknowledges a Down alarm: the sensor reads Down (Acknowledged), notifications stop, and monitoring carries on exactly as before. Give `minutes` for a duration, `until` for a moment, or neither to acknowledge indefinitely. A UI offers 5, 15, 60, 180, 1440 minutes as presets. On a device or a group this acknowledges every sensor beneath it that is Down **at this moment** — a snapshot, not a rule, so a sensor that fails later is a new alarm. The message becomes the sensor’s last message. It clears on recovery, on expiry, on pause-then-resume, or by DELETE.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer | **required** |

**Body**

| Field | Type | |
| --- | --- | --- |
| `minutes` | integer |  |
| `until` | string |  |
| `message` | string |  |

**200** { objectId, acknowledged, refused, acknowledgedAt, acknowledgedUntil, message }

### `DELETE /api/v1/objects/{id}/acknowledge`

Withdraws an acknowledgement, so the alarm reads Down again and notifications resume. The three things that clear one on their own — recovery, expiry and pause-then-resume — are all events; this is the one for "I acknowledged the wrong sensor".

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer | **required** |

**200** { objectId, acknowledged, refused, acknowledgedAt, acknowledgedUntil, message }

### `POST /api/v1/objects/{id}/simulate-error`

Forces sensors Down so a notification chain can be tested end to end. **This fires the real chain at real people** — which is the point, since a chain nobody has seen fire is a chain nobody knows works. The sensor reads Down with cause `simulated`, never `scan`, so a forced outage cannot be mistaken for a real one; the message becomes its last message; the action is audited. On a device or a group this forces **every** sensor beneath it, whatever state it was in. Pausing still wins, so a sensor somebody switched off will not start paging anyone.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer | **required** |

**Body**

| Field | Type | |
| --- | --- | --- |
| `message` | string |  |

**200** { objectId, simulated, sensors, message }

### `DELETE /api/v1/objects/{id}/simulate-error`

Lifts a simulated error. The sensors return to what they actually measure straight away — unlike a resume, which yields Unknown, because a forced sensor never stopped being scanned: the force changes what its readings *mean*, not whether it takes any.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer | **required** |

**200** { objectId, simulated, sensors, message }

### `GET /api/v1/state-log`

Every state change, newest first

What changed, when, from what, why, and how long it lasted. Scope to a branch with `objectId` — a sensor id gives that sensor’s log. Filter with `state` and `cause`, both repeatable. Page with `before`, using `nextBefore` from the previous page. `durationMs` is null on the state a sensor is still in, and is measured against the real next transition rather than the next one on this page. Only sensors the caller can read appear. A deleted sensor’s history outlives it, but nothing records which branch it was in, so only an administrator sees it.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `objectId` | query | integer |  |
| `from` | query | string |  |
| `to` | query | string |  |
| `state` | query | object |  |
| `cause` | query | object |  |
| `before` | query | string |  |
| `limit` | query | integer |  |

**200** { items, nextBefore }

### `GET /api/v1/alarms`

Every sensor that is currently in an alarm state, worst first

Down, Down (Partial), Down (Acknowledged), Warning and Unusual — the five states `WORKFLOW.MD §7` names. **Paused and Unknown are absent by design**: a paused sensor is deliberately silent, and Unknown means nothing has scanned it yet, which is a gap in coverage rather than a fault. Reporting either as an alarm is how a list becomes one an operator scrolls past. `objectId` scopes to that object and everything beneath it. `counts` is per state across the whole scope and ignores the `state` filter, so a severity chip can still say how many it is hiding. Only sensors the caller can read are listed or counted, and `path` and `pathNames` carry only the steps the caller can read.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `objectId` | query | integer |  |
| `state` | query | object |  |
| `priorityMin` | query | integer |  |
| `includeAcknowledged` | query | boolean |  |
| `sort` | query | `priority` · `duration` |  |
| `limit` | query | integer |  |

**200** { items, total, counts }

## stream

### `GET /api/v1/stream`

Live sensor state changes

A WebSocket. Send `{"subscribe":{"objectId":42}}` to scope to a subtree, or `{"subscribe":{}}` for everything; the server answers with a `snapshot` frame and then a `state` frame per change. Subscribing again replaces the subscription and takes a fresh snapshot, which is also how a client resyncs — there is no cursor. A client that cannot keep up is sent `overflow` and detached rather than being quietly trimmed, because a tree missing a change looks exactly like a tree that is up to date. "Everything" is everything the caller can read: sensors it cannot are neither in the snapshot nor streamed, and every `path` carries only the steps it can read. Subscribing to an object it cannot read is answered with a `problem` frame. When what the caller may see changes — a grant revoked, a group left — the socket is sent `overflow` with that reason, and subscribing again takes a snapshot of the new view. `seq` numbers the `state` frames this socket has been sent, from 1 and across every subscription it makes; `hello` carries 0 and a `snapshot` the number of the last `state` frame before it. It is the socket’s own count, so a gap means a frame was lost and never that something changed outside what the caller can see. A socket is closed with 1008 when it subscribes more than 30 times in a minute, or sends more than 5 frames the stream cannot use — each of those is answered with `problem` — and closed outright when it stops reading and 16 MiB queue up unsent.

## templates

### `GET /api/v1/notification-methods`

The delivery methods this build understands

Each carries the JSON Schema its settings are validated against, which is also what a UI builds the form from. Fields marked `writeOnly` are credentials: they are accepted, stored and used, and never returned by any route, to anyone.

**200** { items }

### `GET /api/v1/summarisation-modes`

How eagerly a template may send during a storm

The six modes of `CAPABILITIES.MD §5.2`. The distinction that matters is between the *first* modes and the *all* modes: "first Down immediately" turns a forty-sensor outage into one message and a digest, while "all Downs immediately" sends forty. A method whose `summarisable` is false ignores all of this and is stored as `always-immediate`.

**200** { items, default }

### `GET /api/v1/notification-placeholders`

The placeholders a template’s subject and body may use

Case-insensitive: `%Sensor` and `%SENSOR` are `%sensor`. A name this build does not know is refused when the template is saved rather than blanked when it is sent — a message that quietly loses a fact reads perfectly and says nothing. Write `%%` for a literal per cent sign.

**200** { items }

### `GET /api/v1/templates`

Every notification template

**200** { items }

### `POST /api/v1/templates`

Create a template

**Body**

| Field | Type | |
| --- | --- | --- |
| `name` | string | **required** |
| `description` | string |  |
| `method` | string | **required** |
| `settings` | object | **required** |
| `subject` | string |  |
| `body` | string |  |
| `recipients` | object[] |  |
| `priority` | integer |  |
| `enabled` | boolean |  |
| `summarisation` | `always-immediate` · `first-down` · `first-down-and-up` · `downs-immediate` · `downs-and-ups-immediate` · `always-summarise` |  |
| `summaryWindowSeconds` | integer |  |
| `scheduleId` | integer,null |  |
| `whenInactive` | `queue` · `discard` |  |

**201** { id, name, description, method, methodName, settings, redactedSettings, subject, body, recipients, priority, enabled, summary, summarisable, summarisation, summaryWindowSeconds, scheduleId, scheduleName, whenInactive, createdAt, updatedAt }

### `GET /api/v1/templates/{id}`

One template

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer | **required** |

**200** { id, name, description, method, methodName, settings, redactedSettings, subject, body, recipients, priority, enabled, summary, summarisable, summarisation, summaryWindowSeconds, scheduleId, scheduleName, whenInactive, createdAt, updatedAt }

### `PUT /api/v1/templates/{id}`

Replace a template

Whole-document, with one exception: a secret the request does not carry is **kept**, because the form it came from was rendered without it. Send an explicit `null` to clear one.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer | **required** |

**Body**

| Field | Type | |
| --- | --- | --- |
| `name` | string | **required** |
| `description` | string |  |
| `method` | string | **required** |
| `settings` | object | **required** |
| `subject` | string |  |
| `body` | string |  |
| `recipients` | object[] |  |
| `priority` | integer |  |
| `enabled` | boolean |  |
| `summarisation` | `always-immediate` · `first-down` · `first-down-and-up` · `downs-immediate` · `downs-and-ups-immediate` · `always-summarise` |  |
| `summaryWindowSeconds` | integer |  |
| `scheduleId` | integer,null |  |
| `whenInactive` | `queue` · `discard` |  |

**200** { id, name, description, method, methodName, settings, redactedSettings, subject, body, recipients, priority, enabled, summary, summarisable, summarisation, summaryWindowSeconds, scheduleId, scheduleName, whenInactive, createdAt, updatedAt }

### `DELETE /api/v1/templates/{id}`

Remove a template

Refused while a trigger still names it, with the list of triggers to fix: deleting one out from under a trigger would leave that trigger firing into nothing.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer | **required** |

**200** { id, deleted }

### `GET /api/v1/templates/{id}/used-by`

Which triggers name this template

`CAPABILITIES.MD §5.2`’s reverse lookup, and the reason a delete can be refused with a list rather than a shrug. A trigger names its templates inside a JSON document, so no foreign key can enforce the reference — this is the query that stands in for one. Only triggers on objects the caller can read are listed.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer | **required** |

**200** { templateId, items }

### `GET /api/v1/templates/{id}/preview`

What this template would say about one sensor, right now

Rendered against the sensor’s actual state, not an invented one. An operator writing `%device / %sensor: %lastmessage` has no way to know whether that reads well until they see it against something real, and finding out from the first genuine outage is finding out too late. Nothing is sent and nothing is written.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `sensorId` | query | integer | **required** |
| `id` | path | integer | **required** |

**200** { templateId, sensorId, subject, body, unknown }

### `POST /api/v1/templates/preview`

What an unsaved draft would say about one sensor

The same rendering as the saved preview, against a template that does not exist yet — what an editor needs to show the text in the box rather than the text on disk (`U-10`). The draft goes through the same validation a write does, so one that could not be saved is refused here rather than previewing something the operator cannot keep. Nothing is sent, nothing is written, and no template is created.

**Body**

| Field | Type | |
| --- | --- | --- |
| `template` | object | **required** |
| `sensorId` | integer | **required** |

**200** { templateId, sensorId, subject, body, unknown }

### `POST /api/v1/templates/{id}/test`

Send a test notification through this template

**This really sends.** The same rendering, the same transport, the same settings and the same recipients — testing an on-call template at three in the morning pages whoever is on call, which is why it is written to the audit log. What it skips is the queue: nothing is retried, summarised or suppressed by an activation schedule, because those would each turn "did my relay work" into "wait fifteen minutes and find out". `notes` reports what a real notification would have run into instead, so a green test on a template that is switched off cannot be mistaken for a working alarm. Without `sensorId` the message is rendered against an example sensor, which is what an installation with no sensors yet needs.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer | **required** |

**Body**

| Field | Type | |
| --- | --- | --- |
| `sensorId` | integer |  |

**200** { templateId, templateName, method, methodName, sensorId, sensorName, subject, body, recipients, unknownPlaceholders, delivered, detail, error, retryable, durationMs, notes }

## triggers

### `GET /api/v1/trigger-kinds`

The kinds of trigger this build understands

Each carries the JSON Schema its settings are validated against, which is also what a UI builds the form from — one declaration rather than a form and a validator that can disagree.

**200** { items }

### `GET /api/v1/objects/{id}/triggers`

Every trigger in effect on an object, its own first

Own and inherited together, nearest first, each naming the object it is defined on — which is the only place it can be edited or removed. A trigger on the root applies to every sensor in the installation. Unlike an inherited *setting*, an inherited trigger does not displace a nearer one: both fire. A trigger inherited from an object the caller cannot see is still listed, because it still fires — with that object’s name null.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer | **required** |

**200** { objectId, items }

### `POST /api/v1/objects/{id}/triggers`

Add a trigger to an object

The settings are validated against the kind’s own schema, with its defaults filled in — so a state trigger with only a state is a complete trigger that notifies immediately and never escalates.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer | **required** |

**Body**

| Field | Type | |
| --- | --- | --- |
| `kind` | string | **required** |
| `settings` | object | **required** |
| `enabled` | boolean |  |

**201** { id, kind, kindName, settings, enabled, summary, inherited, definedOn, createdAt, updatedAt }

### `PUT /api/v1/triggers/{id}`

Replace a trigger

Whole-document: a latency without the notification it delays is not half a trigger, it is a broken one.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer | **required** |

**Body**

| Field | Type | |
| --- | --- | --- |
| `kind` | string | **required** |
| `settings` | object | **required** |
| `enabled` | boolean |  |

**200** { id, kind, kindName, settings, enabled, summary, inherited, definedOn, createdAt, updatedAt }

### `DELETE /api/v1/triggers/{id}`

Remove a trigger

From the object it is defined on. Deleting an inherited trigger means deleting it where it lives, which the effective set names.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | integer | **required** |

**200** { id, deleted }
