# red

`red` is the TypeScript/Bun workflow SDK of [Colors](https://www.getcolors.ai/).
[Green](https://github.com/getcolors/green) (Clojure/Babashka, canonical), red
and [Blue](https://github.com/getcolors/blue) (Python/uv) implement one model:

- **DAG execution:** steps take and return an options map; static `wireFn`
  graphs and optional dynamic `nextFn` routing support parallel fan-out,
  joins and failure propagation.
- **Subworkflows:** `step(wf, { inFn, outFn })` embeds a reusable workflow as
  an ordinary step.
- **Advice:** workflow-scoped wrappers attach behaviour without changing
  steps, with ordering, inheritance and stack inspection.
- **Configuration helpers:** YAML parsing and `COLORS_PAR_*` overlays.

Applications own their CLI, file selection, validation, planning, progress,
logging and durable recovery. They may implement policies through advice;
red does not bundle dry-run, progress or lifecycle helpers. Steps call CLIs
or APIs directly. [PocketDeploy](https://github.com/pocketcontext/pocketdeploy)
is a deployment controller built on Blue, with its own state journal.

The full behavioral contract is in [SPEC.md](SPEC.md), also published at
<https://getcolors.github.io/red/>. Shared semantics do not make application
code mechanically portable between languages.

## Install and develop

red has no runtime dependencies beyond Bun. It is not published to npm;
consumers must use a git dependency pinned to a published commit in
`package.json`, then import from `red` or its module paths.

```sh
bun install
bun test
bun run typecheck
```

## DAGs, subworkflows and advice

```ts
import { adviceAddAll, run, step, workflow, type Opts, type StepFn } from "red";

const mark = (name: string): StepFn => (opts) => ({ ...opts, [name]: true });
const child = workflow({
  start: "child/prepare",
  wireFn: (name) => name === "child/prepare" ? [mark("prepared")] : undefined,
});
const graph = workflow({
  start: "app/start",
  wireFn: (name) => {
    switch (name) {
      case "app/start": return [mark("started"), "app/child", "app/other"];
      case "app/child": return [step(child), "app/join"];
      case "app/other": return [mark("other"), "app/join"];
      case "app/join": return [(opts) => ({ ...opts, results: opts["red/branches"] })];
    }
  },
});
const observed = adviceAddAll(graph, "around", "app/log", async (base: StepFn, opts: Opts) => {
  console.log(opts["red/step"]);
  return await base(opts);
});
const result = await run(observed, {});
```

The two branches join once. Parent advice also reaches `child/prepare`.
`advicePlan` shows the composed stack. Child failures propagate by default;
an `outFn` must preserve or deliberately handle failure keys when adapting
results. Workflow execution is in-memory, not a durable recovery journal.

## Configuration

```ts
import { loadYaml, readPars, parName } from "red/cli";
const config = readPars(loadYaml(await Bun.file("colors.yml").text()));
```

The historical `red/cli` module path is retained for configuration helpers
only. `loadYaml` parses YAML text with Bun's YAML 1.2 reader; it does not
read files, validate a schema, or stamp control keys. `readPars` overlays
flat kebab-case keys from `COLORS_PAR_*`, coercing existing booleans and
integers. `parName("do-token")` returns `COLORS_PAR_DO_TOKEN`. Quote
version-like YAML values such as `"3.10"` and keep credentials outside YAML.
Applications choose their configuration filename and whether to apply overlays.

## Modules

- `red/workflow`: execution, composition, advice registration/inspection and types.
- `red/advice`: combinators and immutable registry operations.
- `red/cli`: `loadYaml`, `readPars`, `parName`.

The root `red` export exposes workflow/configuration names and the `advice`
namespace. The full advice system and engine-level `start`/`end` slicing
remain supported; the library supplies no generic CLI flags.

## Example

[examples/hello](examples/hello) is an offline application with its own CLI.
It validates desired state, discovers the host with `uname`, fans out one
embedded write/verify workflow per unique name, then joins to read the files back.
Application-defined advice logs stages (including child steps) and skips
writes in its preview mode. These policies live in the example, not in red.

```sh
cd examples/hello
./red create --dry-run
./red create
COLORS_PAR_MESSAGE=hi ./red create
./red delete
```

`test/hello-example.test.ts` drives this CLI in temporary directories and
checks composition, inherited advice, previews, configuration and failures.
