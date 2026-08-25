import type { ObjectId } from '../objects/types.js';

/**
 * The three modes `WORKFLOW.MD §5` and `CAPABILITIES.MD §5` name, plus the one they imply.
 *
 * They are not three mechanisms. Underneath there is one inheritable setting — the master this
 * object depends on — and each mode is a different place to write it:
 *
 * - `parent` writes nothing and clears any local value, which *is* inheriting.
 * - `object` writes the chosen master here.
 * - `device` writes *this sensor* as the master of its parent device, so every other sensor on
 *   the device inherits it. PRTG's "master object for parent device", and what auto-discovery
 *   sets on a device's Ping sensor.
 * - `none` writes an explicit null, which is how one sensor is exempted from a dependency its
 *   device carries.
 */
export type DependencyMode = 'parent' | 'object' | 'device' | 'none';

/** Where the setting goes and what it says. The whole of what a mode resolves to. */
export interface DependencyWrite {
  /** The object whose setting is written — not always the one the request named. */
  readonly targetId: ObjectId;
  /** `undefined` clears the local value (inherit); `null` means "depend on nothing". */
  readonly masterId: ObjectId | null | undefined;
}

export interface DependencySubject {
  readonly id: ObjectId;
  readonly kind: string;
  /** The parent device, for `device` mode. Null when the subject is not a sensor. */
  readonly parentId: ObjectId | null;
  readonly parentKind: string | null;
}

/**
 * Turns a mode into the one write that expresses it, or says why it cannot.
 *
 * Pure, because the interesting part is the refusals: `device` mode only means anything on a
 * sensor whose parent is a device, and `object` mode needs an object to point at. Both are
 * things a UI can get wrong and neither should reach the database.
 */
export function resolveDependencyMode(
  mode: DependencyMode,
  subject: DependencySubject,
  masterId: ObjectId | undefined,
): { write: DependencyWrite } | { problems: string[] } {
  switch (mode) {
    case 'parent':
      return { write: { targetId: subject.id, masterId: undefined } };

    case 'none':
      return { write: { targetId: subject.id, masterId: null } };

    case 'object':
      if (masterId === undefined) {
        return { problems: ['select an object to depend on, or choose another mode'] };
      }
      if (masterId === subject.id) {
        // Excluded at evaluation too, but a request that says it out loud is a mistake worth
        // naming rather than silently accepting and then ignoring.
        return { problems: ['an object cannot depend on itself'] };
      }
      return { write: { targetId: subject.id, masterId } };

    case 'device': {
      if (subject.kind !== 'sensor') {
        return {
          problems: [
            'only a sensor can be the master object for its parent device; for anything else, ' +
              'point the device at a sensor with mode "object"',
          ],
        };
      }
      if (subject.parentId === null || subject.parentKind !== 'device') {
        return { problems: ["this sensor's parent is not a device"] };
      }
      // The write lands on the *device*, which is what makes every other sensor under it inherit
      // this one as their master — and what keeps this sensor scanning, because a master never
      // depends on itself.
      return { write: { targetId: subject.parentId, masterId: subject.id } };
    }
  }
}
