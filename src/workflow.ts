// The workflow engine: a graph of steps threaded by an opts object.
//
// - wireFn: (step, runOpts) -> [fn, ...nextSteps] — the static happy-path
//   graph for this run. It may depend on stable run-level inputs such as
//   "red/event". Multiple successors run in parallel.
// - nextFn (optional): (step, defaultNext, opts) -> [[nextStep, opts], ...]
//   — dynamic routing, error branching, fan-out.
// - Steps report outcome via "red/exit" (0 ok, >0 error), "red/err",
//   "red/trace". Thrown exceptions are caught and converted.
// - Branches converging on the same step join: the join step runs once with
//   the fork-point opts plus "red/branches" (array of branch results).
// - A branch failing inside a fork lets the in-flight siblings finish their
//   current step, then the fork collapses: the join is skipped and the worst
//   exit propagates, with all branch results under "red/branches".
// - adviceAdd attaches advice to one step; adviceAddAll to every step. Both
//   stack in strict add order (most recently added, from either, is
//   outermost), unless a depth prop overrides placement (lower = more
//   outward), as in Emacs.
// - Advice is inherited across `step` embeds: a run stamps its effective
//   advice into opts and a nested run merges it over the child's own — step
//   names match flat at any depth, ancestor advice is outermost, and an
//   ancestor entry replaces a same-id child entry. advicePlan shows the
//   composed stack for a step.

import * as advice from "./advice.ts";
import type { AnyFn, Entry, How, Props, Registry } from "./advice.ts";

export interface Opts {
  [key: string]: any;
}

export type StepFn = (opts: Opts) => Opts | Promise<Opts>;

export type WireDecl = readonly [StepFn, ...string[]];

export type WireFn = (step: string, runOpts: Opts) => WireDecl | undefined | null;

export type NextPair = readonly [string, Opts];

export type NextFn = (
  step: string,
  defaultNext: string[] | null,
  opts: Opts,
) => Iterable<NextPair> | null | undefined;

export interface Workflow {
  start: string;
  end?: string;
  wireFn: WireFn;
  nextFn?: NextFn;
  advice: Registry;
  adviceAll: Entry[];
  adviceSeq: number;
}

// Throw from a step to choose the failure's exit code (the ex-info
// equivalent); any other throw converts with exit 1.
export class StepError extends Error {
  exit: number;
  constructor(message: string, opts?: { exit?: number }) {
    super(message);
    this.name = "StepError";
    this.exit = opts?.exit ?? 1;
  }
}

const INHERITED = "red.workflow/inherited";
const ROOT = "red.workflow/root";

// Construct a workflow. `start` is required; `end` is an optional slice
// boundary (it runs, then the workflow stops); `wireFn` is required and is
// called as wireFn(step, runOpts); `nextFn` is optional.
export function workflow(spec: {
  start: string;
  end?: string;
  wireFn: WireFn;
  nextFn?: NextFn;
}): Workflow {
  if (typeof spec.start !== "string" || spec.start === "") {
    throw new Error("workflow start must be a step name string");
  }
  if (typeof spec.wireFn !== "function") {
    throw new Error("workflow wireFn must be a function");
  }
  return {
    start: spec.start,
    end: spec.end,
    wireFn: spec.wireFn,
    nextFn: spec.nextFn,
    advice: {},
    adviceAll: [],
    adviceSeq: 0,
  };
}

// Return a workflow with advice `fn` added on `step` (combinator `how`,
// explicit `id`). Pure — the original workflow is untouched. Composes with
// any all-steps advice (see `adviceAddAll`) in strict add order: whichever
// was added more recently is outermost. `props` may carry depth (-100..100,
// default 0), which overrides add order: lower depth pushes the advice
// outward, higher pushes it inward, as with Emacs hook depths.
export function adviceAdd(
  wf: Workflow,
  step: string,
  how: How,
  id: string,
  fn: AnyFn,
  props?: Props | null,
): Workflow {
  const s = wf.adviceSeq;
  return {
    ...wf,
    advice: advice.add(wf.advice, step, how, id, fn, s, props),
    adviceSeq: s + 1,
  };
}

