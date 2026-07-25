# red

`red` is a TypeScript/Bun library for building idempotent devops CLIs:
desired state in YAML, workflows as step graphs threaded by one plain object,
Selmer-style template scaffolding, OpenTofu for infrastructure, and Ansible for
SSH provisioning.

The full behavioral contract is in [`SPEC.md`](SPEC.md).

## Install

For development in this repository:

```sh
bun install
```

For consumers, use a version-pinned package once `red` is published to npm:

```ts
import { workflow, execCli } from "red@x.y.z";
```

Until an npm release exists, use a minimal `package.json` with a pinned git
dependency and import from `red` there. Do not use an unpinned specifier.

## Commands

```sh
bun test              # run the TypeScript test suite
bun run typecheck     # run tsc --noEmit
```

The end-to-end ZooKeeper tests use real `tofu` over locals/outputs-only HCL and
skip automatically when `tofu` is not on `PATH`. The real floci example test is
opt-in: `RED_FLOCI_E2E=1 bun test test/floci-zookeeper.test.ts`.

## The model in one glance

```ts
import { execCli, type Opts, workflow } from "red";

const mark = (name: string) => (opts: Opts) => ({
  ...opts,
  seen: [...(opts.seen ?? []), name],
});

const wireFn = (step: string, runOpts: Opts) => {
  switch (step) {
    case "zk/start":
      return [mark("start"), "zk/node"] as const;
    case "zk/node":
      return [mark("node"), "zk/join"] as const;
    case "zk/join":
      return [mark("join")] as const;
  }
};

const nextFn = (step: string, defaultNext: string[] | null, opts: Opts) => {
  if ((opts["red/exit"] ?? 0) > 0) return [];
  if (step === "zk/start") {
    return opts["zk/servers"].map((server: unknown) => [
      "zk/node",
      { ...opts, "zk/node": server },
    ] as const);
  }
  return (defaultNext ?? []).map((s) => [s, opts] as const);
};

const wf = workflow({ start: "zk/start", wireFn, nextFn });

if (import.meta.main) {
  await execCli(wf);
}
```

Run a project launcher as:

```sh
./red create -f red.yml
./red delete -f red.yml
./red create --dry-run
```

## Core concepts

- **Opts** are one open plain object threaded through every step. Engine keys
  live under `red/*` (`"red/exit"`, `"red/err"`, `"red/event"`,
  `"red/branches"`, ...); project data should use its own namespace-like
  string keys (`"zk/servers"`, `"once/workdir"`, ...).
- A **step** is `(opts) => opts | Promise<opts>`. The engine deep-freezes step
  input, catches thrown errors, rejects non-plain-object returns, and stamps a
  default `"red/exit": 0` on success.
- A **workflow** is a static `wireFn` graph plus an optional dynamic `nextFn`.
  Independent successors run concurrently; converging branches join once with
  branch results under `"red/branches"`; failed forks collapse cleanly.
- **Advice** is Emacs `nadvice`-style and workflow-scoped: `around`, `before`,
  `after`, `override`, while/until variants, `filter-args`, and
  `filter-return`. Advice can target one step or all steps, has deterministic
  depth/add-order stacking, and is inherited through embedded workflows.
- **Composition** uses `step(subWorkflow, { in, out })` to turn a workflow into
  an ordinary step.
- **Scaffolding** renders text-imported templates with a small internal
  Selmer-compatible renderer. A file spec is `{template: {name, content},
  target, data, opts?}`; on `"delete"` the same spec removes the rendered
  target and prunes empty parent directories.
- **OpenTofu and Ansible** integrations are event-aware steps. OpenTofu
  backends are written as `backend.tf.json`, preserving native JSON values and
  nested collections; backends and inventories are attached as `before` advice
  instead of being hardwired.
- **Dry-run and progress** are advice layers, not engine features.

## Modules

```ts
import { workflow, run, step, adviceAdd } from "red/workflow";
import * as tofu from "red/tofu";
import * as ansible from "red/ansible";
import { scaffold } from "red/scaffold";
import * as dryRun from "red/dry-run";
import * as progress from "red/progress";
import { runCli, execCli } from "red/cli";
import { schemaGate } from "red/gates";
import { runtime } from "red/runtime";
```

The root export (`red`) re-exports the public API and namespaces.

## Examples

Each example's `./red` is a self-contained Bun script that imports this library
by relative path and uses text imports for templates.

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
./red create --dry-run   # offline path; real create needs an S3 bucket
./red create
./red delete

cd ../floci-zookeeper
./red create --dry-run   # offline path; real create needs Linux + Docker + floci
./red create
./red delete
```

## Desired state YAML

`runCli` loads `red.yml` by default, stamps `"red/event"`, and runs the
workflow. Namespaced string keys can be unquoted in Bun YAML:

```yaml
zk/workdir: work
zk/servers:
  - {id: 1, name: zk1, ip: 10.0.0.1}
```

Quote version-like values such as `"3.10"`; YAML would otherwise parse them as
numbers.
