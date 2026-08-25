# @ms/web

The web UI. Served by `ms-core` as static assets — there is no second web server to install
(`ADR-001` Decision 8).

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

For production, `scripts/package.sh` runs `vite build` and stages `dist` into the tarball;
`install.sh` puts it at `/opt/ms/web`, and `api.webRoot` in `core.json` points there. An empty
`webRoot` serves no UI at all, which is what a headless install wants.

## What is here

| Route           | Shows                                                                     |
| --------------- | ------------------------------------------------------------------------- |
| `/`             | Core reachability, object counts, sensor states, the registered catalogue |
| `/tree`         | The object tree in the operator's own arrangement                         |
| `/objects/:id`  | Configuration, parameters, channels, history, recent changes              |
| `/sensor-types` | The catalogue and each type's parameter schema                            |

**Nothing is monitored yet, and the UI says so rather than drawing a green dial.** Every sensor
reads Unknown because nothing writes `sensor_state`: the state machine is Phase 3, the config
push that tells a probe what it owns is `R-04`, and there is no sensor type to run until `P-08`.
Panels that are empty say which task fills them.

## Design system

Tokens are CSS custom properties in `src/index.css`, defined on `:root` and overridden under
`[data-theme='dark']`, exposed to Tailwind through `@theme inline`. They are custom properties
rather than Tailwind theme keys because uPlot (`U-05`) draws to a canvas and cannot read a
utility class — but it can read a custom property, so the charts and the DOM share one palette.

Every `-fg` token meets WCAG 2.1 AA against its own surface in both themes. Colour is never the
only signal: `StatusBadge` pairs each of the six `WORKFLOW.MD` §4 states with a distinct glyph
and its name, which is what makes it readable to a screen reader and to a colour-blind operator.

## Next

`U-02` replaces the fetch-on-mount in `src/api/client.ts` with a WebSocket state stream — there
is deliberately no cache layer here to unpick when it does. `U-03` makes the tree virtualised and
searchable, `U-05` brings uPlot, and `U-08` generates settings forms from the `paramsSchema` this
app already displays on `/sensor-types`.
