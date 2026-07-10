import { afterEach, expect, test } from "bun:test";
import * as dryRun from "../src/dry-run.ts";
import { runtime } from "../src/runtime.ts";
import type { Opts } from "../src/workflow.ts";
import { adviceRemove, run, workflow } from "../src/workflow.ts";

const originalLog = runtime.log;
afterEach(() => {
  runtime.log = originalLog;
});

function captureLog(): string[] {
  const lines: string[] = [];
  runtime.log = (...args: unknown[]) => lines.push(args.join(" "));
  return lines;
}

const effectWf = (effects: string[]) =>
  dryRun.advise(
    workflow({
      start: "t/a",
      wireFn: (s) => {
        switch (s) {
          case "t/a":
            return [
              (o: Opts) => {
                effects.push("a");
                return o;
              },
              "t/b",
            ];
          case "t/b":
            return [
              (o: Opts) => {
                effects.push("b");
                return o;
              },
            ];
        }
      },
    }),
    ["t/a", "t/b"],
  );

test("dry-run skips advised steps", async () => {
  const effects: string[] = [];
  const out = captureLog();
  const res = await run(effectWf(effects), { "red/event": "create", "red/dry-run": true });
  expect(res["red/exit"]).toBe(0);
  // no side effects ran
  expect(effects).toEqual([]);
  expect(out.some((l) => l.includes("would run t/a"))).toBe(true);
  expect(out.some((l) => l.includes("would run t/b"))).toBe(true);
});

test("without the flag, steps run normally", async () => {
  const effects: string[] = [];
  const res = await run(effectWf(effects), { "red/event": "create" });
  expect(res["red/exit"]).toBe(0);
  expect(effects).toEqual(["a", "b"]);
});

test("dry-run advice is removable per step", async () => {
  const effects: string[] = [];
  const w = adviceRemove(effectWf(effects), "t/b", dryRun.SKIP_ID);
  captureLog();
  await run(w, { "red/event": "create", "red/dry-run": true });
  // t/a skipped, t/b ran
  expect(effects).toEqual(["b"]);
});
