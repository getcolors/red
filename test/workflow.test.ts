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

test("step in/out scope the sub-workflow", async () => {
  const sub = workflow({
    start: "s/a",
    wireFn: () => [(o) => ({ ...o, result: 2 * o.n })],
  });
  const parent = workflow({
    start: "p/sub",
    wireFn: () => [
      step(sub, {
        in: (o) => ({ "red/event": o["red/event"], n: o.parentN }),
        out: (o, r) => ({ ...o, doubled: r.result }),
      }),
    ],
  });
  const res = await run(parent, { "red/event": "create", parentN: 21, keepMe: "yes" });
  expect(res.doubled).toBe(42);
  // out preserved the parent opts
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
