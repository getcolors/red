import { describe, expect, test } from "bun:test";
import * as advice from "../src/advice.ts";
import type { Opts } from "../src/workflow.ts";
import {
  adviceAdd,
  adviceAddAll,
  advicePlan,
  adviceRemove,
  adviceRemoveAll,
  run,
  step,
  workflow,
} from "../src/workflow.ts";

const log = (o: Opts, x: string): Opts => ({ ...o, log: [...(o.log ?? []), x] });

const singleStepWf = () =>
  workflow({ start: "t/step", wireFn: () => [(o) => log(o, "base")] });

test("filter-return advice stacks LIFO (most recently added outermost)", async () => {
  const base = singleStepWf();
  const advised = adviceAdd(
    adviceAdd(base, "t/step", "filter-return", "test/a", (o: Opts) => log(o, "a")),
    "t/step",
    "filter-return",
    "test/b",
    (o: Opts) => log(o, "b"),
  );
  expect((await run(advised, {})).log).toEqual(["base", "a", "b"]);
  // the original workflow is untouched (workflow-scoped advice)
  expect((await run(base, {})).log).toEqual(["base"]);
});

test("advice-remove by id", async () => {
  let wf = singleStepWf();
  wf = adviceAdd(wf, "t/step", "filter-return", "test/a", (o: Opts) => log(o, "a"));
  wf = adviceAdd(wf, "t/step", "filter-return", "test/b", (o: Opts) => log(o, "b"));
  wf = adviceRemove(wf, "t/step", "test/a");
  expect((await run(wf, {})).log).toEqual(["base", "b"]);
});

test("re-adding the same id replaces and moves to top", async () => {
  let wf = singleStepWf();
  wf = adviceAdd(wf, "t/step", "filter-return", "test/a", (o: Opts) => log(o, "a1"));
  wf = adviceAdd(wf, "t/step", "filter-return", "test/b", (o: Opts) => log(o, "b"));
  wf = adviceAdd(wf, "t/step", "filter-return", "test/a", (o: Opts) => log(o, "a2"));
  expect((await run(wf, {})).log).toEqual(["base", "b", "a2"]);
});

test("override replaces the base", async () => {
  const wf = adviceAdd(singleStepWf(), "t/step", "override", "test/o", (o: Opts) =>
    log(o, "override"),
  );
  expect((await run(wf, {})).log).toEqual(["override"]);
});

test("around controls the call", async () => {
  const wf = adviceAdd(
    singleStepWf(),
    "t/step",
    "around",
    "test/ar",
    async (f: advice.AnyFn, o: Opts) => log(await f(log(o, "in")), "out"),
  );
  expect((await run(wf, {})).log).toEqual(["in", "base", "out"]);
});

test("filter-args transforms input", async () => {
  const wf = adviceAdd(singleStepWf(), "t/step", "filter-args", "test/fa", (o: Opts) => ({
    ...o,
    x: 1,
  }));
  expect((await run(wf, {})).x).toBe(1);
});

test("before and after run for side effects; OLDFUN's value flows out", async () => {
  const seen: Array<[string, unknown]> = [];
  let wf = singleStepWf();
  wf = adviceAdd(wf, "t/step", "before", "test/b", (o: Opts) => {
    seen.push(["before", o.log]);
    return o;
  });
  wf = adviceAdd(wf, "t/step", "after", "test/a", (o: Opts) => {
    seen.push(["after", o.log]);
    return o;
  });
  const res = await run(wf, {});
  // both see the step's input opts (Emacs: both get r); their returns are
  // ignored and OLDFUN's value flows out
  expect(res.log).toEqual(["base"]);
  expect(seen).toEqual([
    ["before", undefined],
    ["after", undefined],
  ]);
});

test("before runs newest-to-oldest, after runs oldest-to-newest", async () => {
  const seen: string[] = [];
  const note = (k: string) => (o: Opts) => {
    seen.push(k);
    return o;
  };
  let wf = singleStepWf();
  wf = adviceAdd(wf, "t/step", "before", "test/b1", note("b1"));
  wf = adviceAdd(wf, "t/step", "before", "test/b2", note("b2"));
  wf = adviceAdd(wf, "t/step", "after", "test/a1", note("a1"));
  wf = adviceAdd(wf, "t/step", "after", "test/a2", note("a2"));
  await run(wf, {});
  expect(seen).toEqual(["b2", "b1", "a1", "a2"]);
});

