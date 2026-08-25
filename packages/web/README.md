# @ms/web

The web UI. Served by `ms-core` as static assets — there is no second web server to install.

**Not built yet.** The workspace exists so the monorepo layout matches `PLAN.md`, but the
frontend is Phase 5 work and starts at `U-01`:

- React 19 + TypeScript + Vite 8 (`ADR-001` Decision 8)
- uPlot for dense time-series panels, ECharts for topology and summary widgets
- Light and dark themes, WCAG 2.1 AA, keyboard navigable
- Settings forms generated from each sensor type's `paramsSchema` (`U-08`), so a new sensor
  type needs no frontend work

React and Vite are deliberately _not_ dependencies yet: nothing consumes them until Phase 5,
and an unused dependency tree is maintenance with no return.
