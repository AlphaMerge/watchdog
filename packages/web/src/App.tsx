import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthPage } from './auth/AuthPage';
import { ChangePasswordForm } from './auth/ChangePasswordForm';
import { LoginView } from './auth/LoginView';
import { mustChangePassword, showsLoginForm, useSession } from './auth/session';
import { Offered, SubsystemsProvider } from './build/SubsystemsProvider';
import { Layout } from './components/Layout';
import { ReadRegion } from './components/ReadRegion';
import { AlarmsView } from './routes/AlarmsView';
import { AddSensor } from './routes/AddSensor';
import { LogsView } from './routes/LogsView';
import { MapDesignView } from './routes/MapDesignView';
import { MapView } from './routes/MapView';
import { SharedMapView } from './routes/SharedMapView';
import { MapsView } from './routes/MapsView';
import { ReportsView } from './routes/ReportsView';
import { ReportView } from './routes/ReportView';
import { Overview } from './routes/Overview';
import { PasswordView } from './routes/PasswordView';
import { TemplatesView } from './routes/TemplatesView';
import { DiscoveryView } from './routes/DiscoveryView';
import { TreeView } from './routes/TreeView';
import { ObjectDetailView } from './routes/ObjectDetailView';
import { SensorTypesView } from './routes/SensorTypesView';
import { UnboundedCredentialsView } from './routes/UnboundedCredentialsView';
import { ChannelsWithoutLookupView } from './routes/ChannelsWithoutLookupView';

/**
 * The routes, and the two things that can stand in front of them (`U-17`).
 *
 * **Both stand-ins replace the application rather than routing to it**, so the address bar keeps
 * whatever the operator was trying to reach and they land there once they are through. The order
 * matters and is the order a person meets them: the core has to be answering, then somebody has
 * to be logged in when the core insists on it, then the password in use has to be one they chose.
 */
export function App(): React.JSX.Element {
  const { session, askingToSignIn, refresh } = useSession();

  /**
   * **A shared map is rendered before any of the three stand-ins** (`G-06`).
   *
   * The whole point of a share link is that the person holding it has no account, so a page that
   * waited for the session probe would show them a login form for a system they cannot log into.
   * Read from `location` rather than through the router because the router is below this: the
   * three gates replace the application, and this has to be decided before them.
   */
  if (window.location.pathname.startsWith('/shared/')) {
    return (
      <Routes>
        <Route path="/shared/:token" element={<SharedMapView />} />
      </Routes>
    );
  }

  if (session.kind === 'unknown') {
    // One request, and the page it is deciding between is a login form — a spinner in front of
    // that reads as the application loading, which is the one thing it is not yet doing.
    return <div className="min-h-screen bg-bg" />;
  }

  if (session.kind === 'unreachable') {
    // **With a retry, because this state has no other exit.** The probe runs once per `nonce`,
    // and nothing else on this screen bumps it: a core that was restarting when the tab opened
    // would otherwise leave the operator on an error page until they thought to reload.
    return (
      <AuthPage title="Cannot reach the core">
        <div className="mt-4">
          <ReadRegion error={session.error} retry={refresh} />
        </div>
      </AuthPage>
    );
  }

  if (showsLoginForm(session, askingToSignIn)) return <LoginView />;

  if (mustChangePassword(session)) {
    return (
      <AuthPage title="Change your password">
        <ChangePasswordForm forced />
      </AuthPage>
    );
  }

  // **Maps and reports are pages only where the core built them** (`H-12`). A v1 build has
  // neither, and says so at `GET /build`; the routes wait for that answer rather than guessing.
  return (
    <SubsystemsProvider>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Overview />} />
          <Route path="alarms" element={<AlarmsView />} />
          <Route path="tree" element={<TreeView />} />
          <Route path="logs" element={<LogsView />} />
          <Route path="templates" element={<TemplatesView />} />
          <Route path="discovery" element={<DiscoveryView />} />
          <Route path="objects/:id" element={<ObjectDetailView />} />
          <Route path="objects/:id/add-sensor" element={<AddSensor />} />
          <Route path="sensor-types" element={<SensorTypesView />} />
          <Route path="credentials/unbounded" element={<UnboundedCredentialsView />} />
          <Route path="channels/without-lookup" element={<ChannelsWithoutLookupView />} />
          <Route
            path="maps"
            element={
              <Offered name="maps">
                <MapsView />
              </Offered>
            }
          />
          <Route
            path="maps/:id"
            element={
              <Offered name="maps">
                <MapView />
              </Offered>
            }
          />
          <Route
            path="maps/:id/design"
            element={
              <Offered name="maps">
                <MapDesignView />
              </Offered>
            }
          />
          <Route
            path="reports"
            element={
              <Offered name="reports">
                <ReportsView />
              </Offered>
            }
          />
          <Route
            path="reports/:id"
            element={
              <Offered name="reports">
                <ReportView />
              </Offered>
            }
          />
          {/*
          Signed in only. With `api.requireAuthentication` off an anonymous browser reaches the
          rest of this table, and a change-password form is the one page there whose request the
          core refuses unconditionally — `POST /auth/password` needs a principal whatever the
          flag says. A form that cannot succeed is worse than a page that is not there.
        */}
          {session.kind === 'signed-in' && <Route path="password" element={<PasswordView />} />}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </SubsystemsProvider>
  );
}