test("throwing advice fails the step through the contract", async () => {
  const wf = adviceAdd(singleStepWf(), "t/step", "before", "test/boom", () => {
    throw new Error("advice boom");
  });
  const res = await run(wf, {});
  expect(res["red/exit"]).toBe(1);
  expect(res["red/err"]).toBe("advice boom");
  expect(typeof res["red/trace"]).toBe("string");
});

const twoStepWf = () =>
  workflow({
    start: "t/a",
    wireFn: (s) => {
      switch (s) {
        case "t/a":
          return [(o) => log(o, "a"), "t/b"];
        case "t/b":
          return [(o) => log(o, "b")];
      }
    },
  });

test("advice-add-all applies to every step", async () => {
  const wf = adviceAddAll(twoStepWf(), "filter-return", "test/tag", (o: Opts) => log(o, "all"));
  expect((await run(wf, {})).log).toEqual(["a", "all", "b", "all"]);
});

test("advice-add-all interleaves in strict add order with per-step", async () => {
  let wf = twoStepWf();
  wf = adviceAddAll(wf, "filter-return", "test/g1", (o: Opts) => log(o, "g1"));
  wf = adviceAdd(wf, "t/a", "filter-return", "test/pa", (o: Opts) => log(o, "pa"));
  wf = adviceAddAll(wf, "filter-return", "test/g2", (o: Opts) => log(o, "g2"));
  const res = await run(wf, {});
  // t/a ran with both global entries plus its own, in add order
  expect(res.log.slice(0, 4)).toEqual(["a", "g1", "pa", "g2"]);
  // t/b, with no per-step advice, only saw the globals in add order
  expect(res.log.slice(4)).toEqual(["b", "g1", "g2"]);
});

test("advice-remove-all removes the global entry", async () => {
  let wf = twoStepWf();
  wf = adviceAddAll(wf, "filter-return", "test/g", (o: Opts) => log(o, "g"));
  wf = adviceRemoveAll(wf, "test/g");
  expect((await run(wf, {})).log).toEqual(["a", "b"]);
});

// --- the while/until combinators --------------------------------------------

let entrySeq = 0;
const entry = (how: advice.How, fn: advice.AnyFn, seq: number): advice.Entry => ({
  id: `adv-${entrySeq++}`,
  how,
  fn,
  seq,
  depth: 0,
});

describe("before-while", () => {
  test("gates the inward call", async () => {
    const seen: string[] = [];
    const base = (o: Opts) => {
      seen.push("base");
      return log(o, "base");
    };
    // truthy advice lets the chain run; base sees the original opts
    const f = advice.compose(base, [
      entry(
        "before-while",
        () => {
          seen.push("w");
          return true;
        },
        0,
      ),
    ]);
    expect((await f({})).log).toEqual(["base"]);
    expect(seen).toEqual(["w", "base"]);

    // null advice short-circuits: nothing inward runs, result is null
    seen.length = 0;
    const g = advice.compose(base, [
      entry(
        "before-while",
        () => {
          seen.push("w");
          return null;
        },
        0,
      ),
    ]);
    expect(await g({})).toBeNull();
    expect(seen).toEqual(["w"]);
  });

  test("stack runs newest-to-oldest and stops on null", async () => {
    const seen: string[] = [];
    const base = (o: Opts) => {
      seen.push("base");
      return o;
    };
    const f = advice.compose(base, [
      entry(
        "before-while",
        () => {
          seen.push("old");
          return true;
        },
        0,
      ),
      entry(
        "before-while",
        () => {
          seen.push("new");
          return null;
        },
        1,
      ),
    ]);
    expect(await f({})).toBeNull();
    // the newest gate is outermost and stops the chain
    expect(seen).toEqual(["new"]);
  });
});

