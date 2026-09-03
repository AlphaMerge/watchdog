# @ms/web

The web UI. Served by `ms-core` as static assets — there is no second web server to install
(`ADR-001` Decision 8).

**This file is how to develop it.** What each view is _for_, from an operator's side, is
[`docs/web-ui.md`](../../docs/web-ui.md).

**Scaffolded in `U-01`.** React 19 + TypeScript + Vite 8, Tailwind CSS 4, React Router 7.
The stack additions Decision 8 left open — styling and routing — are recorded in the amendment
at the end of that decision.

## Running it

The Vite dev server runs in Docker like everything else, and proxies `/api` to the core:

```bash
npm run dev            # PostgreSQL and friends
scripts/dev-certs.sh   # once, for the core↔probe channel
scripts/dev.sh "npm run build"
npm run dev:services   # ms-core + ms-probe, API on 127.0.0.1:8080
npm run dev:ui         # http://127.0.0.1:5173
```

The app calls `/api/v1/...` relative in both environments — the dev server proxies it, the core
serves it — so nothing needs a configured base URL.

The proxy sets `changeOrigin`, so the core sees `Host: 127.0.0.1:8080` alongside
`Origin: http://127.0.0.1:5173` and the CSRF guard would read a same-site write as a cross-origin
one. `dev/core.json` names both spellings of the dev server in `api.allowedOrigins`; a production
install behind a reverse proxy on its own hostname needs the same key (`A-11`).

For production, `scripts/package.sh` runs `vite build` and stages `dist` into the tarball;
`install.sh` puts it at `/opt/ms/web`, and `api.webRoot` in `core.json` points there. An empty
`webRoot` serves no UI at all, which is what a headless install wants.

## What is here

Phase 5 is complete — `U-01` through `U-13`. The routes are registered in `src/App.tsx`:

| Route                     | Shows                                                                     |
| ------------------------- | ------------------------------------------------------------------------- |
| `/`                       | Core reachability, object counts, sensor states, the registered catalogue |
| `/alarms`                 | What is in alarm, worst first, with acknowledge and pause on the row      |
| `/tree`                   | The object tree in the operator's own arrangement                         |
| `/logs`                   | Status changes, object history and system events, as three tabs           |
| `/discovery`              | Range sweeps, with the cost of each level shown before the choice         |
| `/templates`              | Notification templates, with live preview and test send                   |
| `/objects/:id`            | Overview, history, log, settings, triggers, changes                       |
| `/objects/:id/add-sensor` | The add form, generated from the chosen type's `paramsSchema`             |
| `/sensor-types`           | The catalogue and each type's parameter schema                            |

**States are real since `M-02`.** The overview counts sensors by state, worst first; the tree
colours each row; the detail page shows the state with its cause and since when, read from
`GET /sensors/:id/state` rather than from the object, because that read is conditional and a
live state behind an ETag would be served stale. A sensor still reads Unknown until its first
result, and again after a resume — that is the state, not a placeholder.

The channel table shows each channel's configured thresholds (`M-04`), ordered the way the
number line is, so the band a reading should stay inside reads as one thing.

**State is streamed; readings are polled, and the split is deliberate.** `U-02`'s WebSocket
(`src/api/stream.ts`) carries state changes, which is what the badges and the tree rollup need
and what has to be immediate. Channel _values_ change on every scan whether the state does or
not, and a frame per reading per sensor would be a stream nobody could keep up with — so the
channel table re-reads on a 15-second interval. Discovery progress polls too, for the same
reason inverted: a run lives for minutes and one operator is watching it, so pushing it would
mean a new message kind and a fan-out to every client for something one of them cares about.

## Design system

Tokens are CSS custom properties in `src/index.css`, defined on `:root` and overridden under
`[data-theme='dark']`, exposed to Tailwind through `@theme inline`. They are custom properties
rather than Tailwind theme keys because uPlot (`U-05`) draws to a canvas and cannot read a
utility class — but it can read a custom property, so the charts and the DOM share one palette.

Every `-fg` token meets WCAG 2.1 AA against its own surface in both themes. Colour is never the
only signal: `StatusBadge` pairs each of the six `WORKFLOW.MD` §4 states with a distinct glyph
and its name, which is what makes it readable to a screen reader and to a colour-blind operator.

## Where the tricky parts live

Each of these carries its reasoning in a header comment; read that before changing it.

| Concern                                   | File                   |
| ----------------------------------------- | ---------------------- |
| Fetching, errors, conditional reads       | `src/api/client.ts`    |
| The live state stream (`U-02`)            | `src/api/stream.ts`    |
| Tree flattening and rollup                | `src/tree/model.ts`    |
| Tree keyboard commands (`U-11`)           | `src/tree/keyboard.ts` |
| Forms generated from JSON Schema (`U-08`) | `src/forms/`           |
| uPlot panels (`U-05`)                     | `src/charts/`          |

`src/tree/keyboard.ts` decides what a key press means without touching the DOM, because that is
the part that is easy to get wrong and easy to test: `ArrowLeft` collapses an expanded branch and
moves to the parent on a leaf, and getting those the wrong way round makes a tree that traps you
at the bottom of a branch. Table-driven tests are cheap there and would be an ordeal against a
rendered list.

The v2 work this app does not do — the drag-and-drop map and dashboard designer, and reports —
is scoped in `CAPABILITIES.MD §6`.
