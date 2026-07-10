// Emacs-style advice for step functions: the full set of nadvice
// combinators, LIFO stacking (most recently added outermost) with an
// optional depth override, removal by explicit id.
// Registries are plain maps of step-name -> array of
// {id, how, fn, seq, depth}, so all operations are pure — advice is
// workflow-scoped, not global. A workflow embedded via red/workflow's
// `step` inherits its ancestors' advice at run time by merging registries
// (see `mergeEntries`); the values stay pure.
// The `seq` field is a caller-assigned monotonic add-order number; it lets
// a step-scoped registry and a separate all-steps registry be merged and
// sorted into one strict add-order stack (see red/workflow's runStep).
// `depth` (-100..100, default 0) overrides add order the way Emacs hook
// depths do: lower pushes the advice outward, higher pushes it inward;
// at equal depth the most recently added is outermost.

// The supported combinators, matching Emacs nadvice. With FUNCTION the
// advice, OLDFUN the prior chain, and r the opts map:
//
//   around        FUNCTION(OLDFUN, r)
//   before        FUNCTION(r) then OLDFUN(r)
//   after         OLDFUN(r) then FUNCTION(r), returns OLDFUN's value
//   override      FUNCTION(r), OLDFUN never runs
//   before-while  FUNCTION(r) && OLDFUN(r)          (Clojure truthiness)
//   before-until  FUNCTION(r) || OLDFUN(r)          (Clojure truthiness)
//   after-while   ret = OLDFUN(r); redTrue(ret) ? FUNCTION(r) : ret
//   after-until   ret = OLDFUN(r); redTrue(ret) ? ret : FUNCTION(r)
//   filter-args   OLDFUN(FUNCTION(r))
//   filter-return FUNCTION(OLDFUN(r))
//
// Typical use cases: around = dry-run/retry/timing/locks; override = stubs;
// before = setup/prerequisites; after = audit/metrics/cleanup;
// before-while = precondition gates; before-until = fast paths/no-ops;
// after-while = success-only follow-ups; after-until = recovery/fallback;
// filter-args = normalize/scope inputs; filter-return = normalize/enrich
// outputs.
//
// For after-while/after-until, a red step result is true only when its
// "red/exit" is 0 (missing means 0); a positive "red/exit" is false.
// Non-object returns keep Clojure truthiness (only null/undefined/false are
// falsy) for compose-level use.

export type AnyFn = (...args: any[]) => any;

export const hows = new Set([
  "around",
  "before",
  "after",
  "override",
  "before-while",
  "before-until",
  "after-while",
  "after-until",
  "filter-args",
  "filter-return",
] as const);

export type How = typeof hows extends Set<infer T> ? T : never;

export interface Entry {
  id: string;
  how: How;
  fn: AnyFn;
  seq: number;
  depth: number;
}

export interface Props {
  depth?: number;
}

export type Registry = Record<string, Entry[]>;

export class AdviceError extends Error {}

function entry(how: How, id: string, fn: AnyFn, order: number, props?: Props | null): Entry {
  if (!hows.has(how)) {
    throw new AdviceError(`unsupported advice combinator: ${how}`);
  }
  const depth = props?.depth ?? 0;
  if (!(depth >= -100 && depth <= 100)) {
    throw new AdviceError("advice depth must be in -100..100");
  }
  return { id, how, fn, seq: order, depth };
}

function removeEntryIds(entries: Entry[] | undefined, ids: Set<string>): Entry[] {
  return (entries ?? []).filter((e) => !ids.has(e.id));
}

function removeEntryId(entries: Entry[] | undefined, id: string): Entry[] {
  return removeEntryIds(entries, new Set([id]));
}

// Register advice `fn` on `step` with combinator `how` under `id`, tagged
// with add-order `order`. Re-adding an existing id replaces it and moves it
// to the top of the stack for its depth (given a fresh, larger order).
export function add(
  registry: Registry,
  step: string,
  how: How,
  id: string,
  fn: AnyFn,
  order: number,
  props?: Props | null,
): Registry {
  return {
    ...registry,
    [step]: [...removeEntryId(registry[step], id), entry(how, id, fn, order, props)],
  };
}

