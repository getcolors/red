// Drives examples/hello through its real ./red launcher, as a user would.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const launcher = join(import.meta.dir, "..", "examples", "hello", "red");

// A clean environment: no stray COLORS_PAR_* from the caller's shell.
const baseEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith("COLORS_PAR_")),
);

async function red(args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn([process.execPath, launcher, ...args], {
    env: { ...baseEnv, ...env }, stdout: "pipe", stderr: "pipe", stdin: "ignore",
  });
  const [out, err, exit] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  return { out, err, exit };
}

function project(yml: string) {
  const root = mkdtempSync(join(tmpdir(), "red-hello-"));
  const file = join(root, "red.yml");
  writeFileSync(file, yml);
  return { root, file, work: join(root, "work") };
}

test.skipIf(process.platform === "win32")("create writes and reads back one file per name; delete removes them", async () => {
  const p = project("workdir: work\nmessage: hello\nnames: [alice, bob, carol]\n");
  try {
    const created = await red(["create", "-f", p.file]);
    expect(created.exit).toBe(0);
    const host = (await Bun.$`uname -sm`.text()).trim();
    for (const name of ["alice", "bob", "carol"]) {
      expect(readFileSync(join(p.work, `${name}.txt`), "utf8")).toBe(`hello, ${name}, from ${host}\n`);
      expect(created.out).toContain(`hello, ${name}, from ${host}`);
    }
    // the fan-out joined: hello/report ran exactly once
    expect(created.out.match(/>>> hello\/report/g)).toHaveLength(1);
    expect(created.out.match(/>>> hello\/greet/g)).toHaveLength(3);

    const deleted = await red(["delete", "-f", p.file]);
    expect(deleted.exit).toBe(0);
    expect(existsSync(p.work)).toBe(false);
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")("COLORS_PAR_* overrides desired state", async () => {
  const p = project("workdir: work\nmessage: hello\nnames: [alice]\n");
  try {
    expect((await red(["create", "-f", p.file], { COLORS_PAR_MESSAGE: "hi" })).exit).toBe(0);
    expect(readFileSync(join(p.work, "alice.txt"), "utf8")).toStartWith("hi, alice, from ");
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")("--dry-run touches nothing", async () => {
  const p = project("workdir: work\nnames: [alice, bob]\n");
  try {
    const res = await red(["create", "-f", p.file, "--dry-run"]);
    expect(res.exit).toBe(0);
    expect(res.out).toContain("dry-run: would run hello/greet (create)");
    expect(res.out).toContain("dry-run: would run hello/report (create)");
    expect(existsSync(p.work)).toBe(false);
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("the shipped red.yml passes a dry run", async () => {
  const res = await red(["create", "-f", join(import.meta.dir, "..", "examples", "hello", "red.yml"), "--dry-run"]);
  expect(res.exit).toBe(0);
});

test("invalid desired state and unknown events exit 2", async () => {
  const p = project("names: []\n");
  try {
    const invalid = await red(["create", "-f", p.file]);
    expect(invalid.exit).toBe(2);
    expect(invalid.err).toContain("names: list at least one name");
    const unknown = await red(["upgrade", "-f", p.file]);
    expect(unknown.exit).toBe(2);
    expect(unknown.err).toContain("Usage");
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")("a failing command becomes the step's exit code and error", async () => {
  const p = project("workdir: blocker/work\nnames: [alice]\n");
  try {
    writeFileSync(join(p.root, "blocker"), "a file, not a directory\n");
    const res = await red(["create", "-f", p.file]);
    expect(res.exit).toBe(1);
    expect(res.err).toContain("mkdir -p");
    expect(res.out).not.toContain(">>> hello/report");
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});
