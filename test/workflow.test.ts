import { expect, test } from "bun:test";
import type { Opts } from "../src/workflow.ts";
import { run, step, StepError, workflow } from "../src/workflow.ts";

const mark = (k: string) => (o: Opts): Opts => ({ ...o, seen: [...(o.seen ?? []), k] });

test("linear happy path", async () => {
  const w = workflow({
    start: "t/a",
    wireFn: (s) => {
      switch (s) {
        case "t/a":
          return [mark("a"), "t/b"];
        case "t/b":
          return [mark("b"), "t/c"];
        case "t/c":
          return [mark("c")];
      }
    },
  });
  const res = await run(w, {});
  expect(res.seen).toEqual(["a", "b", "c"]);
  expect(res["red/exit"]).toBe(0);
});

test("error halts without nextFn", async () => {
  const w = workflow({
    start: "t/a",
    wireFn: (s) => {
      switch (s) {
        case "t/a":
          return [mark("a"), "t/b"];
        case "t/b":
          return [(o) => ({ ...o, "red/exit": 3 }), "t/c"];
        case "t/c":
          return [mark("c")];
      }
    },
  });
  const res = await run(w, {});
  expect(res["red/exit"]).toBe(3);
  // t/c must not run
  expect(res.seen).toEqual(["a"]);
});

test("exception becomes exit/err/trace", async () => {
  const w = workflow({
    start: "t/a",
    wireFn: (s) => {
      switch (s) {
        case "t/a":
          return [
            () => {
              throw new Error("boom");
            },
            "t/b",
          ];
        case "t/b":
          return [mark("b")];
      }
    },
  });
  const res = await run(w, {});
  expect(res["red/exit"]).toBe(1);
  expect(res["red/err"]).toBe("boom");
  expect(typeof res["red/trace"]).toBe("string");
  // t/b must not run
  expect(res.seen).toBeUndefined();
});

test("StepError chooses the exit code", async () => {
  const w = workflow({
    start: "t/a",
    wireFn: () => [
      () => {
        throw new StepError("custom", { exit: 7 });
      },
    ],
  });
  const res = await run(w, {});
  expect(res["red/exit"]).toBe(7);
  expect(res["red/err"]).toBe("custom");
});

test("a step returning a non-map fails loudly", async () => {
  const w = workflow({
    start: "t/a",
    // a forgotten return: the step yields undefined
    wireFn: () => [(() => undefined) as any],
  });
  const res = await run(w, {});
  expect(res["red/exit"]).toBe(1);
  expect(res["red/err"]).toMatch(/returned a non-map/);
});

test("a step mutating its frozen input fails through the contract", async () => {
  const w = workflow({
    start: "t/a",
    wireFn: () => [
      ((o: Opts) => {
        o.x = 1; // strict-mode assignment to a frozen object throws
        return o;
      }) as any,
    ],
  });
  const res = await run(w, {});
  expect(res["red/exit"]).toBe(1);
  expect(res["red/err"]).toMatch(/read.?only|frozen|not extensible/i);
});

test("end step is an inclusive slice boundary", async () => {
  const wire = (s: string) => {
    switch (s) {
      case "t/a":
        return [mark("a"), "t/b"] as const;
      case "t/b":
        return [mark("b"), "t/c"] as const;
      case "t/c":
        return [mark("c")] as const;
    }
  };
  // end stops after running it
  expect((await run(workflow({ start: "t/a", end: "t/b", wireFn: wire }), {})).seen).toEqual([
    "a",
    "b",
  ]);
  // start skips earlier steps
  expect((await run(workflow({ start: "t/b", wireFn: wire }), {})).seen).toEqual(["b", "c"]);
});

test("wireFn can select an event-specific static graph", async () => {
  const w = workflow({
    start: "t/start",
    wireFn: (s, runOpts) => {
      const key = `${runOpts["red/event"]} ${s}`;
      switch (key) {
        case "create t/start":
          return [mark("start"), "t/node"];
        case "create t/node":
          return [mark("node"), "t/ansible"];
        case "create t/ansible":
          return [mark("ansible")];
        case "delete t/start":
          return [mark("start"), "t/ansible"];
        case "delete t/ansible":
          return [mark("ansible"), "t/node"];
        case "delete t/node":
          return [mark("node")];
      }
    },
  });
  expect((await run(w, { "red/event": "create" })).seen).toEqual(["start", "node", "ansible"]);
  expect((await run(w, { "red/event": "delete" })).seen).toEqual(["start", "ansible", "node"]);
});

