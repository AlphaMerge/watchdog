import { createContext, useContext } from 'react';

/**
 * Which optional subsystems the core constructed, as `GET /build` reports them (`H-12`).
 *
 * **Asked of the core, never inferred from its profile.** The core answers from the services it
 * actually registered routes for, so a page this UI offers is a page the core will answer — and
 * the day a profile's meaning changes, nothing here has to learn it.
 *
 * The types and the hook live here rather than beside the provider so this file exports no
 * component (`react-refresh/only-export-components`), as `auth/session.ts` does.
 */

export type Subsystem = 'maps' | 'reports' | 'libraries';

export type Subsystems = Readonly<Record<Subsystem, boolean>>;

const SUBSYSTEMS: readonly Subsystem[] = ['maps', 'reports', 'libraries'];

/** What a core that does not say had: everything, which every core before `H-12` did. */
export const EVERYTHING: Subsystems = { maps: true, reports: true, libraries: true };

/**
 * The subsystems a `GET /build` body names.
 *
 * **A body that names none is a core from before `H-12`, not one with nothing**, so it reads as
 * everything — the behaviour that core's UI had. Only an explicit `false` takes a page away.
 */
export function subsystemsOf(body: unknown): Subsystems {
  const named =
    typeof body === 'object' && body !== null && 'subsystems' in body ? body.subsystems : undefined;
  if (typeof named !== 'object' || named === null) return EVERYTHING;
  const answer = { ...EVERYTHING };
  for (const name of SUBSYSTEMS) {
    if ((named as Record<string, unknown>)[name] === false) answer[name] = false;
  }
  return answer;
}

/**
 * Undefined until the core has answered.
 *
 * **Three states, not two**: a link is shown only once a subsystem is known to be there, and a
 * page is taken away only once it is known not to be — so neither a v1 build flashes a Maps link
 * nor a full one bounces a deep link to `/maps/3` while the question is in flight.
 */
export const SubsystemsContext = createContext<Subsystems | undefined>(undefined);

export function useSubsystems(): Subsystems | undefined {
  return useContext(SubsystemsContext);
}

/** Whether `name` is known to be there, known not to be, or not yet known. */
export function offerOf(
  subsystems: Subsystems | undefined,
  name: Subsystem,
): 'offered' | 'absent' | 'unknown' {
  if (subsystems === undefined) return 'unknown';
  return subsystems[name] ? 'offered' : 'absent';
}