// Return a workflow with the advice registered under `id` on `step` removed.
export function adviceRemove(wf: Workflow, step: string, id: string): Workflow {
  return { ...wf, advice: advice.removeId(wf.advice, step, id) };
}

// Return a workflow with advice `fn` added on every step. Pure. Composes
// with any per-step advice in strict add order.
export function adviceAddAll(
  wf: Workflow,
  how: How,
  id: string,
  fn: AnyFn,
  props?: Props | null,
): Workflow {
  const s = wf.adviceSeq;
  return {
    ...wf,
    adviceAll: advice.addGlobal(wf.adviceAll, how, id, fn, s, props),
    adviceSeq: s + 1,
  };
}

// Return a workflow with the all-steps advice registered under `id` removed.
export function adviceRemoveAll(wf: Workflow, id: string): Workflow {
  return { ...wf, adviceAll: advice.removeGlobalId(wf.adviceAll, id) };
}

// --- advice inheritance across embeds --------------------------------------
// A run stamps its effective registries into every step's opts under
// "red.workflow/inherited"; `step` forwards the stamp into the nested run,
// whose `inherit` merges it over the child's own advice. Inheritance is
// transitive because each run stamps its already-merged registries.

interface InheritedPayload {
  advice: Registry;
  adviceAll: Entry[];
}

// Merge an inherited registry payload from an enclosing run over `wf`'s own
// advice: inherited entries stack outside the child's own, and an inherited
// entry replaces a same-id child entry (per step, or in the all-steps list).
// Step names are flat — whatever an ancestor advised under a name applies to
// this workflow's step of that name.
function inherit(wf: Workflow, inherited: InheritedPayload | undefined): Workflow {
  if (!inherited) return wf;
  const n = wf.adviceSeq;
  return {
    ...wf,
    advice: advice.mergeRegistry(wf.advice, inherited.advice, n),
    adviceAll: advice.mergeEntries(wf.adviceAll, inherited.adviceAll, n),
  };
}

export interface PlanEntry {
  id: string;
  how: How;
  depth: number;
  seq: number;
  scope: "step" | "all";
  level: number;
}

// Debugging: the advice stack that would wrap `step` at run time, outermost
// first. `wfs` is a single workflow or a chain [outermost ... innermost] —
// the workflows a run traverses to reach `step` through `step` embeds.
// Returns [{id, how, depth, seq, scope, level}, ...] where scope is "step"
// or "all" and level indexes the chain element that registered the advice
// (0 = outermost). A child entry replaced by a same-id ancestor entry does
// not appear.
export function advicePlan(wfs: Workflow | Workflow[], step: string): PlanEntry[] {
  const chain = Array.isArray(wfs) ? wfs : [wfs];
  const tag = (wf: Workflow, level: number): Workflow => ({
    ...wf,
    advice: Object.fromEntries(
      Object.entries(wf.advice).map(([k, es]) => [
        k,
        es.map((e) => ({ ...e, scope: "step", level })),
      ]),
    ),
    adviceAll: wf.adviceAll.map((e) => ({ ...e, scope: "all", level })),
  });
  let eff: InheritedPayload | undefined;
  chain.forEach((wf, level) => {
    const merged = inherit(tag(wf, level), eff);
    eff = { advice: merged.advice, adviceAll: merged.adviceAll };
  });
  const entries = [...(eff?.adviceAll ?? []), ...((eff?.advice ?? {})[step] ?? [])];
  return advice
    .ordered(entries)
    .reverse()
    .map((e: any) => ({
      id: e.id,
      how: e.how,
      depth: e.depth,
      seq: e.seq,
      scope: e.scope,
      level: e.level,
    }));
}

// --- static graph (for join scheduling) -------------------------------------

type StaticGraph = Record<string, string[]>;