export function removeId(registry: Registry, step: string, id: string): Registry {
  return { ...registry, [step]: removeEntryId(registry[step], id) };
}

// Like `add`, but for a flat (not step-keyed) array of entries — used for
// advice that applies to every step.
export function addGlobal(
  entries: Entry[],
  how: How,
  id: string,
  fn: AnyFn,
  order: number,
  props?: Props | null,
): Entry[] {
  return [...removeEntryId(entries, id), entry(how, id, fn, order, props)];
}

export function removeGlobalId(entries: Entry[], id: string): Entry[] {
  return removeEntryId(entries, id);
}

// Stack `outer` entries (inherited from an enclosing workflow) outside
// `inner` ones: outer seqs are rebased by `offset` so they sort above every
// inner seq, and an outer entry replaces an inner one with the same id.
// Depth still overrides placement at compose time.
export function mergeEntries(inner: Entry[], outer: Entry[], offset: number): Entry[] {
  const rebased = outer.map((e) => ({ ...e, seq: e.seq + offset }));
  const replacedIds = new Set(rebased.map((e) => e.id));
  return [...removeEntryIds(inner, replacedIds), ...rebased];
}

// Merge an outer step-keyed registry over an inner one, step by step.
export function mergeRegistry(inner: Registry, outer: Registry, offset: number): Registry {
  const result: Registry = { ...inner };
  for (const [step, entries] of Object.entries(outer)) {
    result[step] = mergeEntries(result[step] ?? [], entries, offset);
  }
  return result;
}

// Clojure truthiness: only null/undefined/false are falsy (0 and "" are true).
export function truthy(x: unknown): boolean {
  return x !== null && x !== undefined && x !== false;
}

function isPlainMap(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

// Truth predicate for red step returns: success is true, failure is false.
// Compose can also be used directly with non-object values, where Clojure
// truthiness is preserved.
function redTrue(ret: unknown): boolean {
  if (isPlainMap(ret)) {
    return ((ret["red/exit"] as number | undefined) ?? 0) === 0;
  }
  return truthy(ret);
}

function wrap(how: How, adviceFn: AnyFn, base: AnyFn): AnyFn {
  switch (how) {
    case "around":
      return async (opts) => adviceFn(base, opts);
    case "override":
      return async (opts) => adviceFn(opts);
    case "before":
      return async (opts) => {
        await adviceFn(opts);
        return base(opts);
      };
    case "after":
      return async (opts) => {
        const ret = await base(opts);
        await adviceFn(opts);
        return ret;
      };
    case "before-while":
      return async (opts) => {
        const a = await adviceFn(opts);
        return truthy(a) ? base(opts) : a;
      };
    case "before-until":
      return async (opts) => {
        const a = await adviceFn(opts);
        return truthy(a) ? a : base(opts);
      };
    case "after-while":
      return async (opts) => {
        const ret = await base(opts);
        return redTrue(ret) ? adviceFn(opts) : ret;
      };
    case "after-until":
      return async (opts) => {
        const ret = await base(opts);
        return redTrue(ret) ? ret : adviceFn(opts);
      };
    case "filter-args":
      return async (opts) => base(await adviceFn(opts));
    case "filter-return":
      return async (opts) => adviceFn(await base(opts));
  }
}

// Entries sorted innermost-first — the order `compose` wraps them: higher
// depth is more inward; at equal depth the most recently added (largest seq)
// is outermost.
export function ordered(entries: Entry[]): Entry[] {
  return [...entries].sort((a, b) => b.depth - a.depth || a.seq - b.seq);
}

// Wrap `base` with `entries`, ordered like Emacs nadvice: lower depth is
// more outward; at equal depth the most recently added (largest seq) is
// outermost. The reduce builds inside-out over `ordered` (innermost-first)
// entries. The composed function is always async.
export function compose(base: AnyFn, entries: Entry[]): AnyFn {
  return ordered(entries).reduce((g, e) => wrap(e.how, e.fn, g), base);
}
