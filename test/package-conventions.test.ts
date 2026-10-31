import { expect, test } from "bun:test";
import { join } from "node:path";

test("package.json exports only the core modules", async () => {
  const pkg = await Bun.file(join(import.meta.dir, "..", "package.json")).json();
  expect(Object.keys(pkg.exports).sort()).toEqual([
    ".", "./advice", "./cli", "./workflow",
  ]);
  expect(pkg.dependencies ?? {}).toEqual({});
});
