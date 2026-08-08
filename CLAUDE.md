# CLAUDE.md

This file gives coding-agent guidance for this repository.

## What this is

`red` is a TypeScript/Bun library for building idempotent devops CLIs: desired
state in YAML, workflows as step graphs threaded by one plain object,
Selmer-style template-scaffolded config files, OpenTofu as the infrastructure
runner, and Ansible for SSH provisioning.

The behavioral contract lives in `SPEC.md`. This repository now contains the
TypeScript/Bun implementation only; do not add new Clojure/Babashka source,
tests, build tasks, or example launchers.

## Commands

```sh
bun install          # install dependencies
bun test             # run the TypeScript test suite
bun run typecheck    # run tsc --noEmit
```

The ZooKeeper end-to-end tests drive real `tofu` over HCL containing only
`locals`/`output` blocks and skip when `tofu` is not on `PATH`. The real floci
example test is opt-in: `RED_FLOCI_E2E=1 bun test test/floci-zookeeper.test.ts`.

Try examples end-to-end:

```sh
cd examples/zookeeper
./red create --dry-run
./red create
./red delete

cd ../multi-zookeeper
./red create --dry-run
./red create
./red delete

cd ../once
./red create --dry-run
./red create
./red delete

cd ../multi-once
./red create --dry-run   # offline path; real create needs a real S3 bucket
./red create
./red delete

cd ../floci-zookeeper
./red create --dry-run   # offline path; real create needs Linux + Docker + floci
./red create
./red delete
```

## Architecture

Main TypeScript modules under `src/`:

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

- `renderer.ts` — small internal Selmer-compatible renderer used by scaffolding.
  Supports variables, dotted paths, missing values as empty, HTML escaping by
  default, `safe`, `not-empty`, `sort(attribute='...')`, `for` loops, `if`
  blocks, and delimiter overrides
  for templates that must preserve Jinja2 `{{ }}` / `{% %}`.

- `scaffold.ts` — flat file-spec DSL. Specs are `{template: {name, content},
  target, data, opts?}` where templates are Bun text imports. Create renders
  files; `"red/event": "delete"` removes the same rendered targets and prunes
  empty parent directories.

- `tofu.ts` — event-aware OpenTofu steps. Non-`"delete"` runs `init` + `apply`
  and merges `tofu output -json` under `"tofu/outputs"` by default. `"delete"`
  runs `init` + `destroy`. Backends are `before` advice (`localBackendAdvice`,
  `s3BackendAdvice`, `gcsBackendAdvice`, `r2BackendAdvice`, `backendAdvice`).
  Commands accept per-run environments; `tofuWithSpec` supports build, and the
  HCL/JSON construction helpers match Green's deterministic bytes.

- `ansible.ts` — event-aware Ansible steps. Non-`"delete"` runs create playbook,
  `"delete"` runs delete playbook. Parses PLAY RECAP under `"ansible/recap"` by
  default. `inventoryAdvice` writes deterministic INI inventories.

- `dry-run.ts` — dry-run advice. `dryRun.advise(wf, steps)` adds around advice
  that logs and skips listed steps when `"red/dry-run"` is true.

- `progress.ts` — all-step progress advice logging entry/exit timings.

- `cli.ts` — `runCli` / `execCli`: parses `./red <event> [-f red.yml]
  [--start step] [--end step] [--dry-run]`, loads YAML with `Bun.YAML.parse`,
  overlays `COLORS_PAR_*`, stamps `"red/event"`, and runs the workflow. Exit 2 is
  reserved for usage/config errors.

- `gates.ts` — Zod schema gates for `before-while`. Gates validate and return
  the original opts; they must never replace opts with parsed output because Zod
  can strip unrelated namespace keys.

- `runtime.ts` — mutable test seam for subprocesses and log lines. All command
  execution goes through `runtime.exec`, with per-command environments and
  timeouts; tests stub it instead of shelling out.

## Examples

- `examples/zookeeper` — fake 3-node cluster: dynamic fan-out/join, scaffold +
  tofu, backend-as-advice, dry-run.
- `examples/multi-zookeeper` — two fake clusters from one embedded workflow;
  inherited parent advice reaches child step names.
- `examples/once` — ONCE-style single VPS with provider-swap advice,
  `compute ∥ smtp → dns → smtp-post → (ansible-local ∥ ansible-remote)`, and
  scaffold-only Ansible config.
- `examples/multi-once` — many ONCE boxes from one workflow; parent swaps
  provider/backend advice by inherited id and uses S3 backend keys per
  deployment + step. Real create needs a real S3 bucket; dry-run is offline.
- `examples/floci-zookeeper` — real local 3-node ZooKeeper on floci. Linux-only
  for non-dry-run because it connects directly to Docker-bridge IPs. Requires a
  floci container named `floci`, `tofu`, `ansible-playbook`, `docker`, and
  `aws`. Dry-run works offline and should touch nothing.

## Conventions

- All cross-step state is one open `Opts` object. Engine keys are `red/*` and
  private `red.*/*`; project/library keys should be namespace-like strings such
  as `"zk/servers"`, `"once/workdir"`, `"tofu/outputs"`.
- Keep public constructors and advice-transforming functions pure. Return new
  workflow values; do not mutate existing workflows.
- Steps should return new objects (`{...opts, ...}`), not mutate input. The
  engine freezes step input to make thrown-step partial mutation impossible.
- Errors are opts values, not exceptions escaping the engine. Throw `StepError`
  only when a step/advice wants the step boundary to convert it to
  `"red/exit"`/`"red/err"`/`"red/trace"`.
- Keep output keys namespaced (`"my.ns/result"`); never merge provider outputs
  into top-level opts by default.
- Scaffolding templates should be imported as text and passed as `{name,
  content}`. There is no runtime template lookup.
- For consumer docs, prefer version-pinned npm specifiers once published. Until
  then, document pinned git dependencies via `package.json`; do not recommend
  unpinned Bun auto-install imports.
- Ignore `node_modules/`, `dist/`, `target/`, and example `work/` directories.
