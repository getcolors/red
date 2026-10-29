# red — specification

`red` is the TypeScript/Bun implementation of the Colors workflow model. Green
(Clojure/Babashka) is canonical, red (TypeScript/Bun) and blue (Python/uv)
implement the same model: steps are `opts -> opts` functions, a workflow is a
static `wireFn` graph plus a dynamic `nextFn`, branches fan out and join,
advice layers cross-cutting behaviour, and desired state is YAML overlaid with
`COLORS_PAR_*` environment variables. Dry-run, progress and lifecycle
preflight are optional advice-level helpers.

red is a foundation for deployment code written by coding agents. Steps call
cloud CLIs or APIs directly; the library has no OpenTofu, Ansible or template
integration. [PocketDeploy](https://github.com/pocketcontext/pocketdeploy),
built on blue, is the starter package.

The port is **behavioral**: green is the canonical model, and the TypeScript
test suite locks that behavior into red's language-specific contract.
Conventions stay structurally identical to green's — a green project ports to
red by mechanical rename.

## Naming

Everything called `green` is called `red`:

| green                      | red                          |
|----------------------------|------------------------------|
| `:green/exit` etc.         | `"red/exit"` etc.            |
| `green.edn`                | `red.yml`                    |
| `./green` (babashka)       | `./red` (Bun)                |
| `green.workflow` ns        | `red/workflow` module        |

Namespaced keywords become namespaced **string keys**: `:app/servers` →
`"app/servers"`. Keyword *values* become plain strings: `:create` → `"create"`.
The engine reserves the `red/*` and `red.*/*` namespaces for its control keys
(`"red/exit"`, `"red/err"`, `"red/trace"`, `"red/event"`, `"red/dry-run"`,
`"red/step"`, `"red/branches"`, plus private keys such as
`"red.workflow/inherited"`); everything project-specific uses its own
namespace.

## The opts map

All cross-step state is one plain object threaded through the graph. The base
type is open (`Opts = { [key: string]: unknown }` plus the typed engine keys);
steps read the keys they declare and pass everything else through untouched.
There is deliberately no closed "all keys" interface; a package validates the
keys it needs (see `lifecycle.preflight`).

The engine recursively freezes plain objects and arrays at each step boundary,
including nested values inside already-frozen containers. Map, Set, Date,
typed arrays, custom object instances and accessor properties fail before the
step runs. Functions remain callable; their captured state is outside the input
freezing contract. Steps return new objects using spread syntax.

A join uses the deepest fork shared by all incoming branches, consumes that
fork and preserves its enclosing forks. Failed joins carry the highest exit
code and that branch's error and trace. Equal codes select the first incoming
branch.

## Steps, wiring, workflows

- A **step** is `(opts) => Opts | Promise<Opts>`, named by a namespaced
  string (`"app/node"`).
- **wireFn** `(step, runOpts) => [fn, ...nextSteps] | undefined` — the static
  happy-path graph for this run; may depend on stable run-level inputs such as
  `"red/event"`. `runOpts` is the run's *initial* opts, stable for the whole
  run, so the static graph never flaps.
- **nextFn** (optional) `(step, defaultNext, opts) => [[nextStep, opts], ...]`
  — dynamic routing: fan-out, conditional branching, error rerouting.
  Returning `[]`/`null` terminates the branch.
- `workflow({start, end?, wireFn, nextFn?})` constructs a workflow **value**;
  every constructor/advice function is pure — workflows are safe to branch
  and share. `end` is an inclusive slice boundary (runs, then stops).
- `step(wf, {inFn?, outFn?})` turns a workflow into an ordinary step function so
  workflows compose. `inFn` shapes the opts entering the sub-workflow, `outFn`
  merges the result back (default: the sub-result is the step's result).
  Ambient keys (`"red/event"`, `"red/dry-run"`) flow in with opts; a custom
  `inFn` must carry them itself if the sub-workflow needs them.

## Scheduler semantics

The scheduler runs all safe-to-run steps in parallel, waits when branches may
still converge, joins converged branches once, and collapses forks cleanly on
failure:

1. Live branches are grouped by step. A step is **blocked** if another live
   branch could still reach it along static wireFn edges (join detection uses
   the static graph only).
2. Same-step entries from the *same* fan-out (same parent unit) run
   individually; entries converging from *different* origins **join**: the
   join step runs once with the fork-point opts plus `"red/branches"` (all
   branch results).
3. Multiple successors fork; branches run as real parallel promises.
4. If a branch fails inside a fork, in-flight siblings finish their current
   step, then the fork collapses: the join is skipped and a terminal carries
   the worst exit, its err/trace, and `"red/branches"`. Collapse cascades
   outward through nested forks.
5. If a join's incoming branches already include a failure, the join is
   skipped the same way.
6. Finalize: no terminals → `{"red/exit": 0}`; one → it; several → the first
   failed one, else the last successful one. The private inherited-advice key
   never leaks into results.

## Error model

Errors are values, never control flow. No Result/Either types — failed opts
must flow through nextFn routing and `"red/branches"` as ordinary data.

- `"red/exit"`: 0 ok, >0 failed (`failed(opts)` helper). A successful step
  that sets no exit gets `"red/exit": 0` stamped.
- The step boundary is the exception firewall: any throw (including non-Error
  values and rejected promises the step awaited) converts to
  `"red/exit"`/`"red/err"`/`"red/trace"` on the step's *input* opts.
- `StepError extends Error { exit }` is the `ex-info` equivalent: throwing it
  chooses the exit code. Any other throw is exit 1, message
  `String(err)`/`err.message`, trace `err.stack`.
- A step returning a non-object (e.g. a forgotten return) fails loudly through
  the same contract.
- Without a nextFn, a failed step produces no successors — the branch halts.
  With one, routing failures (cleanup, retry paths) is user logic.
- Steps must await everything they start; a stray un-awaited rejection cannot
  be attributed to a branch. `execCli` installs an `unhandledRejection`
  handler that reports and exits nonzero.
- The CLI reserves exit 2 for usage/config errors; step code should not
  claim it.

## Advice

Emacs nadvice combinators, workflow-scoped, pure values:
`around`, `before`, `after`, `override`, `before-while`, `before-until`,
`after-while`, `after-until`, `filter-args`, `filter-return`.

- `adviceAdd(wf, step, how, id, fn, props?)` targets one step;
  `adviceAddAll(wf, how, id, fn, props?)` every step. Both stack in strict
  add order across the two registries (most recently added outermost) unless
  `depth` (-100..100, default 0) overrides: lower = more outward. At equal
  depth, newest is outermost. Re-adding an id replaces it and moves it to the
  top of its depth. `adviceRemove`/`adviceRemoveAll` remove by id.
- Advice fns may be sync or async; composition awaits.
- **Truthiness**: the while/until combinators use *Clojure* truthiness — only
  `null`, `undefined`, and `false` are falsy (`0` and `""` are truthy). For
  `after-while`/`after-until`, a step-result object is true iff its
  `"red/exit"` is 0 or absent.
- **Inheritance across `step` embeds**: a run stamps its effective registries
  into opts under `"red.workflow/inherited"`; a nested run merges them over
  its own (transitively). Step names match flat at any depth. Ancestor advice
  stacks outside child advice at equal depth; an ancestor entry with the same
  id replaces a child's. The engine re-stamps after `in` runs, so a scoping
  `in` cannot sever inheritance.
- `advicePlan(wfOrChain, step)` shows the composed stack outermost-first with
  provenance (`scope: "step"|"all"`, `level` = chain depth).

## Config: red.yml and COLORS_PAR_*

Desired state is pure data in YAML (comments encouraged), parsed with
`Bun.YAML.parse` (verified YAML 1.2 on Bun 1.3.14: `no` is a string,
`app/…` keys parse unquoted). Loaded keys land in opts unchanged, plus
`"red/state-file"`: the absolute path of the file, so a package resolves its
relative paths against the file rather than the current directory. Caveat to
document in every project: version-like values (`3.10`) must be quoted or YAML
reads them as numbers.

After loading, `readPars(opts, env)` overlays every `COLORS_PAR_<UPPER_SNAKE>`
variable onto the flat kebab-case key it names (`COLORS_PAR_DO_TOKEN` →
`do-token`; `parName(key)` is the inverse). The value is coerced to the type
of the key's existing value: `true`/`false` for booleans, decimal integers for
integers, a string otherwise. One namespace is shared by green, red and blue;
there is no per-colour prefix. Credentials belong in these variables, never in
`red.yml`. Namespaced keys (`app/x`) cannot be overlaid; keep overridable
inputs flat.

Validation is the package's job, typically as its first step or a
`before-while` advice; validators return the original opts, never a
transformed copy.

## Lifecycle preflight

`lifecycle.preflight(opts, config, env?)` is a reusable first step:
`defaults` are merged under the opts, an optional `overlay(opts, env)` runs,
then every `validators[i](opts, env, {event, real})` contributes error
strings (`real` is false under dry-run). Any errors → `"red/exit": 2` with
the errors joined by newlines in `"red/err"`; otherwise `afterValidate` (if
given) produces the result, else `"red/exit": 0`.

## Dry-run and progress

Built on advice, not the engine:

- `dryRun.advise(wf, steps)` attaches an `around` advice (id
  `"red.dry-run/skip"`) to the listed steps: when `"red/dry-run"` is set
  (stamped by `--dry-run`), print `dry-run: would run <step> (<event>)` and
  skip. Removable per step with `adviceRemove`.
- `progress.advise(wf)` attaches an `around` advice (id
  `"red.progress/progress"`) to every step: `>>> <step> (<event>)` on entry,
  `<<< <step> (<n>ms)` on exit, reading `"red/step"` from opts.
- Both log through `runtime.log`, a mutable seam tests replace to capture
  output. `runtime` has no subprocess runner: steps spawn commands themselves
  (`Bun.spawn`, `Bun.$`) or call APIs with `fetch` or an SDK client.

## CLI

`./red <event> [-f|--file red.yml] [--start step] [--end step] [--dry-run]`,
parsed with `util.parseArgs` (event is the positional). `runCli(wf, args)` is
the non-exiting, testable form: loads YAML, overlays `COLORS_PAR_*`, stamps
`"red/event"` (and `"red/dry-run"`), applies workflow slicing, runs,
returns final opts; exit 2 with a message on usage/missing-file/parse errors.
`execCli(wf, args)` prints `"red/err"`/`"red/trace"` to stderr and
`process.exit`s with `"red/exit"`.

`CliConfig` options: `defaultFile` (default `red.yml`), `searchParents`
(find the default file in the nearest ancestor directory via `findUp`) and
`allowedEvents` (any other event is a usage error).

## The ./red launcher

A project's `./red` is a **self-contained Bun script**: `#!/usr/bin/env bun`,
executable, no build step. It holds the workflow definition, advice wiring,
the steps (which call CLIs or APIs directly) and the `execCli` call. The
in-repo example imports red by relative path; external consumers should
depend on a pinned version — a version-pinned npm specifier once red is
published, until then a pinned git dependency in `package.json`; never an
unpinned specifier. `import.meta.dir` locates the script; `import.meta.main`
distinguishes launch from import, so the workflow can be exported for tests.

## Example

`examples/hello` is the reference package: `hello/check` (lifecycle
preflight) → `hello/host` (`uname -sm`) → `hello/greet` fanned out per name by
`nextFn` (writes one file per name on create, `rm -f` on delete) → the
`hello/report` join (`cat` the files back on create, `rmdir` the empty
workdir on delete). Progress advice wraps every step; dry-run advice skips
`hello/greet` and `hello/report`. It is offline and harmless.

## Testing

`bun test`; files auto-discovered as `test/*.test.ts`. Engine, advice, CLI,
dry-run, progress and lifecycle behaviour are unit-tested in-process;
`test/hello-example.test.ts` drives `examples/hello/red` as a subprocess
(create, delete, dry-run, `COLORS_PAR_*` overlay, validation and command
failure). `bun run typecheck` runs `tsc --noEmit` over `src` and `test` (the
extensionless launcher is exercised by its test rather than by `tsc`).

## Repository layout

TypeScript source lives in `src/*.ts`; tests live in `test/*.test.ts`. The
example is a self-contained Bun launcher at `examples/hello/red` with desired
state in `red.yml`. red has no runtime dependencies; `package.json` exists for
publication and the dev toolchain.

