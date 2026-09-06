import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthPage } from './auth/AuthPage';
import { ChangePasswordForm } from './auth/ChangePasswordForm';
import { LoginView } from './auth/LoginView';
import { mustChangePassword, showsLoginForm, useSession } from './auth/session';
import { Layout } from './components/Layout';
import { ErrorPanel } from './components/Panels';
import { AlarmsView } from './routes/AlarmsView';
import { AddSensor } from './routes/AddSensor';
import { LogsView } from './routes/LogsView';
import { Overview } from './routes/Overview';
import { PasswordView } from './routes/PasswordView';
import { TemplatesView } from './routes/TemplatesView';
import { DiscoveryView } from './routes/DiscoveryView';
import { TreeView } from './routes/TreeView';
import { ObjectDetailView } from './routes/ObjectDetailView';
import { SensorTypesView } from './routes/SensorTypesView';

/**
 * The routes, and the two things that can stand in front of them (`U-17`).
 *
 * **Both stand-ins replace the application rather than routing to it**, so the address bar keeps
 * whatever the operator was trying to reach and they land there once they are through. The order
 * matters and is the order a person meets them: the core has to be answering, then somebody has
 * to be logged in when the core insists on it, then the password in use has to be one they chose.
 */
export function App(): React.JSX.Element {
  const { session, askingToSignIn } = useSession();

  if (session.kind === 'unknown') {
    // One request, on a same-origin route that touches no database. A spinner here would be
    // spent before it drew.
    return <div className="min-h-screen bg-bg" />;
  }

  if (session.kind === 'unreachable') {
    return (
      <AuthPage title="Cannot reach the core">
        <div className="mt-4">
          <ErrorPanel error={session.error} />
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

  return (
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
        <Route path="password" element={<PasswordView />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