describe("before-until", () => {
  test("short-circuits on non-null", async () => {
    // a non-null advice return is the result; base never runs
    const hit = adviceAdd(singleStepWf(), "t/step", "before-until", "test/bu", (o: Opts) =>
      log(o, "bu"),
    );
    expect((await run(hit, {})).log).toEqual(["bu"]);
    // a null advice return falls through to the chain
    const miss = adviceAdd(singleStepWf(), "t/step", "before-until", "test/bu", () => null);
    expect((await run(miss, {})).log).toEqual(["base"]);
  });
});

describe("after-while", () => {
  test("runs oldest-to-newest and stops on null", async () => {
    const seen: string[] = [];
    const base = (o: Opts) => {
      seen.push("base");
      return o;
    };
    const f = advice.compose(base, [
      entry(
        "after-while",
        () => {
          seen.push("old");
          return null;
        },
        0,
      ),
      entry(
        "after-while",
        () => {
          seen.push("new");
          return true;
        },
        1,
      ),
    ]);
    expect(await f({})).toBeNull();
    // base first, then oldest advice; its null skips the newer one
    expect(seen).toEqual(["base", "old"]);
  });
});

describe("after-while and after-until use red/exit as truth", () => {
  test("after-while does not run after a failing step result", async () => {
    const seen: string[] = [];
    const f = advice.compose(
      (o: Opts) => {
        seen.push("base");
        return { ...log(o, "base"), "red/exit": 7 };
      },
      [
        entry(
          "after-while",
          (o: Opts) => {
            seen.push("after");
            return { ...log(o, "after"), "red/exit": 0 };
          },
          0,
        ),
      ],
    );
    const ret = await f({});
    expect(ret["red/exit"]).toBe(7);
    expect(ret.log).toEqual(["base"]);
    expect(seen).toEqual(["base"]);
  });

  test("after-until falls through to advice after a failing step result", async () => {
    const seen: string[] = [];
    const f = advice.compose(
      (o: Opts) => {
        seen.push("base");
        return { ...log(o, "base"), "red/exit": 7 };
      },
      [
        entry(
          "after-until",
          (o: Opts) => {
            seen.push("recover");
            return { ...log(o, "recover"), "red/exit": 0 };
          },
          0,
        ),
      ],
    );
    const ret = await f({});
    expect(ret["red/exit"]).toBe(0);
    expect(ret.log).toEqual(["recover"]);
    expect(seen).toEqual(["base", "recover"]);
  });
});

describe("after-until supplies a result when the chain returns null", () => {
  test("compose level: advice only fires when the inward call is null", async () => {
    const f = advice.compose(() => null, [
      entry("after-until", (o: Opts) => log(o, "fallback"), 0),
    ]);
    expect((await f({})).log).toEqual(["fallback"]);
    const g = advice.compose((o: Opts) => log(o, "base"), [
      entry("after-until", (o: Opts) => log(o, "fallback"), 0),
    ]);
    // a non-null chain result short-circuits
    expect((await g({})).log).toEqual(["base"]);
  });

  test("in a workflow: a before-while gate nils the step out and an outer after-until turns that into a real result", async () => {
    let wf = singleStepWf();
    wf = adviceAdd(wf, "t/step", "before-while", "test/gate", () => null);
    wf = adviceAdd(wf, "t/step", "after-until", "test/fallback", (o: Opts) => log(o, "fallback"));
    const res = await run(wf, {});
    expect(res.log).toEqual(["fallback"]);
    expect(res["red/exit"]).toBe(0);
  });
});

test("after-until stack runs oldest-to-newest", async () => {
  const seen: string[] = [];
  const f = advice.compose(
    () => {
      seen.push("base");
      return null;
    },
    [
      entry(
        "after-until",
        () => {
          seen.push("old");
          return null;
        },
        0,
      ),
      entry(
        "after-until",
        () => {
          seen.push("new");
          return "hit";
        },
        1,
      ),
    ],
  );
  expect(await f({})).toBe("hit");
  expect(seen).toEqual(["base", "old", "new"]);
});

// --- depth -------------------------------------------------------------------

