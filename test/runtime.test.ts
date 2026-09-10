import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtime } from "../src/runtime.ts";
import { contentSpec } from "../src/scaffold.ts";
import { tofuWithSpec } from "../src/tofu.ts";
import { failed } from "../src/workflow.ts";

for (const code of [0, 7]) {
  test(`normal process exit ${code} is preserved`, async () => {
    const result = await runtime.exec([process.execPath, "-e", `process.exit(${code})`]);
    expect(result.exit).toBe(code);
  });
}

test("signal is a positive workflow failure", async () => {
  const result = await runtime.exec([
    process.execPath, "-e", 'process.kill(process.pid, "SIGTERM")',
  ]);
  expect(result.exit).toBe(143);
  expect(failed({ "red/exit": result.exit })).toBe(true);
});

test("real timeout reports positive failure", async () => {
  const result = await runtime.exec([
    process.execPath, "-e", "await Bun.sleep(60000)",
  ], { timeoutMs: 100 });
  expect(result.exit).toBe(124);
  expect(failed({ "red/exit": result.exit })).toBe(true);
  expect(result.err).toContain("command timed out after 100ms");
});

for (const mode of ["signal", "timeout"]) {
  test(`${mode} during destroy retains scaffolded files`, async () => {
    const root = mkdtempSync(join(tmpdir(), "red-runtime-"));
    const bin = join(root, "bin");
    mkdirSync(bin);
    const binary = join(bin, "tofu");
    writeFileSync(binary, `#!${process.execPath}\n`
      + `if (process.argv[2] === "destroy") { ${mode === "signal"
        ? 'process.kill(process.pid, "SIGTERM")'
        : "await Bun.sleep(60000)"}; }\n`
      + 'else if (process.argv[2] !== "init") process.exit(3);\n');
    chmodSync(binary, 0o755);
    const original = runtime.exec;
    // Exercise real child execution, only inject a bounded destroy timeout.
    runtime.exec = (cmd, opts) => original(cmd, {
      ...opts,
      env: { ...opts?.env, PATH: `${bin}:${process.env.PATH}` },
      timeoutMs: mode === "timeout" && cmd[1] === "destroy" ? 100 : undefined,
    });
    const target = join(root, "deployment", "main.tf");
    try {
      const result = await tofuWithSpec(
        { "red/event": "delete" },
        [contentSpec(target, "# resource configuration\n")],
        { dir: join(root, "deployment") },
      );
      expect(result["red/exit"]).toBe(mode === "timeout" ? 124 : 143);
      expect(failed(result)).toBe(true);
      expect(result["red/err"]).toContain("destroy failed");
      expect(readFileSync(target, "utf8")).toBe("# resource configuration\n");
    } finally {
      runtime.exec = original;
      rmSync(root, { recursive: true, force: true });
    }
  });
}
