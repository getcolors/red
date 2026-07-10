// Opt-in real floci end-to-end test. This is intentionally skipped by default
// because it needs Linux Docker bridge networking, a running floci container,
// tofu, AWS CLI, Ansible, and outbound network from instance containers.
import { describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Opts } from "../src/workflow.ts";

const enabled = process.env.RED_FLOCI_E2E === "1";
const exampleDir = join(import.meta.dir, "..", "examples", "floci-zookeeper");
const workDir = join(exampleDir, "work");
const redUrl = pathToFileURL(join(exampleDir, "red")).href;

async function runFloci(...args: string[]): Promise<Opts> {
  const mod = (await import(redUrl)) as { run: (...args: string[]) => Promise<Opts> };
  return mod.run(...args);
}

async function checked(label: string, ...args: string[]) {
  const res = await runFloci(...args);
  expect(res["red/err"], `${label} err`).toBeUndefined();
  expect(res["red/exit"], `${label} exit`).toBe(0);
  return res;
}

describe.skipIf(!enabled)("floci-zookeeper real e2e", () => {
  test(
    "create is idempotent and delete tears down",
    async () => {
      if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
      try {
        const created = await checked("create", "create");
        expect(created["zk/health"]).toHaveLength(3);

        const again = await checked("second create", "create");
        expect(again["zk/health"]).toHaveLength(3);
      } finally {
        await checked("delete", "delete");
      }
    },
    20 * 60 * 1000,
  );
});
