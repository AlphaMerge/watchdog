import type { ApiError, Loadable } from '../../api/client';
import { problemPath } from '../../api/client';
import type {
  CredentialKindSummary,
  CredentialRemoval,
  CredentialView,
  CredentialWrite,
  EffectiveAccess,
  ObjectRef,
  SettingSource,
} from '../../api/types';
import type { Session } from '../../auth/session';
import { fieldsOf, seedDefaults, type FieldModel, type JsonSchema } from '../../forms/schema';
import type { FieldProblem } from '../../forms/validate';

/**
 * The credential tab's judgements (`U-21`), apart from the component that draws them: who may
 * change a set, what to call where it came from, what a write is about to do, and the sentences
 * that say so. `test/credentials-model.test.ts` asserts them without rendering anything.
 *
 * **Every number in a sentence here is one the core answered.** How many sensors a narrowing
 * keeps a set from, which secrets a widening clears and how many sensors lose a removed set are
 * each decided by rules that live in the core (`A-41`, `A-41b`). This file words the answers and
 * decides nothing.
 */

// ---------------------------------------------------------------------------------------------
// Who may change a set.
// ---------------------------------------------------------------------------------------------

/**
 * Whether the tab has to ask what this account may do on the object.
 *
 * Only where the core holds anybody to grants at all. With `api.requireAuthentication` off the
 * authorisation layer stands down for every caller, signed in or not, and the route that answers
 * the question refuses a caller with no account.
 */
export function asksForRight(session: Session): boolean {
  return session.kind === 'signed-in' && session.requireAuthentication;
}

/**
 * Whether to offer the controls that change a set.
 *
 * **A convenience, and the core is the guard**: every write is held to `write` on the object
 * whatever this says. What it buys is that an account that may only read is shown a page with no
 * buttons that would be refused. Until the answer arrives, and if it cannot be had, the tab is
 * read-only: offering a control and then refusing it is the worse mistake.
 */
export function mayWrite(session: Session, access: Loadable<EffectiveAccess>): boolean {
  if (session.kind !== 'signed-in' && session.kind !== 'anonymous') return false;
  if (!asksForRight(session)) return !session.requireAuthentication;
  return (
    access.status === 'ready' && (access.data.right === 'write' || access.data.right === 'full')
  );
}

// ---------------------------------------------------------------------------------------------
// Where a set comes from.
// ---------------------------------------------------------------------------------------------

export type Owner =
  /** Stored on the object the tab is about. */
  | { readonly kind: 'here' }
  /** Stored on an ancestor this reader can see, which is where it is edited. */
  | { readonly kind: 'ancestor'; readonly id: number; readonly name: string }
  /** Stored on an ancestor outside this reader's view: said, and not named or linked (`A-12`). */
  | { readonly kind: 'outside' };

/**
 * The object a set is stored on, as this reader may be told it.
 *
 * `ancestors` is the breadcrumb, which the core has already trimmed to what the reader can see.
 * So an owner that is not in it is outside their view, and the tab says that much and no more:
 * no name, no link, and not the id either, which the read does carry as a reference. `null` is
 * the breadcrumb still loading, and is treated the same way rather than guessed at.
 */
export function ownerOf(
  source: SettingSource,
  objectId: number,
  ancestors: readonly Pick<ObjectRef, 'id' | 'name'>[] | null,
): Owner {
  if (source.kind === 'default') return { kind: 'outside' };
  if (source.kind === 'own' || source.objectId === objectId) return { kind: 'here' };
  const named = ancestors?.find((ancestor) => ancestor.id === source.objectId);
  return named === undefined
    ? { kind: 'outside' }
    : { kind: 'ancestor', id: named.id, name: named.name };
}

/** The owner in running text: the object's name, or "an object outside your view". */
export function ownerName(owner: Owner, object: { name: string }): string {
  if (owner.kind === 'here') return object.name;
  return owner.kind === 'ancestor' ? owner.name : 'an object outside your view';
}