test("depth overrides add order", async () => {
  let wf = singleStepWf();
  wf = adviceAdd(wf, "t/step", "filter-return", "test/outer", (o: Opts) => log(o, "outer"), {
    depth: -50,
  });
  wf = adviceAdd(wf, "t/step", "filter-return", "test/mid", (o: Opts) => log(o, "mid"));
  wf = adviceAdd(wf, "t/step", "filter-return", "test/inner", (o: Opts) => log(o, "inner"), {
    depth: 50,
  });
  // lower depth is more outward, higher more inward, whatever the add order
  expect((await run(wf, {})).log).toEqual(["base", "inner", "mid", "outer"]);
});

test("equal depth falls back to newest-outermost", async () => {
  let wf = singleStepWf();
  wf = adviceAdd(wf, "t/step", "filter-return", "test/a", (o: Opts) => log(o, "a"), { depth: -50 });
  wf = adviceAdd(wf, "t/step", "filter-return", "test/b", (o: Opts) => log(o, "b"), { depth: -50 });
  expect((await run(wf, {})).log).toEqual(["base", "a", "b"]);
});

test("depth applies across per-step and all-steps advice", async () => {
  let wf = twoStepWf();
  wf = adviceAddAll(wf, "filter-return", "test/g", (o: Opts) => log(o, "g"));
  wf = adviceAdd(wf, "t/a", "filter-return", "test/p", (o: Opts) => log(o, "p"), { depth: 100 });
  const res = await run(wf, {});
  // depth 100 pushes the later-added per-step advice inside the global one
  expect(res.log.slice(0, 3)).toEqual(["a", "p", "g"]);
  expect(res.log.slice(3)).toEqual(["b", "g"]);
});

test("invalid how and out-of-range depth are rejected at add time", () => {
  expect(() =>
    adviceAdd(singleStepWf(), "t/step", "befor" as advice.How, "test/typo", (o: Opts) => o),
  ).toThrow(/unsupported advice combinator/);
  expect(() =>
    adviceAdd(singleStepWf(), "t/step", "before", "test/deep", (o: Opts) => o, { depth: 101 }),
  ).toThrow(/depth must be in -100..100/);
});

// --- cross-workflow inheritance (advice through wf/step) ---------------------

// A parent workflow that runs p/a, then `sub` as an embedded step, then p/z.
const embed = (sub: ReturnType<typeof workflow>) =>
  workflow({
    start: "p/a",
    wireFn: (s) => {
      switch (s) {
        case "p/a":
          return [(o) => log(o, "p-a"), "p/sub"];
        case "p/sub":
          return [step(sub), "p/z"];
        case "p/z":
          return [(o) => log(o, "p-z")];
      }
    },
  });

test("parent advice reaches an embedded step", async () => {
  const sub = singleStepWf();
  const parent = adviceAdd(embed(sub), "t/step", "filter-return", "test/p", (o: Opts) =>
    log(o, "p"),
  );
  expect((await run(parent, {})).log).toEqual(["p-a", "base", "p", "p-z"]);
  // the child value is untouched — standalone runs stay bare
  expect((await run(sub, {})).log).toEqual(["base"]);
});

test("parent override redefines an embedded step", async () => {
  const parent = adviceAdd(embed(singleStepWf()), "t/step", "override", "test/o", (o: Opts) =>
    log(o, "redefined"),
  );
  expect((await run(parent, {})).log).toEqual(["p-a", "redefined", "p-z"]);
});

test("inherited advice is outermost", async () => {
  const sub = adviceAdd(singleStepWf(), "t/step", "filter-return", "test/c", (o: Opts) =>
    log(o, "child"),
  );
  const parent = adviceAdd(embed(sub), "t/step", "filter-return", "test/p", (o: Opts) =>
    log(o, "parent"),
  );
  expect((await run(parent, {})).log).toEqual(["p-a", "base", "child", "parent", "p-z"]);
});

test("same-id parent advice replaces the child's", async () => {
  const sub = adviceAdd(singleStepWf(), "t/step", "filter-return", "test/x", (o: Opts) =>
    log(o, "child-x"),
  );
  const parent = adviceAdd(embed(sub), "t/step", "filter-return", "test/x", (o: Opts) =>
    log(o, "parent-x"),
  );
  expect((await run(parent, {})).log).toEqual(["p-a", "base", "parent-x", "p-z"]);
});