function staticSuccessors(wireFn: WireFn, step: string, runOpts: Opts): string[] {
  // Deliberately lenient: this graph exists only for join detection, so a
  // name the wireFn can't resolve (undefined or a throw) just contributes no
  // static edges — nextFn may own routing for it. Real wiring bugs still
  // surface when the step runs: runStep calls the same wireFn and converts
  // the failure to "red/exit". Throwing here would escape run uncaught,
  // bypassing the Unix-style outcome contract.
  try {
    const decl = wireFn(step, runOpts);
    return decl ? decl.slice(1).map(String) : [];
  } catch {
    return [];
  }
}

function staticGraph(wireFn: WireFn, start: string, runOpts: Opts): StaticGraph {
  const g: StaticGraph = {};
  const frontier = [start];
  while (frontier.length) {
    const s = frontier.shift()!;
    if (s in g) continue;
    const succ = staticSuccessors(wireFn, s, runOpts);
    g[s] = succ;
    frontier.push(...succ);
  }
  return g;
}

// Can a branch currently at `from` (about to run it) later arrive at `to`,
// following static wireFn edges?
function reaches(g: StaticGraph, from: string, to: string): boolean {
  const seen = new Set<string>();
  const frontier = [...(g[from] ?? [])];
  while (frontier.length) {
    const s = frontier.pop()!;
    if (s === to) return true;
    if (seen.has(s)) continue;
    seen.add(s);
    frontier.push(...(g[s] ?? []));
  }
  return false;
}

// --- freezing ---------------------------------------------------------------
// Opts are deep-frozen at the step boundary: the error model guarantees a
// throwing step's partial work is discarded (failure opts are its *input*),
// which is only real if steps cannot mutate their input.

function deepFreeze<T>(x: T, seen = new WeakSet<object>()): T {
  if (x === null || (typeof x !== "object" && typeof x !== "function")) return x;
  const obj = x as unknown as object;
  if (seen.has(obj) || Object.isFrozen(obj)) return x;
  seen.add(obj);
  for (const v of Object.values(obj)) deepFreeze(v, seen);
  return Object.freeze(x);
}

// --- running one step --------------------------------------------------------

function stackTrace(t: unknown): string {
  if (t instanceof Error && t.stack) return t.stack;
  return String(t);
}

function errMessage(t: unknown): string {
  if (t instanceof Error) return t.message || t.constructor.name;
  return String(t);
}

export function failed(opts: Opts): boolean {
  return (opts["red/exit"] ?? 0) > 0;
}

function stepFailure(opts: Opts, t: unknown): Opts {
  return {
    ...opts,
    "red/exit": t instanceof StepError ? t.exit : 1,
    "red/err": errMessage(t),
    "red/trace": stackTrace(t),
  };
}

function schedulerFailure(opts: Opts, t: unknown): Opts {
  return {
    ...opts,
    "red/exit": 1,
    "red/err": errMessage(t),
    "red/trace": stackTrace(t),
  };
}

function withDefaultExit(opts: Opts): Opts {
  if (opts["red/exit"] == null) return { ...opts, "red/exit": 0 };
  return opts;
}

function isPlainMap(x: unknown): x is Opts {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return false;
  const proto = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
}

function inheritedPayload(wf: Workflow): InheritedPayload {
  return { advice: wf.advice, adviceAll: wf.adviceAll };
}

function stepAdvice(wf: Workflow, step: string): Entry[] {
  return [...wf.adviceAll, ...(wf.advice[step] ?? [])];
}

async function runStep(wf: Workflow, step: string, runOpts: Opts, opts: Opts): Promise<Opts> {
  try {
    const decl = wf.wireFn(step, runOpts);
    const f = decl?.[0];
    if (typeof f !== "function") {
      throw new StepError(`no function wired for step ${step}`);
    }
    const input = deepFreeze({
      ...opts,
      [INHERITED]: inheritedPayload(wf),
      "red/step": step,
    });
    const ret = await advice.compose(f, stepAdvice(wf, step))(input);
    if (!isPlainMap(ret)) {
      throw new StepError(`step ${step} returned a non-map: ${Bun.inspect(ret)}`);
    }
    const { [INHERITED]: _inherited, ...rest } = ret;
    return withDefaultExit(rest);
  } catch (t) {
    return stepFailure(opts, t);
  }
}