test("wireFn uses stable run-opts, not branch opts", async () => {
  const w = workflow({
    start: "t/start",
    wireFn: (s, runOpts) => {
      switch (s) {
        case "t/start":
          return [(o) => o, "t/work"];
        case "t/work":
          return [mark("work"), runOpts.route === "branch" ? "t/branch-done" : "t/run-done"];
        case "t/run-done":
          return [mark("run-done")];
        case "t/branch-done":
          return [mark("branch-done")];
      }
    },
    nextFn: (s, defaultNext, opts) =>
      s === "t/start"
        ? [["t/work", { ...opts, route: "branch" }]]
        : (defaultNext ?? []).map((n) => [n, opts] as const),
  });
  const res = await run(w, { route: "run" });
  expect(res.seen).toEqual(["work", "run-done"]);
  // the step still receives branch-local opts
  expect(res.route).toBe("branch");
});

test("nextFn reroutes errors", async () => {
  const w = workflow({
    start: "t/a",
    wireFn: (s) => {
      switch (s) {
        case "t/a":
          return [(o) => ({ ...o, "red/exit": 7 }), "t/b"];
        case "t/b":
          return [mark("b")];
        case "t/cleanup":
          return [(o) => mark("cleanup")({ ...o, "red/exit": 0 })];
      }
    },
    nextFn: (s, defaultNext, opts) => {
      if ((opts["red/exit"] ?? 0) > 0) {
        return s === "t/cleanup" ? null : [["t/cleanup", opts]];
      }
      return (defaultNext ?? []).map((n) => [n, opts] as const);
    },
  });
  const res = await run(w, {});
  expect(res.seen).toEqual(["cleanup"]);
  expect(res["red/exit"]).toBe(0);
});

test("nextFn null terminates", async () => {
  const w = workflow({
    start: "t/a",
    wireFn: (s) => {
      switch (s) {
        case "t/a":
          return [mark("a"), "t/b"];
        case "t/b":
          return [mark("b")];
      }
    },
    nextFn: () => null,
  });
  expect((await run(w, {})).seen).toEqual(["a"]);
});

test("static fork and join", async () => {
  // t/a forks to t/b and t/c; t/c has a longer chain (t/c -> t/c2); both
  // arrive at t/d, which must run once with both branches collected.
  const w = workflow({
    start: "t/a",
    wireFn: (s) => {
      switch (s) {
        case "t/a":
          return [mark("a"), "t/b", "t/c"];
        case "t/b":
          return [mark("b"), "t/d"];
        case "t/c":
          return [mark("c"), "t/c2"];
        case "t/c2":
          return [mark("c2"), "t/d"];
        case "t/d":
          return [(o) => ({ ...o, joined: o["red/branches"].map((b: Opts) => b.seen) })];
      }
    },
  });
  const res = await run(w, {});
  expect(res["red/exit"]).toBe(0);
  expect(res["red/branches"]).toHaveLength(2);
  // join waited for the longer branch
  expect(new Set(res.joined.map((s: string[]) => s.join(",")))).toEqual(
    new Set(["a,b", "a,c,c2"]),
  );
  // join base opts come from the fork point, not a branch
  expect(res.seen).toEqual(["a"]);
});

test("dynamic fan-out and join", async () => {
  const w = workflow({
    start: "t/fan",
    wireFn: (s) => {
      switch (s) {
        case "t/fan":
          return [mark("fan"), "t/work"];
        case "t/work":
          return [(o) => ({ ...o, done: o.n }), "t/join"];
        case "t/join":
          return [
            (o) => ({ ...o, collected: new Set(o["red/branches"].map((b: Opts) => b.done)) }),
          ];
      }
    },
    nextFn: (s, defaultNext, opts) => {
      if ((opts["red/exit"] ?? 0) > 0) return [];
      if (s === "t/fan") return [1, 2, 3].map((n) => ["t/work", { ...opts, n }] as const);
      return (defaultNext ?? []).map((n) => [n, opts] as const);
    },
  });
  const res = await run(w, {});
  expect(res["red/exit"]).toBe(0);
  expect(res["red/branches"]).toHaveLength(3);
  expect(res.collected).toEqual(new Set([1, 2, 3]));
});

test("branch failure skips the join and propagates the worst exit", async () => {
  const w = workflow({
    start: "t/a",
    wireFn: (s) => {
      switch (s) {
        case "t/a":
          return [mark("a"), "t/ok", "t/bad"];
        case "t/ok":
          return [mark("ok"), "t/d"];
        case "t/bad":
          return [(o) => ({ ...o, "red/exit": 5, "red/err": "bad branch" }), "t/d"];
        case "t/d":
          return [mark("join-ran")];
      }
    },
  });
  const res = await run(w, {});
  expect(res["red/exit"]).toBe(5);
  expect(res["red/err"]).toBe("bad branch");
  // join must be skipped
  expect((res.seen ?? []).includes("join-ran")).toBe(false);
  // both branches finished
  expect(res["red/branches"]).toHaveLength(2);
});

