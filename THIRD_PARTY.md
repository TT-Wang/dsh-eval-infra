# Third-party components

## Franken UI

`src/ui/vendor/core.min.css`, `utilities.min.css` and `core.iife.js` are Franken UI, an
open-source component library built on UIkit. They supply this tool's design tokens and base
components, and are shipped as-is so the web UI needs no build-time dependency on them. The
upstream licence is kept beside them in `src/ui/vendor/LICENSE-franken-ui.md` and is copied
into every build at `lib/ui/vendor/`.

Franken UI: https://franken-ui.dev · UIkit: https://getuikit.com

## Runtime dependencies

`js-yaml` (MIT) is the only runtime dependency. `preact`, `esbuild`, `typescript`, `tsx`,
`vitest` and `react` are development dependencies; `react` is a peer of the dsh client half
and is never bundled, because the browser plugin takes React from the dsh shell.

The DeepSeek Harness packages are peer dependencies, provided by the harness the tool evaluates.
