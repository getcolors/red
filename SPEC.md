# red — specification

`red` is the TypeScript/Bun implementation of the green workflow model: a
library for building idempotent devops CLIs — desired state in YAML, workflows
as step graphs threaded by a plain object, template-scaffolded config files,
OpenTofu and Ansible as the muscle.

The port is **behavioral**: the TypeScript test suite defines the contract.
Conventions stay structurally identical to green's — a green project ports to
red by mechanical rename — but this repository now contains only red's
TypeScript/Bun implementation.

## Naming

Everything called `green` is called `red`:

| green                      | red                          |
|----------------------------|------------------------------|
| `:green/exit` etc.         | `"red/exit"` etc.            |
| `:green.scaffold/written`  | `"red.scaffold/written"`     |
| `green.edn`                | `red.yml`                    |
| `./green` (babashka)       | `./red` (Bun)                |
| `green.workflow` ns        | `red/workflow` module        |

Namespaced keywords become namespaced **string keys**: `:zk/servers` →
`"zk/servers"`. Keyword *values* become plain strings: `:create` → `"create"`.
The engine reserves the `red/*` and `red.*/*` namespaces for its control keys
(`"red/exit"`, `"red/err"`, `"red/trace"`, `"red/event"`, `"red/dry-run"`,
`"red/step"`, `"red/branches"`, plus private keys such as
`"red.workflow/inherited"`); everything project-specific uses its own
namespace.

## The opts map

