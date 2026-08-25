import { NavLink, Outlet } from 'react-router-dom';
import { useTheme } from '../theme/useTheme';

const NAV = [
  { to: '/', label: 'Overview', end: true },
  { to: '/tree', label: 'Tree', end: false },
  { to: '/sensor-types', label: 'Sensor types', end: false },
];

export function Layout(): React.JSX.Element {
  const { theme, toggle } = useTheme();

  return (
    <div className="min-h-screen bg-bg">
      {/* WCAG 2.4.1: a keyboard user must be able to skip the navigation. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded focus:bg-accent focus:px-3 focus:py-2 focus:text-accent-contrast"
      >
        Skip to content
      </a>

      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <span className="text-sm font-semibold tracking-tight text-text">MonitoringSystem</span>

          <nav aria-label="Sections" className="flex items-center gap-1">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  `rounded px-2.5 py-1.5 text-sm ${
                    isActive
                      ? 'bg-surface-muted font-medium text-text'
                      : 'text-text-muted hover:text-text'
                  }`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>

          <button
            type="button"
            onClick={toggle}
            aria-pressed={theme === 'dark'}
            className="ml-auto rounded border border-border px-2.5 py-1.5 text-sm text-text-muted hover:text-text"
          >
            {theme === 'dark' ? 'Dark' : 'Light'} theme
          </button>
        </div>
      </header>

      <main id="main" className="mx-auto max-w-6xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
