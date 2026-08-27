import { NavLink, Outlet } from 'react-router-dom';
import { useTheme } from '../theme/useTheme';

const NAV = [
  { to: '/', label: 'Overview', end: true },
  // Second, and before the tree: `WORKFLOW.MD §7` calls the alarms view the operator's home
  // screen, and the thing somebody opens this product to look at belongs near the front.
  { to: '/alarms', label: 'Alarms', end: false },
  { to: '/tree', label: 'Tree', end: false },
  { to: '/logs', label: 'Logs', end: false },
  { to: '/discovery', label: 'Discovery', end: false },
  { to: '/templates', label: 'Templates', end: false },
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

          {/*
            Wraps rather than overflows. Six links do not fit 375px, and a header that pushed the
            document 60px wider made *every* page scroll sideways — WCAG 1.4.10 asks for reflow
            at 320px, and the thing that broke it was the same on all of them.
          */}
          <nav aria-label="Sections" className="flex flex-wrap items-center gap-1">
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

          {/*
            The name stays "Dark theme" and `aria-pressed` carries the state. It used to read
            "Light theme" when off and "Dark theme" when on, which is a toggle whose label
            changes underneath the state it is reporting: a screen reader announced "Light
            theme, not pressed", and both halves have to be read together to work out that
            pressing it turns the lights *off*. One name, one state.
          */}
          <button
            type="button"
            onClick={toggle}
            aria-pressed={theme === 'dark'}
            className="ml-auto rounded border border-control px-2.5 py-1.5 text-sm text-text-muted hover:text-text"
          >
            Dark theme
          </button>
        </div>
      </header>

      <main id="main" className="mx-auto max-w-6xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