// Successor [step, opts] pairs for `step` after it produced `opts`. The end
// step is a hard boundary; without nextFn an error halts.
function nextPairs(wf: Workflow, step: string, runOpts: Opts, opts: Opts): NextPair[] {
  if (step === wf.end) return [];
  const decl = wf.wireFn(step, runOpts);
  const rest = decl ? decl.slice(1).map(String) : [];
  const defaultNext = rest.length ? rest : null;
  if (wf.nextFn) {
    return [...(wf.nextFn(step, defaultNext, opts) ?? [])];
  }
  if (failed(opts)) return [];
  return rest.map((s) => [s, opts] as const);
}

// --- the scheduler ------------------------------------------------------------

// Live entries: {step, opts, parent, forks: [frame…]} where a fork frame is
// {id: forkId, opts: forkPointOpts}. `parent` identifies the run-unit that
// produced the entry, so same-step entries from one fan-out run individually
// while entries converging from different origins join. Finished branches
// are {opts, forks: [frame…]}; the frames let a failure collapse its
// enclosing fork.

interface ForkFrame {
  id: string;
  opts: Opts;
}

interface LiveEntry {
  step: string;
  opts: Opts;
  parent: string;
  forks: ForkFrame[];
}

interface Terminal {
  opts: Opts;
  forks: ForkFrame[];
}

interface UnitResult {
  newEntries?: LiveEntry[];
  terminals?: Terminal[];
}

type Unit =
  | { kind: "single"; step: string; entry: LiveEntry; entries?: undefined }
  | { kind: "join"; step: string; entries: LiveEntry[]; entry?: undefined };

let unitCounter = 0;

function children(uid: string, opts: Opts, pairs: NextPair[], forks: ForkFrame[]): UnitResult {
  if (pairs.length === 0) {
    return { terminals: [{ opts, forks }] };
  }
  if (pairs.length === 1) {
    const [s, o] = pairs[0]!;
    return { newEntries: [{ step: s, opts: o, parent: uid, forks }] };
  }
  const frame: ForkFrame = { id: uid, opts };
  return {
    newEntries: pairs.map(([s, o]) => ({
      step: s,
      opts: o,
      parent: uid,
      forks: [...forks, frame],
    })),
  };
}

function terminalResult(opts: Opts, forks: ForkFrame[]): UnitResult {
  return { terminals: [{ opts, forks }] };
}

function branchWorstExit(branchOpts: Opts[]): number {
  return Math.max(...branchOpts.map((o) => o["red/exit"] ?? 0));
}

function firstFailedBranch(branchOpts: Opts[]): Opts | undefined {
  return branchOpts.find(failed);
}

function joinForks(entries: LiveEntry[]): ForkFrame[] {
  return entries.find((e) => e.forks.length > 0)?.forks ?? [];
}

function failedJoinResult(
  forkOpts: Opts,
  forks: ForkFrame[],
  branchOpts: Opts[],
  worst: number,
): UnitResult {
  const bad = firstFailedBranch(branchOpts);
  return terminalResult(
    {
      ...forkOpts,
      "red/exit": worst,
      "red/err": bad?.["red/err"],
      "red/trace": bad?.["red/trace"],
      "red/branches": branchOpts,
    },
    forks,
  );
}

async function runSingleUnit(
  wf: Workflow,
  uid: string,
  step: string,
  runOpts: Opts,
  entry: LiveEntry,
): Promise<UnitResult> {
  const opts = await runStep(wf, step, runOpts, entry.opts);
  return children(uid, opts, nextPairs(wf, step, runOpts, opts), entry.forks);
}