All cross-step state is one plain object threaded through the graph. The base
type is open (`Opts = { [key: string]: unknown }` plus the typed engine keys);
steps read the keys they declare and pass everything else through untouched.
Per-step contracts are expressed as Zod schemas where wanted (`z.infer` types
the step's reads); there is deliberately no closed "all keys" interface.

The engine **deep-freezes opts at the step boundary**. This is not hygiene —
the error model guarantees that a throwing step's partial work is discarded
(failure opts are built from the step's *input*), and that guarantee is only
real if steps cannot mutate their input. Steps return new objects (spread).

## Steps, wiring, workflows

- A **step** is `(opts) => Opts | Promise<Opts>`, named by a namespaced
  string (`"zk/node"`).
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
- `step(wf, {in?, out?})` turns a workflow into an ordinary step function so
  workflows compose. `in` shapes the opts entering the sub-workflow, `out`
  merges the result back (default: the sub-result is the step's result).
  Ambient keys (`"red/event"`, `"red/dry-run"`) flow in with opts; a custom
  `in` must carry them itself if the sub-workflow needs them.

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

## Config: red.yml

Desired state is pure data in YAML (comments encouraged), parsed with
`Bun.YAML.parse` (verified YAML 1.2 on Bun 1.3.14: `no` is a string, `zk/…`
keys parse unquoted). Loaded keys land in opts unchanged. Caveat to document
in every project: version-like values (`3.10`) must be quoted or YAML reads
them as numbers. Validation is Zod at the boundary and/or `before-while`
gates; **gates validate, never transform** — Zod's default key-stripping
would silently drop other namespaces' keys, so gate helpers return the
original opts, never the parse output.

## Scaffolding and templates

A spec is a flat seq of `{template, target, data, opts?}`:

- `template` is `{name, content}` — content is the template text, name is for
  messages. **The module graph is the classpath**: packages own their
  templates via Bun text imports
  (`import mainTf from "./main.tf" with { type: "text" }`), so templates
  travel through relative imports, npm install, auto-install, `bun build`
  bundles, and compiled binaries (verified on Bun 1.3.14). There is no
  runtime template lookup.
- `target` is itself rendered against `data` (paths are templates too).
- On `"red/event": "delete"` the same specs name the targets to remove, with
  immediate empty-parent-directory pruning.
- Rendering is Selmer's template language. Supported delimiter overrides via
  `opts` (`tagOpen`, `tagClose`, `filterOpen`, `filterClose` — single
  characters, as in Selmer) let scaffolded Ansible files keep `{{ }}`/`{% %}`
  for Jinja2. Values are HTML-escaped by default; `|safe` bypasses. Missing
  values render empty.
- Engine choice: the renderer is a small internal module implementing the
  subset red exercises (variables, dotted paths, filters incl. `safe` and
  `sort(attribute='...')`, `for` loops, custom delimiters, missing-value
  handling) behind a `render(content, data, opts)` interface.

## tofu and ansible

Event-aware helper steps:

- `tofuStep(opts, {dir, outputKey?})`: non-`"delete"` events → `init` +
  `apply` then `tofu output -json` merged under `outputKey` (default
  `"tofu/outputs"`, keep it namespaced); `"delete"` → `init` + `destroy`.
  Backends attach as `before` advice (`localBackendAdvice`,
  `s3BackendAdvice`, `gcsBackendAdvice`, generic `backendAdvice`) writing
  `backend.tf`; config may be a map or a function of opts.
- `ansibleStep(opts, {...})`: non-`"delete"` → the `create` playbook
  (`create.yml` default), `"delete"` → the `delete` one, via
  `ansible-playbook` in `dir`; `privateKey`, `user`, `extraVars` (JSON `-e`),
  `hostKeyChecking: false` (exports `ANSIBLE_HOST_KEY_CHECKING=False`).
  Parsed PLAY RECAP lands under `recapKey` (default `"ansible/recap"`).
  `inventoryAdvice(fileFn, groups)` is a `before` advice writing an INI
  inventory; `inventoryIni` renders groups/hosts/vars deterministically
  (sorted). `ansibleWithSpec` scaffolds then runs (create) or runs then
  removes (delete).
- All subprocesses go through one seam: `runtime.exec(cmd, {cwd, env})`.
  Tests stub `runtime.exec`; it is also the natural hook for future recording
  features.

## dry-run and progress

Built on advice, not the engine:

- `dryRun.advise(wf, steps)` attaches an `around` advice (id
  `"red.dry-run/skip"`) to the listed steps: when `"red/dry-run"` is set
  (stamped by `--dry-run`), print `dry-run: would run <step> (<event>)` and
  skip. Removable per step with `adviceRemove`.
- `progress.advise(wf)` attaches an `around` advice (id
  `"red.progress/progress"`) to every step: `>>> <step> (<event>)` on entry,
  `<<< <step> (<n>ms)` on exit, reading `"red/step"` from opts.
- Both log through `runtime.log` so tests can capture output.

## CLI

`./red <event> [-f|--file red.yml] [--start step] [--end step] [--dry-run]`,
parsed with `util.parseArgs` (event is the positional). `runCli(wf, args)` is
the non-exiting, testable form: loads the YAML state, stamps `"red/event"`
(and `"red/dry-run"`), applies `--start`/`--end` as a workflow slice, runs,
returns final opts; exit 2 with a message on usage/missing-file/parse errors.
`execCli(wf, args)` prints `"red/err"`/`"red/trace"` to stderr and
`process.exit`s with `"red/exit"`.

## The ./red launcher

A project's `./red` is a **self-contained Bun script**: `#!/usr/bin/env bun`,
executable, no package.json/node_modules/build step. It holds the workflow
definition, advice wiring, and the `execCli` call, plus text imports of its
local templates. In-repo examples import red by relative path; external
consumers rely on Bun auto-install with a **version-pinned** specifier
(`import { … } from "red@x.y.z"`) — never unpinned. Consequences:

- Publishing red to npm is a v1 release requirement (`github:` specifiers do
  not work in import paths; until then external consumers need a minimal
  package.json with a git dep).
- Auto-install deactivates if any `node_modules` exists up the tree —
  document it.
- `import.meta.dir` replaces the `*file*` dance; `import.meta.main` replaces
  the launched-as-script check; a `run(...args)` export stays REPL/test
  friendly.

## Testing

`bun test`; files auto-discovered as `test/*.test.ts` (no runner lists to
maintain). The zookeeper end-to-end suite drives real `tofu` over
locals/outputs-only HCL and skips via `describe.skipIf(!Bun.which("tofu"))`.
tofu/ansible unit tests stub `runtime.exec` instead of shelling out.

## Repository layout

TypeScript source lives in `src/*.ts`; tests live in `test/*.test.ts`; shared
text-imported templates live in `test-resources/`. Examples are self-contained
Bun launchers under `examples/*/red` with desired state in `red.yml`. The
library's own `package.json` exists for publication and the zod dependency;
consumers' launcher scripts need none once red is available as a version-pinned
package import.
