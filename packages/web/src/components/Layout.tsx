import { NavLink, Outlet } from 'react-router-dom';
import { useSession } from '../auth/session';
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

/**
 * Who is signed in, and the two things they can do about it (`U-17`).
 *
 * **The role is shown next to the login and is not decoration.** Most of what this UI refuses is
 * refused by role, and "why is that button not there" is answered by the word `readonly` sitting
 * beside the name — without it the answer is a support conversation.
 */
function Account(): React.JSX.Element | null {
  const { session, signOut, askToSignIn } = useSession();

  if (session.kind === 'anonymous') {
    // Only reachable with `api.requireAuthentication` off — otherwise the login form is the
    // page. Offered rather than hidden because an anonymous operator's changes are audited as
    // `anonymous`, and somebody may want their name on them.
    return (
      <button
        type="button"
        onClick={() => {
          askToSignIn(true);
        }}
        className="ms-label border border-control px-2.5 py-1 hover:text-text"
      >
        Log in
      </button>
    );
  }

  if (session.kind !== 'signed-in') return null;

  return (
    <>
      {/*
        Marked with a rule in the accent when it is the current page, the same way the section
        links above are — and for a second reason here: `.ms-label` sets a colour of its own and
        is unlayered, so it beats a Tailwind text utility. A state carried by ink would simply
        not appear.
      */}
      <NavLink
        to="/password"
        className={({ isActive }) =>
          `ms-label border-b-2 py-1 hover:text-text ${
            isActive ? 'border-accent' : 'border-transparent'
          }`
        }
      >
        {session.principal.login}
        <span className="ml-1.5 normal-case">({session.principal.role})</span>
      </NavLink>
      <button
        type="button"
        onClick={() => {
          void signOut();
        }}
        className="ms-label border border-control px-2.5 py-1 hover:text-text"
      >
        Log out
      </button>
    </>
  );
}

export function Layout(): React.JSX.Element {
  const { theme, toggle } = useTheme();

  return (
    <div className="min-h-screen bg-bg">
      {/* WCAG 2.4.1: a keyboard user must be able to skip the navigation. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:bg-accent focus:px-3 focus:py-2 focus:text-accent-contrast"
      >
        Skip to content
      </a>

      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <span className="ms-label text-text">MonitoringSystem</span>

          {/*
            Wraps rather than overflows. Six links do not fit 375px, and a header that pushed the
            document 60px wider made *every* page scroll sideways — WCAG 1.4.10 asks for reflow
            at 320px, and the thing that broke it was the same on all of them.
          */}
          <nav aria-label="Sections" className="flex flex-wrap items-center gap-x-4 gap-y-1">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                /*
                  The current section is marked with a rule under it in the accent, not a filled
                  pill: a fill is a second surface colour competing with the panels below, and at
                  seven items the row of pills was reading as a toolbar of buttons rather than as
                  a set of places. `aria-current` is what actually announces it — the rule and the
                  ink are the sighted half of the same statement.
                */
                className={({ isActive }) =>
                  `border-b-2 py-1 text-sm ${
                    isActive
                      ? 'border-accent text-text'
                      : 'border-transparent text-text-muted hover:text-text'
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
          <div className="ms-label ml-auto flex flex-wrap items-center gap-3">
            <Account />
            <button
              type="button"
              onClick={toggle}
              aria-pressed={theme === 'dark'}
              className="ms-label border border-control px-2.5 py-1 hover:text-text aria-pressed:border-accent aria-pressed:text-accent"
            >
              Dark theme
            </button>
          </div>
        </div>
      </header>

      <main id="main" className="mx-auto max-w-6xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