test("workflows compose as steps", async () => {
  const sub = workflow({
    start: "s/a",
    wireFn: (s) => {
      switch (s) {
        case "s/a":
          return [mark("sub-a"), "s/b"];
        case "s/b":
          return [mark("sub-b")];
      }
    },
  });
  const parent = workflow({
    start: "p/a",
    wireFn: (s) => {
      switch (s) {
        case "p/a":
          return [mark("p-a"), "p/sub"];
        case "p/sub":
          return [step(sub), "p/z"];
        case "p/z":
          return [mark("p-z")];
      }
    },
  });
  const res = await run(parent, {});
  expect(res["red/exit"]).toBe(0);
  expect(res.seen).toEqual(["p-a", "sub-a", "sub-b", "p-z"]);
});

test("sub-workflow failure halts the parent", async () => {
  const sub = workflow({
    start: "s/a",
    wireFn: () => [(o) => ({ ...o, "red/exit": 4, "red/err": "sub failed" })],
  });
  const parent = workflow({
    start: "p/sub",
    wireFn: (s) => {
      switch (s) {
        case "p/sub":
          return [step(sub), "p/z"];
        case "p/z":
          return [mark("p-z")];
      }
    },
  });
  const res = await run(parent, {});
  expect(res["red/exit"]).toBe(4);
  expect(res["red/err"]).toBe("sub failed");
  // p/z must not run
  expect(res.seen).toBeUndefined();
});

test("step inFn/outFn scope the sub-workflow", async () => {
  const sub = workflow({
    start: "s/a",
    wireFn: () => [(o) => ({ ...o, result: 2 * o.n })],
  });
  const parent = workflow({
    start: "p/sub",
    wireFn: () => [
      step(sub, {
        inFn: (o) => ({ "red/event": o["red/event"], n: o.parentN }),
        outFn: (o, r) => ({ ...o, doubled: r.result }),
      }),
    ],
  });
  const res = await run(parent, { "red/event": "create", parentN: 21, keepMe: "yes" });
  expect(res.doubled).toBe(42);
  // outFn preserved the parent opts
  expect(res.keepMe).toBe("yes");
});

test("parallel branches actually run concurrently", async () => {
  let inFlight = 0;
  let peak = 0;
  const slow = async (o: Opts): Promise<Opts> => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await Bun.sleep(50);
    inFlight -= 1;
    return o;
  };
  const w = workflow({
    start: "t/a",
    wireFn: (s) => {
      switch (s) {
        case "t/a":
          return [(o) => o, "t/x", "t/y", "t/z"];
        case "t/x":
          return [slow, "t/d"];
        case "t/y":
          return [slow, "t/d"];
        case "t/z":
          return [slow, "t/d"];
        case "t/d":
          return [(o) => o];
      }
    },
  });
  const res = await run(w, { "red/exit": 0 });
  expect(res["red/exit"]).toBe(0);
  // branches overlapped in time
  expect(peak).toBeGreaterThan(1);
});

for (const rightLength of [1, 4]) {
  for (const enclosingFork of [false, true]) {
    test(`nested join uses common ancestry with right length ${rightLength}, enclosing fork ${enclosingFork}`, async () => {
      const graph: Record<string, string[]> = {
        "t/root": enclosingFork ? ["t/fork", "t/outside"] : ["t/fork"],
        "t/fork": ["t/left", "t/right1"],
        "t/left": ["t/leaf1", "t/leaf2"],
        "t/leaf1": ["t/join"], "t/leaf2": ["t/join"],
        "t/join": enclosingFork ? ["t/final"] : [],
        "t/outside": ["t/final"], "t/final": [],
      };
      for (let i = 1; i <= rightLength; i++) {
        graph[`t/right${i}`] = [i === rightLength ? "t/join" : `t/right${i + 1}`];
      }
      const joins: Opts[] = [];
      const result = await run(workflow({ start: "t/root", wireFn: (s) => [
        (o) => {
          if (s === "t/join" || s === "t/final") {
            joins.push({ step: s, base: o.path, branches: o["red/branches"] });
          }
          return { ...o, path: [...(o.path ?? []), s] };
        }, ...graph[s]!,
      ] }), {});
      expect(result["red/exit"]).toBe(0);
      expect(joins[0]!.base).toEqual(["t/root", "t/fork"]);
      expect(joins[0]!.branches).toHaveLength(3);
      expect(joins).toHaveLength(enclosingFork ? 2 : 1);
      if (enclosingFork) {
        expect(joins[1]!.base).toEqual(["t/root"]);
        expect(joins[1]!.branches).toHaveLength(2);
      }
    });
  }
}