async function runJoinUnit(
  wf: Workflow,
  uid: string,
  step: string,
  runOpts: Opts,
  entries: LiveEntry[],
): Promise<UnitResult> {
  const branchOpts = entries.map((e) => e.opts);
  const forks = joinForks(entries);
  const forkOpts = forks.length ? forks[forks.length - 1]!.opts : branchOpts[0]!;
  const restForks = forks.length ? forks.slice(0, -1) : forks;
  const worst = branchWorstExit(branchOpts);
  if (worst > 0) {
    return failedJoinResult(forkOpts, restForks, branchOpts, worst);
  }
  const opts = await runStep(wf, step, runOpts, { ...forkOpts, "red/branches": branchOpts });
  return children(uid, opts, nextPairs(wf, step, runOpts, opts), restForks);
}

function unitBaseOpts(unit: Unit): Opts {
  return unit.entry?.opts ?? unit.entries?.[0]?.opts ?? {};
}

function unitForks(unit: Unit): ForkFrame[] {
  return unit.entry?.forks ?? unit.entries?.[0]?.forks ?? [];
}

async function runUnit(wf: Workflow, runOpts: Opts, unit: Unit): Promise<UnitResult> {
  const uid = `red-unit-${unitCounter++}`;
  try {
    if (unit.kind === "single") {
      return await runSingleUnit(wf, uid, unit.step, runOpts, unit.entry);
    }
    return await runJoinUnit(wf, uid, unit.step, runOpts, unit.entries);
  } catch (t) {
    return terminalResult(schedulerFailure(unitBaseOpts(unit), t), unitForks(unit));
  }
}

function failedForkBranch(branch: Terminal): boolean {
  return failed(branch.opts) && branch.forks.length > 0;
}

function inFork(forkId: string, entry: { forks: ForkFrame[] }): boolean {
  return entry.forks.some((f) => f.id === forkId);
}

function collapseFork(
  live: LiveEntry[],
  finished: Terminal[],
  bad: Terminal,
): [LiveEntry[], Terminal[]] {
  const frame = bad.forks[bad.forks.length - 1]!;
  const members = [
    ...finished.filter((e) => inFork(frame.id, e)),
    ...live.filter((e) => inFork(frame.id, e)),
  ];
  const branchOpts = members.map((m) => m.opts);
  const worst = branchWorstExit(branchOpts);
  const worstOpts = branchOpts.find((o) => (o["red/exit"] ?? 0) === worst);
  const collapsed: Terminal = {
    opts: {
      ...frame.opts,
      "red/exit": worst,
      "red/err": worstOpts?.["red/err"],
      "red/trace": worstOpts?.["red/trace"],
      "red/branches": branchOpts,
    },
    forks: bad.forks.slice(0, -1),
  };
  return [
    live.filter((e) => !inFork(frame.id, e)),
    [...finished.filter((e) => !inFork(frame.id, e)), collapsed],
  ];
}

// While a finished branch failed inside a fork, collapse that fork: absorb
// its live entries (their current opts are their branch results — siblings
// finished their step, nothing new starts) and its finished branches, skip
// the join, and emit a terminal carrying the worst exit and "red/branches".
// Cascades outward through nested forks.
function collapseDoomed(live: LiveEntry[], finished: Terminal[]): [LiveEntry[], Terminal[]] {
  for (;;) {
    const bad = finished.find(failedForkBranch);
    if (!bad) return [live, finished];
    [live, finished] = collapseFork(live, finished, bad);
  }
}

function dissocInherited(opts: Opts): Opts {
  if (!(INHERITED in opts)) return opts;
  const { [INHERITED]: _inherited, ...rest } = opts;
  return rest;
}

function finalize(finished: Terminal[]): Opts {
  const terminals = finished.map((f) => dissocInherited(f.opts));
  if (terminals.length === 0) return { "red/exit": 0 };
  if (terminals.length === 1) return terminals[0]!;
  return terminals.find(failed) ?? terminals[terminals.length - 1]!;
}

