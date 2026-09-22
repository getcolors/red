import {expect, test} from "bun:test";
import {withScope, type RegisterFinalizer} from "../src/scope.ts";

test("scope awaits ordered cleanup and returns body value", async () => {
  const events: string[] = [];
  expect(await withScope(async register => {
    register("resource", () => events.push("agent"));
    register("process", async () => { await Bun.sleep(5); events.push("first"); });
    register("process", () => events.push("second"));
    return 42;
  })).toBe(42);
  expect(events).toEqual(["second", "first", "agent"]);
});
test("body rejection wins and all finalizers run", async () => {
  const events: string[] = [], failure = new Error("cancelled");
  await expect(withScope(register => {
    register("resource", () => events.push("agent"));
    register("process", () => {throw new Error("cleanup");});
    throw failure;
  })).rejects.toBe(failure);
  expect(events).toEqual(["agent"]);
});
test("cleanup failures surface and late registration is rejected", async () => {
  let saved!: RegisterFinalizer;
  await expect(withScope(register => {
    saved = register;
    register("resource", () => {throw new Error("cleanup");});
  })).rejects.toBeInstanceOf(AggregateError);
  expect(() => saved("process", () => {})).toThrow("closed");
});

test("parallel workflow failure drains siblings before resource cleanup", async () => {
  const {workflow, run} = await import("../src/workflow.ts");
  const events: string[] = [];
  const wf = workflow({start: "t/start", wireFn: step => {
    if (step === "t/start") return [o => o, "t/fail", "t/slow"];
    if (step === "t/fail") return [o => ({...o, "red/exit": 1})];
    return [async o => {await Bun.sleep(20); events.push("child"); return o;}];
  }});
  await withScope(async register => {
    register("resource", () => events.push("agent"));
    await run(wf, {});
  });
  expect(events).toEqual(["child", "agent"]);
});

test("Ansible excludes secret bindings and retains the scoped agent", async () => {
  const {ansibleStep} = await import("../src/ansible.ts");
  const {runtime} = await import("../src/runtime.ts");
  const original = runtime.exec;
  let seen: Record<string, string | undefined> | undefined;
  runtime.exec = async (_cmd, opts) => {seen = opts?.env; return {exit: 0, out: "", err: ""};};
  try {
    await ansibleStep({}, {dir: ".", env: {COLORS_PAR_SECRET: "hidden", CUSTOM_SECRET: "hidden", SSH_AUTH_SOCK: "/scope/socket"}, secretEnv: ["CUSTOM_SECRET"]});
    expect(seen?.COLORS_PAR_SECRET).toBeUndefined();
    expect(seen?.CUSTOM_SECRET).toBeUndefined();
    expect(seen?.SSH_AUTH_SOCK).toBe("/scope/socket");
  } finally {runtime.exec = original;}
});
