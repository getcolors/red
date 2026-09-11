import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

for (const parentExits of [false, true]) {
  test.skipIf(process.platform === "win32")(`timeout kills descendants when parent ${parentExits ? "exits" : "waits"}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "red-runtime-tree-"));
    const marker = join(root, "survived");
    const pidFile = join(root, "child.pid");
    const child = `
      await Bun.write(${JSON.stringify(pidFile)}, String(process.pid));
      console.log("child started");
      console.error("child stderr");
      await Bun.sleep(1000);
      await Bun.write(${JSON.stringify(marker)}, "survived");
      await Bun.sleep(10000);
    `;
    try {
      const start = performance.now();
      const result = await runtime.exec([process.execPath, "-e", `
        Bun.spawn([process.execPath, "-e", ${JSON.stringify(child)}], {
          stdin: "ignore", stdout: "inherit", stderr: "inherit",
        });
        ${parentExits ? "process.exit(0)" : "await Bun.sleep(10000)"};
      `], { timeoutMs: 300 });
      expect(performance.now() - start).toBeLessThan(900);
      expect(result.exit).toBe(124);
      expect(result.out).toContain("child started");
      expect(result.err).toContain("child stderr");
      expect(result.err).toContain("command timed out after 300ms");
      await Bun.sleep(1100);
      expect(existsSync(marker)).toBe(false);
    } finally {
      if (existsSync(pidFile)) {
        try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL"); } catch {}
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test.skipIf(process.platform === "win32")("timeout bounds pipe cleanup when a descendant leaves the process group", async () => {
  const root = mkdtempSync(join(tmpdir(), "red-runtime-escaped-"));
  const pidFile = join(root, "child.pid");
  try {
    const start = performance.now();
    const result = await runtime.exec([process.execPath, "-e", `
      const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(10000)"], {
        detached: true, stdin: "ignore", stdout: "inherit", stderr: "inherit",
      });
      await Bun.write(${JSON.stringify(pidFile)}, String(child.pid));
      console.log("parent output");
      await Bun.sleep(10000);
    `], { timeoutMs: 300 });
    expect(performance.now() - start).toBeLessThan(2000);
    expect(result.exit).toBe(124);
    expect(result.out).toContain("parent output");
    expect(result.err).toContain("command timed out after 300ms");
  } finally {
    if (existsSync(pidFile)) {
      try { process.kill(-Number(readFileSync(pidFile, "utf8")), "SIGKILL"); } catch {}
    }
    rmSync(root, { recursive: true, force: true });
  }
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
