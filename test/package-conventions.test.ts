import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findUp, stageDir } from "../src/cli.ts";
import { preflight } from "../src/lifecycle.ts";
import * as providers from "../src/providers.ts";
import { posixQuote, runPlan } from "../src/process.ts";
import * as tofu from "../src/tofu.ts";

test("package conventions are reusable", async () => {
  const root = mkdtempSync(join(tmpdir(), "red-conventions-"));
  writeFileSync(join(root, "colors.yml"), "x: 1\n");
  expect(findUp("colors.yml", join(root, "deep"))).toBe(join(root, "colors.yml"));
  expect(stageDir({ "red/state-file": join(root, "colors.yml"), profile: "demo" }, "tool")).toBe(join(root, ".colors/demo/tool"));
  expect(await preflight({ "red/event": "build" }, { defaults: { x: 1 } }, {})).toEqual({ "red/event": "build", x: 1, "red/exit": 0 });
  expect(providers.toolEnv({ provider: { x: { tofuEnv: { token: "TOKEN" } } } }, { provider: "x", token: "secret" }, ["provider"])).toEqual({ TOKEN: "secret" });
  expect(posixQuote("a'b")).toBe("'a'\\''b'");
  expect((await runPlan([{ label: "ignored", args: [] }], { runner: async () => ({ exit: 1, out: "", err: "gone" }), continueOnError: () => true })).exit).toBe(0);
  expect(typeof tofu.conventionalBackendAdvice({ dir: () => root, key: () => "demo/tool.tfstate" })).toBe("function");
});
