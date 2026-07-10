import { afterEach, expect, test } from "bun:test";
import * as progress from "../src/progress.ts";
import { runtime } from "../src/runtime.ts";
import type { Opts } from "../src/workflow.ts";
import { adviceRemoveAll, run, workflow } from "../src/workflow.ts";

const originalLog = runtime.log;
afterEach(() => {
  runtime.log = originalLog;
});

function captureLog(): string[] {
  const lines: string[] = [];
  runtime.log = (...args: unknown[]) => lines.push(args.join(" "));
  return lines;
}

const simpleWf = () =>
  progress.advise(
    workflow({
      start: "t/a",
      wireFn: (s) => {
        switch (s) {
          case "t/a":
            return [(o: Opts) => o, "t/b"];
          case "t/b":
            return [(o: Opts) => o];
        }
      },
    }),
  );

test("progress prints step names", async () => {
  const out = captureLog();
  await run(simpleWf(), { "red/event": "create" });
  const text = out.join("\n");
  expect(text).toContain(">>> t/a (create)");
  expect(text).toContain("<<< t/a");
  expect(text).toContain(">>> t/b (create)");
  expect(text).toContain("<<< t/b");
  // elapsed time is printed
  expect(text).toContain("ms)");
});

test("progress prints the event name", async () => {
  const out = captureLog();
  await run(simpleWf(), { "red/event": "delete" });
  expect(out.join("\n")).toContain(">>> t/a (delete)");
});

test("progress is removable", async () => {
  const w = adviceRemoveAll(simpleWf(), progress.PROGRESS_ID);
  const out = captureLog();
  await run(w, { "red/event": "create" });
  expect(out).toEqual([]);
});

test("progress with forks", async () => {
  const w = progress.advise(
    workflow({
      start: "t/start",
      wireFn: (s) => {
        switch (s) {
          case "t/start":
            return [(o: Opts) => o, "t/join"];
          case "t/join":
            return [(o: Opts) => o];
        }
      },
      nextFn: (s, defaultNext, o) =>
        s === "t/start"
          ? [
              ["t/join", { ...o, branch: "a" }],
              ["t/join", { ...o, branch: "b" }],
            ]
          : (defaultNext ?? []).map((n) => [n, o] as const),
    }),
  );
  const out = captureLog();
  await run(w, { "red/event": "create" });
  const text = out.join("\n");
  expect(text).toContain(">>> t/start");
  expect(text).toContain(">>> t/join");
});

test("red/step is set in opts", async () => {
  const seen: string[] = [];
  const w = workflow({
    start: "t/a",
    wireFn: (s) => {
      switch (s) {
        case "t/a":
          return [
            (o: Opts) => {
              seen.push(o["red/step"]);
              return o;
            },
            "t/b",
          ];
        case "t/b":
          return [
            (o: Opts) => {
              seen.push(o["red/step"]);
              return o;
            },
          ];
      }
    },
  });
  const res = await run(w, { "red/event": "create" });
  expect(seen).toEqual(["t/a", "t/b"]);
  expect(res["red/exit"]).toBe(0);
});
