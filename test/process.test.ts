import { expect, test } from "bun:test";
import { runInherit } from "../src/process.ts";
import { runtime } from "../src/runtime.ts";
import { failed, run, workflow, type StepFn } from "../src/workflow.ts";

for (const code of [0, 7]) {
  test(`inherited process preserves exit ${code}`, async () => {
    expect(await runInherit([process.execPath, "-e", `process.exit(${code})`]))
      .toEqual({ exit: code, out: "", err: "" });
  });
}

const failures = [
  { name: "missing executable", args: ["/nonexistent/red-inherited-command"], exit: 127 },
  { name: "signal termination", args: [process.execPath, "-e", 'process.kill(process.pid, "SIGTERM")'], exit: 143 },
];

for (const failure of failures) {
  test.skipIf(process.platform === "win32" && failure.exit === 143)(`inherited ${failure.name} stops workflow successors`, async () => {
    const visited: string[] = [];
    const execute: StepFn = async (opts) => {
      visited.push("execute");
      const result = await runInherit(failure.args);
      expect(result.exit).toBe(failure.exit);
      expect(result.out).toBe("");
      if (failure.exit === 127) expect(result.err.length).toBeGreaterThan(0);
      return { ...opts, "red/exit": result.exit, "red/err": result.err };
    };
    const successor: StepFn = (opts) => {
      visited.push("successor");
      return opts;
    };
    const result = await run(workflow({
      start: "execute",
      wireFn: (step) => step === "execute" ? [execute, "successor"] : [successor],
    }), {});
    expect(result["red/exit"]).toBe(failure.exit);
    expect(failed(result)).toBe(true);
    expect(visited).toEqual(["execute"]);
  });
}

test("runInherit forwards arguments and options through the mutable runtime", async () => {
  const original = runtime.execInherit;
  const args = ["stubbed-interactive-command", "argument"];
  const opts = { cwd: "/stubbed-directory", env: { EXAMPLE: "value" } };
  const expected = { exit: 9, out: "stub output", err: "stub failure" };
  let calls = 0;
  runtime.execInherit = async (command, options) => {
    calls += 1;
    expect(command).toBe(args);
    expect(options).toBe(opts);
    return expected;
  };
  try {
    expect(await runInherit(args, opts)).toBe(expected);
    expect(calls).toBe(1);
  } finally {
    runtime.execInherit = original;
  }
});