function blockedStep(g: StaticGraph, live: LiveEntry[], step: string): boolean {
  return live.some((e) => e.step !== step && reaches(g, e.step, step));
}

function readySteps(g: StaticGraph, live: LiveEntry[], byStep: Record<string, LiveEntry[]>): string[] {
  const steps = Object.keys(byStep);
  const unblocked = steps.filter((s) => !blockedStep(g, live, s));
  return unblocked.length ? unblocked : steps;
}

function sameOrigin(entries: LiveEntry[]): boolean {
  return entries.length === 1 || entries.every((e) => e.parent === entries[0]!.parent);
}

function stepUnits(step: string, entries: LiveEntry[]): Unit[] {
  if (sameOrigin(entries)) {
    return entries.map((entry) => ({ kind: "single", step, entry }) as Unit);
  }
  return [{ kind: "join", step, entries }];
}

async function schedulerStep(
  wf: Workflow,
  runOpts: Opts,
  g: StaticGraph,
  live: LiveEntry[],
  finished: Terminal[],
): Promise<[LiveEntry[], Terminal[]]> {
  const byStep: Record<string, LiveEntry[]> = {};
  for (const e of live) {
    (byStep[e.step] ??= []).push(e);
  }
  const ready = readySteps(g, live, byStep);
  const readySet = new Set(ready);
  const waiting = Object.keys(byStep).filter((s) => !readySet.has(s));
  const units = ready.flatMap((s) => stepUnits(s, byStep[s]!));
  const results = await Promise.all(units.map((u) => runUnit(wf, runOpts, u)));
  return collapseDoomed(
    [...waiting.flatMap((s) => byStep[s]!), ...results.flatMap((r) => r.newEntries ?? [])],
    [...finished, ...results.flatMap((r) => r.terminals ?? [])],
  );
}

// Turn a workflow into a step function (opts -> Promise<opts>), so workflows
// compose into higher-level workflows: wire the result like any other step,
// advise it, fan it out. The sub-workflow's "red/exit" propagates naturally,
// and ambient keys like "red/event" and "red/dry-run" flow in with opts.
//
// The enclosing run's advice is inherited: the nested run merges it over the
// sub-workflow's own. The engine re-stamps the inherited registry after `in`
// runs, so `in` may build sub-opts from scratch without severing inheritance.
//
// Options:
//   in:  (opts) => subOpts        — shape the opts entering the sub-workflow
//   out: (opts, subResult) => opts — merge the sub-result back into the
//                                    parent's opts (default: the sub-result
//                                    itself is the step's result)
export function step(
  wf: Workflow,
  opts: { in?: (opts: Opts) => Opts; out?: (opts: Opts, subResult: Opts) => Opts } = {},
): StepFn {
  const { in: inFn, out: outFn } = opts;
  return async (o: Opts): Promise<Opts> => {
    const inherited = o[INHERITED];
    let subOpts = inFn ? inFn(o) : o;
    if (inherited) subOpts = { ...subOpts, [INHERITED]: inherited };
    const result = await run(wf, subOpts);
    return outFn ? outFn(o, result) : result;
  };
}

// Run the workflow from its start step with `opts` as the initial state.
// The same initial opts are passed to `wireFn` as `runOpts` for the whole
// run, so the static graph stays stable. Returns the final opts map; its
// "red/exit" is the workflow's exit code. When `opts` carries an inherited
// advice registry (stamped by an enclosing run through `step`), it is merged
// over the workflow's own advice before anything runs.
export async function run(wf: Workflow, opts: Opts): Promise<Opts> {
  const runOpts = opts;
  const w = inherit(wf, opts[INHERITED]);
  const g = staticGraph(w.wireFn, w.start, runOpts);
  let live: LiveEntry[] = [{ step: w.start, opts, parent: ROOT, forks: [] }];
  let finished: Terminal[] = [];
  while (live.length) {
    [live, finished] = await schedulerStep(w, runOpts, g, live, finished);
  }
  return finalize(finished);
}
