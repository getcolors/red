import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findUp } from "../src/cli.ts";
import { preflight } from "../src/lifecycle.ts";

test("package conventions are reusable", async () => {
  const root = mkdtempSync(join(tmpdir(), "red-conventions-"));
  writeFileSync(join(root, "colors.yml"), "x: 1\n");
  expect(findUp("colors.yml", join(root, "deep"))).toBe(join(root, "colors.yml"));
  expect(await preflight({ "red/event": "build" }, { defaults: { x: 1 } }, {})).toEqual({ "red/event": "build", x: 1, "red/exit": 0 });
});

test("preflight reports every validation error with exit 2", async () => {
  const res = await preflight({ "red/event": "create" }, {
    validators: [() => ["a is required"], (_o, _e, ctx) => ctx.real ? ["b is required"] : []],
  }, {});
  expect(res["red/exit"]).toBe(2);
  expect(res["red/err"]).toBe("a is required\nb is required");
});

test("package.json exports only the core modules", async () => {
  const pkg = await Bun.file(join(import.meta.dir, "..", "package.json")).json();
  expect(Object.keys(pkg.exports).sort()).toEqual([
    ".", "./advice", "./cli", "./dry-run", "./lifecycle", "./progress", "./runtime", "./workflow",
  ]);
  expect(pkg.dependencies ?? {}).toEqual({});
});