// ---------------------------------------------------------------------------------------------
// What a set shows, and what its form starts from.
// ---------------------------------------------------------------------------------------------

/** A kind's schema, as the form generator reads it. */
export function schemaOf(kind: CredentialKindSummary): JsonSchema {
  return kind.schema;
}

/** The kind's name for a set, or its id when this build's catalogue does not know it. */
export function kindName(kinds: readonly CredentialKindSummary[], id: string): string {
  return kinds.find((kind) => kind.id === id)?.name ?? id;
}

function shown(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (Array.isArray(value)) {
    const entries = (value as unknown[]).map((entry) => shown(entry)).filter((e) => e !== null);
    return entries.length === 0 ? null : entries.join(', ');
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/**
 * A set's public fields as rows to read: the label its form would use, and the value.
 *
 * In the kind's own order, and only the fields that hold something. **A `writeOnly` field is
 * skipped by its declaration, not by its absence from the read**: the core never returns one, and
 * a row that depended on that would start showing a secret the day a read got it wrong.
 * A field the catalogue does not declare is shown under its own name rather than dropped.
 */
export function publicRows(
  schema: JsonSchema,
  publicParams: Readonly<Record<string, unknown>>,
): { name: string; label: string; value: string }[] {
  const fields = fieldsOf(schema);
  const secret = new Set(fields.filter((field) => field.writeOnly).map((field) => field.name));
  const rows: { name: string; label: string; value: string }[] = [];
  const add = (name: string, label: string): void => {
    if (secret.has(name)) return;
    const value = shown(publicParams[name]);
    if (value !== null) rows.push({ name, label, value });
  };
  for (const field of fields) add(field.name, field.label);
  const declared = new Set(fields.map((field) => field.name));
  for (const name of Object.keys(publicParams)) if (!declared.has(name)) add(name, name);
  return rows;
}

/**
 * What a form starts from: the stored public half, or the kind's declared defaults for a new set.
 *
 * Never a secret. An existing set's are on the server and stay there unless replaced, and
 * `seedDefaults` skips every `writeOnly` field.
 */
export function draftFor(schema: JsonSchema, set: CredentialView | null): Record<string, unknown> {
  return set === null ? seedDefaults(schema) : { ...set.publicParams };
}

function secretFieldsOf(schema: JsonSchema): FieldModel[] {
  return fieldsOf(schema).filter((field) => field.writeOnly);
}

/**
 * What a save will do to each secret, by the field's label.
 *
 * The form shows a stored secret as "set, write-only" whether it is being kept or cleared, since
 * it cannot show the secret either way. So the choice is said in words beside the save button:
 * a value typed replaces, `null` is the API's explicit unset, and a field left out is kept.
 */
export function secretChanges(
  schema: JsonSchema,
  values: Readonly<Record<string, unknown>>,
  stored: readonly string[],
): { replaced: string[]; cleared: string[]; added: string[] } {
  const replaced: string[] = [];
  const cleared: string[] = [];
  const added: string[] = [];
  for (const field of secretFieldsOf(schema)) {
    const value = values[field.name];
    const held = stored.includes(field.name);
    if (value === null) {
      if (held) cleared.push(field.label);
    } else if (typeof value === 'string' && value !== '') {
      (held ? replaced : added).push(field.label);
    }
  }
  return { replaced, cleared, added };
}

/** `secretChanges` as the sentence beside the save button, or null when no secret changes. */
export function secretChangeSentence(changes: ReturnType<typeof secretChanges>): string | null {
  const parts: string[] = [];
  if (changes.added.length > 0) parts.push(`${list(changes.added)} will be stored`);
  if (changes.replaced.length > 0) parts.push(`${list(changes.replaced)} will be replaced`);
  if (changes.cleared.length > 0) parts.push(`${list(changes.cleared)} will be removed`);
  return parts.length === 0 ? null : `On save: ${parts.join('; ')}.`;
}

/** Whether anything differs from what is stored, so a save has something to send. */
export function isDirty(
  values: Readonly<Record<string, unknown>>,
  set: CredentialView | null,
  schema: JsonSchema,
): boolean {
  if (set === null) return true;
  const changes = secretChanges(schema, values, set.secretsSet ?? []);
  if (changes.added.length + changes.replaced.length + changes.cleared.length > 0) return true;
  const secret = new Set(secretFieldsOf(schema).map((field) => field.name));
  const publicOf = (source: Readonly<Record<string, unknown>>): string =>
    JSON.stringify(
      Object.entries(source)
        .filter(([name]) => !secret.has(name))
        .sort(([a], [b]) => a.localeCompare(b)),
    );
  return publicOf(values) !== publicOf(set.publicParams);
}

/** The kinds this object has no set of its own for, which are the ones it can be given. */
export function kindsToAdd(
  kinds: readonly CredentialKindSummary[],
  items: readonly CredentialView[],
): CredentialKindSummary[] {
  const own = new Set(items.filter((item) => item.source.kind === 'own').map((item) => item.kind));
  return kinds.filter((kind) => !own.has(kind.id));
}

// ---------------------------------------------------------------------------------------------
// What a write is about to do, and what it did.
// ---------------------------------------------------------------------------------------------

/**
 * The four counts a write answers with: outside after it, before it, put there, brought back.
 * And each of them for the two reasons a sensor is outside (`A-59`).
 */
export type BoundsChange = Pick<
  CredentialWrite,
  'withholds' | 'withheldBefore' | 'newlyWithheld' | 'noLongerWithheld' | 'byReason'
>;

/**
 * Whether a previewed write has to be confirmed before it is made.
 *
 * Two things a save can do that nobody asked for by name: put sensors outside the set's bounds,
 * which takes them to Unknown and pages as Unknown does, and clear a secret because the bounds
 * widened. Either is worth a second look; a save that does neither goes straight through.
 *
 * **Sensors the save puts outside, not sensors that are outside** (`A-55`). A set with six
 * sensors outside its bounds already asked for a confirmation on every save, whatever the save
 * changed, and an operator learns to press "Save anyway" from being asked that way.
 */
export function needsConfirmation(
  preview: Pick<CredentialWrite, 'newlyWithheld' | 'secretsCleared'>,
): boolean {
  return preview.newlyWithheld > 0 || preview.secretsCleared.length > 0;
}

function plural(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

function list(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1] ?? ''}`;
}

/** The labels a kind gives these secret names, in the order the core named them. */
export function secretLabels(schema: JsonSchema, names: readonly string[]): string[] {
  const fields = secretFieldsOf(schema);
  return names.map((name) => fields.find((field) => field.name === name)?.label ?? name);
}

/**
 * What "outside a set's bounds" means, for the confirmation that says a save puts sensors there.
 *
 * Two cases, and the second is the one nobody guesses (`A-55`, `A-41c`): a device entered by name
 * has no address for the core to compare with targets that are addresses. A sensor whose type
 * can be held to an address its probe checked is left to the probe and is not counted. One whose
 * type cannot is outside, whatever the name resolves to.
 *
 * "A sensor is also outside", not "It is": the sentence before ends on the targets (`A-59`).
 */
export const OUTSIDE_MEANS =
  "A sensor is outside a set's bounds when its device's address is not one the allowed targets " +
  'cover. A sensor is also outside when its device is entered by name, the targets are ' +
  "addresses, and the sensor's type cannot be held to an address its probe has checked: " +
  'whatever the name resolves to, the set is not sent.';

/**
 * Why some sensors are outside, as the end of a sentence about them (`A-59`): how many are on a
 * device the targets do not cover, and how many on a device entered by name whose sensor type
 * cannot be held to a checked address. The two want different remedies, and one number for both
 * left an operator to open every sensor to find out which.
 *
 * Each number is said with what it counts, so the phrase reads the same aloud as on the page.
 * One reason alone is said without its number, which the sentence before has just given. Empty
 * when the core gave no reason for any of them, so the sentence before it stands as it is.
 */
export function reasonsPhrase(outside: number, unpinnable: number): string {
  const covered = (count: number): string =>
    count === 1
      ? 'on a device the allowed targets do not cover'
      : 'on devices the allowed targets do not cover';
  const named = (count: number): string =>
    `on ${count === 1 ? 'a device' : 'devices'} entered by name, with a sensor type that ` +
    'cannot be held to a checked address';
  if (outside > 0 && unpinnable > 0) {
    return `: ${String(outside)} ${covered(outside)}, and ${String(unpinnable)} ${named(unpinnable)}`;
  }
  const count = outside + unpinnable;
  if (count <= 0) return '';
  return `: ${count === 1 ? '' : 'all '}${outside > 0 ? covered(count) : named(count)}`;
}

/**
 * What a save does to which sensors are outside a set's bounds, before the save and after it.
 *
 * Three numbers, each said only when it is not zero: the sensors this save puts outside, the
 * ones it brings back, and the ones that were outside already and stay there. The first is what
 * the operator is being asked about; the other two are said so that the first is not taken for
 * the whole, and so that a save which moves the bounds without changing how many are outside
 * does not read as a save that changes nothing.
 *
 * **The sensors outside after the save are said by reason** (`A-59`), the ones the save puts
 * there and the ones it leaves there. The ones it brings back are not: why a sensor was outside
 * is nothing to act on once it is inside.
 *
 * **Read aloud, every sentence names what it is about.** After a sentence that ends on devices
 * and targets, "it" could be any of them: the next one says "that sensor" and "the save".
 */
export function boundsSentence(
  change: BoundsChange,
  objectName: string,
  tense: 'will' | 'now',
): string | null {
  const will = tense === 'will';
  const added = change.newlyWithheld;
  const back = change.noLongerWithheld;
  const staying = Math.max(0, change.withholds - added);
  const { outside, unpinnable } = change.byReason;
  const parts: string[] = [];
  if (added > 0) {
    const one = added === 1;
    const sensors = plural(added, 'sensor', 'sensors');
    const why = reasonsPhrase(outside.newlyWithheld, unpinnable.newlyWithheld);
    const those = one ? 'That sensor is' : 'Those sensors are';
    parts.push(
      will
        ? `This save puts ${sensors} beneath ${objectName} outside this set's bounds${why}. ` +
            `${those} not sent the set after the save and ` +
            `${one ? 'reads' : 'read'} Unknown until the bounds include ${one ? 'it' : 'them'}.`
        : `This save put ${sensors} beneath ${objectName} outside its bounds${why}. ` +
            `${those} not sent the set and ${one ? 'reads' : 'read'} Unknown.`,
    );
  }
  if (back > 0) {
    const sensors = plural(back, 'sensor', 'sensors');
    // Not "It": the sentence before ends on the sensor, and a listener hears these in a line.
    const subject = added > 0 ? 'The save also' : 'This save';
    parts.push(
      will
        ? `${subject} brings ${sensors}${added > 0 ? '' : ` beneath ${objectName}`} back ` +
            'inside, to be sent the set again.'
        : `${subject} brought ${sensors}${added > 0 ? '' : ` beneath ${objectName}`} back inside.`,
    );
  }
  if (staying > 0) {
    const one = staying === 1;
    const sensors = plural(staying, 'sensor', 'sensors');
    // Outside after the save and not put there by it, for each reason as the core gives it
    // after the save: a sensor that stays outside for another reason than before is counted
    // under the one that holds now.
    const why = reasonsPhrase(
      Math.max(0, outside.withholds - outside.newlyWithheld),
      Math.max(0, unpinnable.withholds - unpinnable.newlyWithheld),
    );
    parts.push(
      will
        ? `${sensors} beneath ${objectName} ${one ? 'is' : 'are'} outside already and this ` +
            `save leaves ${one ? 'it' : 'them'} there${why}.`
        : `${sensors} beneath ${objectName} ${one ? 'was' : 'were'} outside already and still ` +
            `${one ? 'is' : 'are'}${why}.`,
    );
  }
  return parts.length === 0 ? null : parts.join(' ');
}

