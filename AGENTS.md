# CLAUDE.md

This file gives coding-agent guidance for this repository.

## What this is

`red` is the TypeScript/Bun workflow SDK of Colors, one of three SDKs that
share one model: green (Clojure/Babashka, canonical), red (TypeScript/Bun) and
blue (Python/uv). Steps are `opts -> opts`; a workflow is a static `wireFn`
graph plus a dynamic `nextFn` with fan-out and joins; advice is layered;
desired state is YAML overlaid with `COLORS_PAR_*`; dry-run, progress and
lifecycle preflight are optional. red is a foundation for deployment code
written by coding agents; PocketDeploy
(<https://github.com/pocketcontext/pocketdeploy>, built on blue) is the
starter package. Steps call cloud CLIs or APIs directly — red has no
OpenTofu/Ansible integration, template scaffolding or subprocess runner, and
must not grow them back.

The behavioral contract lives in `SPEC.md`; `index.html` publishes the same
spec at <https://getcolors.github.io/red/>. Keep the three in step. This
repository contains the TypeScript/Bun implementation only; do not add
Clojure/Babashka source, tests, build tasks, or launchers.

## Commands

```sh
bun install          # install dev dependencies (red has no runtime deps)
bun test             # run the test suite, including the example
bun run typecheck    # run tsc --noEmit
```

Try the example end-to-end (offline, harmless):

```sh
cd examples/hello
./red create --dry-run
./red create
./red delete
```

## Architecture

Modules under `src/`:

- `workflow.ts` — workflow engine. A step is `(opts) => opts | Promise<opts>`
  named by a namespaced string. `wireFn(step, runOpts)` defines the static graph
  for the run; optional `nextFn(step, defaultNext, opts)` handles fan-out,
  conditional routing, retries, and cleanup paths. Independent successors run in
  parallel promises. Branches that converge join once with results under
  `"red/branches"`; failed forks collapse and propagate the worst exit.
  The step boundary deep-freezes input, catches thrown errors, rejects non-plain
  object returns, stamps `"red/step"`, and removes private inherited-advice
  state from results. `step(wf, {inFn, outFn})` embeds workflows as ordinary
  steps.

- `advice.ts` — Emacs `nadvice`-style combinators: `around`, `before`, `after`,
  `override`, `before-while`, `before-until`, `after-while`, `after-until`,
  `filter-args`, and `filter-return`. Registries are immutable workflow values.
  `adviceAdd` targets one step, `adviceAddAll` targets every step. Depth
  controls stack order (`-100..100`, lower = more outward); equal depth uses
  newest-outermost ordering. Advice is inherited through embedded workflows by
  flat step name; same-id ancestor advice replaces child advice.

- `cli.ts` — `runCli` / `execCli`: parses `./red <event> [-f red.yml]
  [--start step] [--end step] [--dry-run]`, loads YAML with `Bun.YAML.parse`,
  overlays `COLORS_PAR_*` (`readPars`, `parName`), stamps `"red/event"` and
  `"red/state-file"`, and runs the workflow. `findUp` supports
  `searchParents`. Exit 2 is reserved for usage/config errors.

- `lifecycle.ts` — `preflight`: defaults, optional overlay, ordered
  validators (errors → exit 2) and an `afterValidate` callback.

- `dry-run.ts` — `dryRun.advise(wf, steps)` adds around advice that logs and
  skips listed steps when `"red/dry-run"` is true.

- `progress.ts` — all-step around advice logging entry/exit timings.

- `runtime.ts` — the mutable `runtime.log` seam used by dry-run and progress so
  tests can capture output. There is no subprocess runner; steps spawn
  commands themselves.

## Example

- `examples/hello` — steps call `uname`, `mkdir`, `cat`, `rm` directly;
  lifecycle preflight, `nextFn` fan-out per name, a join, progress and dry-run
  advice, `COLORS_PAR_*` overrides. `test/hello-example.test.ts` drives the
  real launcher; keep it passing when changing the example or the CLI.

## Conventions

- All cross-step state is one open `Opts` object. Engine keys are `red/*` and
  private `red.*/*`; project/library keys should be namespace-like strings such
  as `"app/servers"`. Desired-state inputs that may be overridden by
  `COLORS_PAR_*` stay flat kebab-case.
- Keep public constructors and advice-transforming functions pure. Return new
  workflow values; do not mutate existing workflows.
- Steps should return new objects (`{...opts, ...}`), not mutate input. The
  engine freezes step input to make thrown-step partial mutation impossible.
- Errors are opts values, not exceptions escaping the engine. Throw `StepError`
  only when a step/advice wants the step boundary to convert it to
  `"red/exit"`/`"red/err"`/`"red/trace"`.
- Keep output keys namespaced (`"my.ns/result"`); never merge command or API
  outputs into top-level opts by default.
- For consumer docs, prefer version-pinned npm specifiers once published. Until
  then, document pinned git dependencies via `package.json`; do not recommend
  unpinned Bun auto-install imports.
- Ignore `node_modules/`, `dist/`, `target/`, and example `work/` directories.

## Documentation

`index.html` is this repository's landing page and carries two analytics tags:
GA4 measurement ID `G-4VKP1WY4QJ`, whose explicit `page_title` must exactly
equal the decoded HTML `<title>` and stay distinct and stable so one Analytics
property can separate repositories, and the self-hosted Rybbit snippet
`<script src="https://rybbit.getcolors.ai/api/script.js" data-site-id="9fb9c41a6d49" defer></script>`,
which shares one site ID across every page because `getcolors.github.io/<repo>/`
paths already encode the repository. Never add one tag without the other.

The page is styled like www.getcolors.ai (IBM Plex Sans/Mono, the shared
`oklch` tokens, the site's sticky header and footer) and matches the green and
blue pages; only `--accent` differs (`var(--red)` here). Keep it light-only,
free of horizontal scroll at phone width, and accurate to `SPEC.md`.
