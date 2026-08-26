import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { AlarmsView } from './routes/AlarmsView';
import { Overview } from './routes/Overview';
import { TreeView } from './routes/TreeView';
import { ObjectDetailView } from './routes/ObjectDetailView';
import { SensorTypesView } from './routes/SensorTypesView';

export function App(): React.JSX.Element {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Overview />} />
        <Route path="alarms" element={<AlarmsView />} />
        <Route path="tree" element={<TreeView />} />
        <Route path="objects/:id" element={<ObjectDetailView />} />
        <Route path="sensor-types" element={<SensorTypesView />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