test("failure after a nested join does not collapse an already joined fork", async () => {
  const graph: Record<string, string[]> = {
    "t/root": ["t/left", "t/right"], "t/left": ["t/a", "t/b"],
    "t/a": ["t/join"], "t/b": ["t/join"], "t/right": ["t/r2"],
    "t/r2": ["t/r3"], "t/r3": ["t/join"], "t/join": ["t/fail"], "t/fail": [],
  };
  const result = await run(workflow({ start: "t/root", wireFn: (s) => [
    (o) => s === "t/fail" ? { ...o, "red/exit": 8, "red/err": "after join" }
      : { ...o, joined: s === "t/join" || o.joined }, ...graph[s]!,
  ] }), {});
  expect(result["red/exit"]).toBe(8);
  expect(result.joined).toBe(true);
  expect(result["red/branches"]).toHaveLength(3);
});

for (const exits of [[3, 9], [9, 3], [9, 9]]) {
  test(`failed join preserves diagnostics for exits ${exits}`, async () => {
    const result = await run(workflow({ start: "t/root", wireFn: (s) => {
      if (s === "t/root") return [(o) => o, "t/a", "t/b"];
      if (s === "t/join") return [() => { throw new Error("join must not execute"); }];
      const n = s === "t/a" ? 0 : 1;
      return [(o) => ({ ...o, "red/exit": exits[n], "red/err": `error ${n}`, "red/trace": `trace ${n}` }), "t/join"];
    }, nextFn: (_s, ns, o) => (ns ?? []).map((n) => [n, o] as const) }), {});
    const winner = exits[0]! >= exits[1]! ? 0 : 1;
    expect(result["red/exit"]).toBe(Math.max(...exits));
    expect(result["red/err"]).toBe(`error ${winner}`);
    expect(result["red/trace"]).toBe(`trace ${winner}`);
    expect(result["red/branches"]).toHaveLength(2);
  });
}

test("already frozen containers still protect nested step input", async () => {
  const original = { project: Object.freeze({ nested: { value: "before" } }) };
  const result = await run(workflow({ start: "t/change", wireFn: () => [(o) => {
    o.project.nested.value = "after";
    throw new Error("later failure");
  }] }), original);
  expect(result["red/exit"]).toBe(1);
  expect(original.project.nested.value).toBe("before");
  expect(result.project.nested.value).toBe("before");
});

for (const value of [new Map([["key", "before"]]), new Set(["before"]), new Date(), new Uint8Array([1])]) {
  test(`unsupported ${value.constructor.name} input fails before a step runs`, async () => {
    let called = false;
    const result = await run(workflow({ start: "t/change", wireFn: () => [(o) => {
      called = true;
      return o;
    }] }), { project: value });
    expect(called).toBe(false);
    expect(result["red/exit"]).toBe(1);
    expect(result["red/err"]).toContain("unsupported mutable step input");
  });
}

test("freezing preserves cyclic data and callable values", async () => {
  const data: Opts = { value: 1 };
  data.self = data;
  const result = await run(workflow({ start: "t/read", wireFn: () => [(o) => ({
    ...o, value: o.compute(o.data.self.value),
  })] }), { data, compute: (n: number) => n + 1 });
  expect(result["red/exit"]).toBe(0);
  expect(result.value).toBe(2);
});

test("join routing exceptions preserve common fork context", async () => {
  const graph: Record<string, string[]> = {
    "t/root": ["t/left", "t/right"], "t/left": ["t/a", "t/b"],
    "t/a": ["t/join"], "t/b": ["t/join"], "t/right": ["t/r2"],
    "t/r2": ["t/r3"], "t/r3": ["t/join"], "t/join": [],
  };
  const result = await run(workflow({ start: "t/root", wireFn: (s) => [
    (o) => ({ ...o, path: [...(o.path ?? []), s] }), ...graph[s]!,
  ], nextFn: (s, ns, o) => {
    if (s === "t/join") throw new Error("routing failed");
    return (ns ?? []).map((n) => [n, o] as const);
  } }), {});
  expect(result["red/exit"]).toBe(1);
  expect(result["red/err"]).toBe("routing failed");
  expect(result.path).toEqual(["t/root"]);
  expect(result["red/branches"]).toHaveLength(3);
});
