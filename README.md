# red

`red` is the TypeScript/Bun workflow SDK of [Colors](https://www.getcolors.ai/).
Coding agents now write deployment code directly; the colors are the
foundation for that code. Three SDKs share one model —
[green](https://github.com/getcolors/green) (Clojure/Babashka, canonical),
red (TypeScript/Bun) and [blue](https://github.com/getcolors/blue)
(Python/uv):

- a step is `(opts) => opts`, threading one plain object;
- a workflow is a static `wireFn` graph plus a dynamic `nextFn`, with
  parallel fan-out and joins;
- layered, Emacs `nadvice`-style advice for cross-cutting behaviour;
- YAML desired state with `COLORS_PAR_*` environment overrides;
- optional dry-run, progress and lifecycle preflight helpers.

Steps call cloud CLIs or APIs directly. Build your own package on red, or
start from [PocketDeploy](https://github.com/pocketcontext/pocketdeploy), the
starter package built on blue. OpenTofu and Ansible support was removed on
2026-10-29.

The full behavioral contract is in [`SPEC.md`](SPEC.md); the same spec is
published at <https://getcolors.github.io/red/>.

## Install

For development in this repository:

```sh
bun install
```

red has no runtime dependencies. For consumers, use a version-pinned package
once `red` is published to npm (`import { workflow, execCli } from
"red@x.y.z"`). Until an npm release exists, use a minimal `package.json` with a
pinned git dependency and import from `red` there. Do not use an unpinned
specifier.

## Commands

```sh
bun test              # run the test suite (includes the example)
bun run typecheck     # run tsc --noEmit
```

## The model in one glance

```ts
import { execCli, failed, type Opts, workflow } from "red";

const mark = (name: string) => (opts: Opts) => ({
  ...opts,
  seen: [...(opts.seen ?? []), name],
});

const wf = workflow({
  start: "app/start",
  wireFn: (step) => {
    switch (step) {
      case "app/start": return [mark("start"), "app/node"];
      case "app/node": return [mark("node"), "app/join"];
      case "app/join": return [mark("join")];
    }
  },
  // fan out one branch per server; the branches join at app/join
  nextFn: (step, defaultNext, opts) => {
    if (failed(opts)) return [];
    if (step === "app/start") {
      return opts.servers.map((server: unknown) => ["app/node", { ...opts, "app/server": server }] as const);
    }
    return (defaultNext ?? []).map((s) => [s, opts] as const);
  },
});

if (import.meta.main) await execCli(wf);
```

Run a project launcher as:

```sh
./red create              # loads ./red.yml
./red delete -f red.yml
./red create --dry-run
./red create --start app/node --end app/node
```

## Core concepts

- **Opts** are one open plain object threaded through every step. Engine keys
  live under `red/*` (`"red/exit"`, `"red/err"`, `"red/event"`,
  `"red/branches"`, ...); project data uses its own namespace-like keys.
- A **step** is `(opts) => opts | Promise<opts>`. The engine deep-freezes step
  input, catches thrown errors (`StepError` chooses the exit code), rejects
  non-plain-object returns, and stamps `"red/exit": 0` on success.
- A **workflow** is a static `wireFn` graph plus an optional dynamic `nextFn`.
  Independent successors run concurrently; converging branches join once with
  branch results under `"red/branches"`; failed forks collapse cleanly.
- **Advice** is workflow-scoped: `around`, `before`, `after`, `override`,
  while/until variants, `filter-args`, `filter-return`. It targets one step or
  all steps, stacks by depth and add order, and is inherited through embedded
  workflows (`step(subWorkflow, { inFn, outFn })`).
- **Desired state** is `red.yml`, overlaid with `COLORS_PAR_*` variables onto
  flat kebab-case keys (`COLORS_PAR_DO_TOKEN` → `do-token`).
- **Dry-run, progress and lifecycle preflight** are optional helpers built on
  advice and plain steps, not engine features.

## Modules

```ts
import { workflow, run, step, adviceAdd, failed, StepError } from "red/workflow";
import * as advice from "red/advice";
import * as dryRun from "red/dry-run";
import * as progress from "red/progress";
import { preflight } from "red/lifecycle";
import { runCli, execCli, readPars, parName, findUp } from "red/cli";
import { runtime } from "red/runtime"; // runtime.log, stubbable in tests
```

The root export (`red`) re-exports the workflow and CLI API plus the
`advice`, `dryRun`, `progress` and `lifecycle` namespaces and `runtime`.

## Example

[`examples/hello`](examples/hello) is a small package whose steps call local
command-line tools (`uname`, `mkdir`, `cat`, `rm`). It fans out one branch per
name, joins them, and supports `create`, `delete` and `--dry-run`:

```sh
cd examples/hello
./red create --dry-run
./red create
COLORS_PAR_MESSAGE=hi ./red create
./red delete
```

## Desired state YAML

`runCli` loads `red.yml` by default, overlays `COLORS_PAR_*`, stamps
`"red/event"` and `"red/state-file"`, and runs the workflow:

```yaml
workdir: work
message: hello
names: [alice, bob]
```

Quote version-like values such as `"3.10"`; YAML would otherwise parse them as
numbers. Keep credentials in `COLORS_PAR_*` variables, never in the file.