/** Which secrets a widening clears, before the save and after it. */
export function clearedSentence(labels: readonly string[], tense: 'will' | 'now'): string | null {
  if (labels.length === 0) return null;
  const it = labels.length === 1 ? 'it' : 'them';
  return tense === 'will'
    ? `This save lets the set go further than before, so ${list(labels)} will be cleared. ` +
        `Go back and enter ${it} again to keep ${it}.`
    : `Cleared because the set may now go further: ${list(labels)}. Enter ${it} again, or the ` +
        'sensors using this set cannot authenticate.';
}

/** What a finished save says, for the live region: the write's own answer, in words. */
export function savedSentence(
  kind: string,
  objectName: string,
  result: CredentialWrite,
  schema: JsonSchema,
): string {
  return [
    `Saved the ${kind} set on ${objectName}.`,
    boundsSentence(result, objectName, 'now'),
    clearedSentence(secretLabels(schema, result.secretsCleared), 'now'),
  ]
    .filter((part) => part !== null)
    .join(' ');
}

/**
 * What removing a set takes it from, and what those sensors use instead.
 *
 * From a previewed removal before it is confirmed, and from the removal itself afterwards. A set
 * coming into force from an ancestor outside the reader's view is said to exist, and not named.
 */
export function removalSentence(
  kind: string,
  object: { id: number; name: string },
  outcome: Pick<CredentialRemoval, 'sensors' | 'nowInherited'>,
  ancestors: readonly Pick<ObjectRef, 'id' | 'name'>[] | null,
  tense: 'will' | 'now',
): string {
  const { sensors, nowInherited } = outcome;
  if (sensors === 0) {
    return tense === 'will'
      ? `No sensor beneath ${object.name} uses this set, so nothing loses a credential.`
      : `No sensor beneath ${object.name} was using it.`;
  }
  const who = plural(sensors, 'sensor', 'sensors');
  const lead =
    tense === 'will'
      ? `${who} beneath ${object.name} ${sensors === 1 ? 'uses' : 'use'} this set and will lose it.`
      : `${who} beneath ${object.name} lost it.`;
  const they = sensors === 1 ? 'It' : 'They';
  if (nowInherited === null) {
    return tense === 'will'
      ? `${lead} Nothing above defines ${kind} credentials, so ${they.toLowerCase()} will have ` +
          `none and ${sensors === 1 ? 'its' : 'their'} checks will fail to authenticate.`
      : `${lead} Nothing above defines ${kind} credentials, so ${they.toLowerCase()} ` +
          `${sensors === 1 ? 'has' : 'have'} none.`;
  }
  const from = ownerName(ownerOf(nowInherited.source, object.id, ancestors), object);
  return tense === 'will'
    ? `${lead} ${they} will use the set on ${from} instead.`
    : `${lead} ${they} now ${sensors === 1 ? 'uses' : 'use'} the set on ${from}.`;
}

// ---------------------------------------------------------------------------------------------
// A refusal, on the field it is about.
// ---------------------------------------------------------------------------------------------

/**
 * The fields a refused write names, so the message lands on the control.
 *
 * Two validators, as everywhere: the request schema's problems carry a path, and the vault's own
 * refusal names its field in the error's context (`allowedTargets/2` for the third target).
 * `values` is the vault's word for "the whole document", which is no field.
 */
export function refusedFields(error: ApiError): FieldProblem[] {
  const problems: FieldProblem[] = (error.details.problems ?? [])
    .map((problem) => ({
      path: problemPath(problem).replace(/^values\./u, ''),
      message: problem.message ?? 'was refused',
    }))
    .filter((problem) => problem.path !== '' && problem.path !== 'values');
  const field = error.context['field'];
  if (typeof field === 'string' && field !== '' && field !== 'values') {
    problems.push({ path: field.replace(/\//gu, '.'), message: error.message });
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// The list of sets without bounds.
// ---------------------------------------------------------------------------------------------

/** Where the list of sets without bounds lives. */
export const UNBOUNDED_PATH = '/credentials/unbounded';
