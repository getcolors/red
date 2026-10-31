# red — specification

`red` is the TypeScript/Bun implementation of the Colors workflow model. Green
(Clojure/Babashka) is canonical, red (TypeScript/Bun) and blue (Python/uv)
implement the same model: steps are `opts -> opts` functions, a workflow is a
static `wireFn` graph plus a dynamic `nextFn`, branches fan out and join,
advice layers cross-cutting behaviour, and desired state is YAML overlaid with
`COLORS_PAR_*` environment variables. Subworkflows compose as ordinary steps.
Applications own their CLI, validation, planning, progress and recovery.

red is a foundation for deployment code written by coding agents. Steps call
cloud CLIs or APIs directly; the library has no OpenTofu, Ansible or template
integration. [PocketDeploy](https://github.com/pocketcontext/pocketdeploy),
built on blue, is the starter package.

The port is **behavioral**: green is the canonical model, and the TypeScript
test suite locks that behavior into red's language-specific contract.
The shared semantics do not make application code mechanically portable.

## Naming

Everything called `green` is called `red`:

| green                      | red                          |
|----------------------------|------------------------------|
| `:green/exit` etc.         | `"red/exit"` etc.            |
| `green.workflow` ns        | `red/workflow` module        |

Namespaced keywords become namespaced **string keys**: `:app/servers` →
`"app/servers"`. Keyword *values* become plain strings: `:create` → `"create"`.
The engine reserves the `red/*` and `red.*/*` namespaces for its control keys
(`"red/exit"`, `"red/err"`, `"red/trace"`, `"red/step"`, `"red/branches"`, plus private keys such as
`"red.workflow/inherited"`); everything project-specific uses its own
namespace.

## The opts map

All cross-step state is one plain object threaded through the graph. The base
type is open (`Opts = { [key: string]: unknown }` plus the typed engine keys);
steps read the keys they declare and pass everything else through untouched.
There is deliberately no closed "all keys" interface; a package validates the
keys it needs.

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
  `"app/event"`. `runOpts` is the run's *initial* opts, stable for the whole
  run, so the static graph never flaps.
- **nextFn** (optional) `(step, defaultNext, opts) => [[nextStep, opts], ...]`
  — dynamic routing: fan-out, conditional branching, error rerouting.
  Returning `[]`/`null` terminates the branch.
- `workflow({start, end?, wireFn, nextFn?})` constructs a workflow **value**;
  every constructor/advice function is pure — workflows are safe to branch
  and share. `end` is an inclusive slice boundary (runs, then stops).
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

## Subworkflows

`step(wf, {inFn?, outFn?})` turns a workflow into an ordinary step function.
It can be wired, advised and fanned out like any other step. `inFn` shapes
child opts; `outFn(parentOpts, childResult)` adapts the result back. By
default the child's result, including its exit/error keys, becomes the parent
step's result. A custom `outFn` must preserve or explicitly handle failures.
Application context flows with opts; a rebuilding `inFn` must carry the
application keys its child needs. Advice inheritance survives that adapter.
Execution is in-memory; subworkflows do not supply durable recovery or state.

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
  be attributed to a branch. Applications own process-level error handling
  and command exit policies.

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

## Configuration helpers

`red/cli` retains its historical module path, but contains only `loadYaml`,
`readPars` and `parName`. `loadYaml(text)` parses YAML with `Bun.YAML.parse`
(YAML 1.2: `no` and dates remain strings). It returns an empty object for
empty/null input and otherwise the parsed data; the application validates
that its expected mapping/schema is present. It reads no files and stamps
no paths or event keys. Quote version-like values such as `"3.10"`.

`readPars(opts, env?)` overlays every `COLORS_PAR_<UPPER_SNAKE>` variable onto
its flat kebab-case key (`COLORS_PAR_DO_TOKEN` → `do-token`); `parName` maps
in the other direction. Existing boolean values accept `true`/`false` and
existing integers accept decimal integers; other values remain strings.
The namespace is shared across all colors. Credentials belong outside YAML.

## Application boundary

The SDK has no generic CLI, configuration discovery, generated-directory
helper, lifecycle preflight, bundled dry-run/progress policy or logging seam.
Applications select files, validate inputs, implement commands and report
results. They may attach application-defined advice for reporting, guards or
preview behavior. Engine-level `start` and inclusive `end` remain available.
The runner provides execution, not persistence, cloud ownership or recovery.

## Example

`examples/hello/red` is an application-owned Bun CLI. It parses create/delete
and a preview flag, loads its selected YAML and runs a graph:
`hello/check` → `hello/host` → `hello/greet` per name → `hello/report`.
`hello/greet` embeds a subworkflow with `hello/write` → `hello/verify`: each
item is written/removed and verified before returning to the parent. The application
adds all-step logging advice, inherited by that child, and per-step preview
advice skipping `hello/greet` and `hello/report`. Steps run `uname`, write
files, read them with `cat`, and remove only greeting files/empty directories.

The executable imports red by relative path. External consumers must depend
on a published git commit in `package.json` until an npm release exists.

## Testing and layout

`bun test` discovers `test/*.test.ts`. Workflow and advice tests cover graphs,
joins, failure collapse, composition, slicing, depth and inheritance.
Configuration tests cover YAML scalars and environment overlays. Example tests
run the real CLI in temporary directories, including child advice, preview,
create/delete, validation and command failure. `bun run typecheck` checks
TypeScript source and tests; the extensionless launcher is exercised by its
subprocess tests.

Source modules are `src/workflow.ts`, `src/advice.ts`, `src/cli.ts` and their
root exports in `src/index.ts`. Bun is the only runtime requirement.
