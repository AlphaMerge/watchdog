import { useEffect } from 'react';
import type { ReactNode } from 'react';

const SITE = 'MonitoringSystem';

/**
 * The frame the login and change-password forms are shown in (`U-17`).
 *
 * **Deliberately not `PageTitle`.** These two forms replace the whole application rather than
 * being routed to, so the URL underneath them is still the page the operator was trying to
 * reach — which is exactly what makes it worth keeping, because logging in should return them
 * there. `PageTitle` keys its focus handling on that pathname and records it as "the page we
 * are now on"; using it here would spend the arrival announcement on the login form and leave
 * the page it hands over to unannounced.
 *
 * The form's first field takes focus instead — see `LoginView`. On a form that replaced the
 * page without a navigation, the field is the more useful landing place than the heading, and a
 * screen reader reads the label with it.
 */
export function AuthPage({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}): React.JSX.Element {
  useEffect(() => {
    document.title = `${title} — ${SITE}`;
  }, [title]);

  return (
    <div className="flex min-h-screen items-start justify-center bg-bg px-4 py-16">
      <div className="w-full max-w-sm">
        <p className="ms-label mb-4 text-text">{SITE}</p>
        <section className="border border-border bg-surface p-5">
          <h1 className="text-xl tracking-[-0.02em] text-text">{title}</h1>
          {children}
        </section>
      </div>
    </div>
  );
}