test("depth overrides inheritance order", async () => {
  const sub = adviceAdd(
    singleStepWf(),
    "t/step",
    "filter-return",
    "test/c",
    (o: Opts) => log(o, "child"),
    { depth: -50 },
  );
  const parent = adviceAdd(embed(sub), "t/step", "filter-return", "test/p", (o: Opts) =>
    log(o, "parent"),
  );
  // the child's depth -50 stays outside the parent's depth-0 advice
  expect((await run(parent, {})).log).toEqual(["p-a", "base", "parent", "child", "p-z"]);
});

test("advice-add-all propagates into embeds", async () => {
  const parent = adviceAddAll(embed(singleStepWf()), "filter-return", "test/g", (o: Opts) =>
    log(o, "g"),
  );
  // every inner step is wrapped, and so is the embed step itself
  expect((await run(parent, {})).log).toEqual(["p-a", "g", "base", "g", "g", "p-z", "g"]);
});

test("inheritance survives a scoping in-fn", async () => {
  const parent = adviceAdd(
    workflow({
      start: "p/sub",
      wireFn: () => [step(singleStepWf(), { in: (o) => ({ n: o.n }) })],
    }),
    "t/step",
    "filter-return",
    "test/p",
    (o: Opts) => log(o, "p"),
  );
  // in built sub-opts from scratch; the engine re-stamped the registry
  expect((await run(parent, { n: 1 })).log).toEqual(["base", "p"]);
});

test("inheritance is transitive through nested embeds", async () => {
  const inner = singleStepWf();
  const mid = workflow({ start: "m/sub", wireFn: () => [step(inner)] });
  const top = adviceAdd(
    workflow({ start: "top/sub", wireFn: () => [step(mid)] }),
    "t/step",
    "filter-return",
    "test/p",
    (o: Opts) => log(o, "top"),
  );
  expect((await run(top, {})).log).toEqual(["base", "top"]);
});

test("the inherited registry does not leak into results", async () => {
  const parent = adviceAdd(
    embed(singleStepWf()),
    "t/step",
    "filter-return",
    "test/p",
    (o: Opts) => o,
  );
  const res = await run(parent, {});
  expect("red.workflow/inherited" in res).toBe(false);
});

test("advice-plan shows the cross-workflow stack", () => {
  let sub = singleStepWf();
  sub = adviceAdd(sub, "t/step", "before", "test/backend", (o: Opts) => o);
  sub = adviceAdd(sub, "t/step", "filter-return", "test/inner", (o: Opts) => o, { depth: 50 });
  let parent = embed(sub);
  parent = adviceAdd(parent, "t/step", "before", "test/backend", (o: Opts) => o);
  parent = adviceAddAll(parent, "around", "test/audit", (f: advice.AnyFn, o: Opts) => f(o));
  // outermost first, with provenance; the parent's backend replaced the child's
  expect(
    advicePlan([parent, sub], "t/step").map((e) => [e.id, e.scope, e.level]),
  ).toEqual([
    ["test/audit", "all", 0],
    ["test/backend", "step", 0],
    ["test/inner", "step", 1],
  ]);
  // a single workflow works too
  expect(advicePlan(sub, "t/step").map((e) => [e.id, e.scope, e.level])).toEqual([
    ["test/backend", "step", 0],
    ["test/inner", "step", 0],
  ]);
});

test("advice-add-all workflow is untouched by later adds", async () => {
  const base = twoStepWf();
  const g1 = adviceAddAll(base, "filter-return", "test/g1", (o: Opts) => log(o, "g1"));
  const g2 = adviceAddAll(g1, "filter-return", "test/g2", (o: Opts) => log(o, "g2"));
  // g1 is untouched by adding g2
  expect((await run(g1, {})).log).toEqual(["a", "g1", "b", "g1"]);
  expect((await run(g2, {})).log).toEqual(["a", "g1", "g2", "b", "g1", "g2"]);
});
