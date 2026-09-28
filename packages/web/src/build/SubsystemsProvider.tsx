import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useApi } from '../api/client';
import {
  EVERYTHING,
  offerOf,
  subsystemsOf,
  SubsystemsContext,
  useSubsystems,
  type Subsystem,
} from './subsystems';

/**
 * Asks the core once which optional subsystems it constructed (`H-12`).
 *
 * Mounted inside the login gate, because `GET /build` is read-scoped. **A failed answer is
 * everything**, which is what this UI showed before it asked: a core too old to have the route
 * had every subsystem, and a core that cannot answer this one request will not be answering the
 * pages either.
 */
export function SubsystemsProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const build = useApi<unknown>('/build');
  const value =
    build.status === 'ready'
      ? subsystemsOf(build.data)
      : build.status === 'error'
        ? EVERYTHING
        : undefined;
  return <SubsystemsContext.Provider value={value}>{children}</SubsystemsContext.Provider>;
}

/**
 * A page that exists only when its subsystem does.
 *
 * Nothing while the core has not said, so a v1 build never requests a route it did not register;
 * home once the core has said no, so a bookmark to a page this build does not have lands
 * somewhere rather than on an error.
 */
export function Offered({
  name,
  children,
}: {
  name: Subsystem;
  children: ReactNode;
}): React.JSX.Element | null {
  const offer = offerOf(useSubsystems(), name);
  if (offer === 'unknown') return null;
  if (offer === 'absent') return <Navigate to="/" replace />;
  return <>{children}</>;
}
