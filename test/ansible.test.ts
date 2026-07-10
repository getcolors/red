// Playbook selection, recap parsing, inventory rendering, and
// ansibleWithSpec scaffolding need no ansible binary — only `ansibleStep`
// itself shells out, and these tests stub the runtime exec seam.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ansibleCfg from "../test-resources/redtest/ansible.cfg" with { type: "text" };
import createYml from "../test-resources/redtest/create.yml" with { type: "text" };
import {
  ansibleWithSpec,
  inventoryAdvice,
  inventoryIni,
  parseRecap,
  playbook,
} from "../src/ansible.ts";
import { runtime } from "../src/runtime.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "red-ansible-"));

const originalExec = runtime.exec;
afterEach(() => {
  runtime.exec = originalExec;
});

test("playbook follows the event", () => {
  expect(playbook({ "red/event": "create" })).toBe("create.yml");
  // any non-delete event provisions
  expect(playbook({ "red/event": "rotate" })).toBe("create.yml");
  expect(playbook({ "red/event": "delete" })).toBe("delete.yml");
  // partial overrides keep the other default
  expect(playbook({ "red/event": "delete" }, { delete: "teardown.yml" })).toBe("teardown.yml");
  expect(playbook({ "red/event": "create" }, { delete: "teardown.yml" })).toBe("create.yml");
});

test("recap parses per-host counters", () => {
  const out =
    "PLAY RECAP *********************************************\n" +
    "zk1                        : ok=7    changed=4    unreachable=0    failed=0    skipped=1    rescued=0    ignored=0\n" +
    "zk2                        : ok=7    changed=0    unreachable=0    failed=1    skipped=1    rescued=0    ignored=0\n";
  expect(parseRecap(out)).toEqual({
    zk1: { ok: 7, changed: 4, unreachable: 0, failed: 0, skipped: 1, rescued: 0, ignored: 0 },
    zk2: { ok: 7, changed: 0, unreachable: 0, failed: 1, skipped: 1, rescued: 0, ignored: 0 },
  });
  expect(parseRecap("no recap here")).toEqual({});
});

test("inventory-ini renders groups, hosts, and vars", () => {
  expect(
    inventoryIni({
      zookeeper: {
        hosts: [
          { name: "zk2", vars: { zk_id: 2, ansible_host: "10.0.0.2" } },
          { name: "zk1", vars: { ansible_host: "10.0.0.1", zk_id: 1 } },
        ],
        vars: { ansible_user: "root", ansible_python_interpreter: "/usr/bin/python3" },
      },
    }),
  ).toBe(
    "[zookeeper]\n" +
      "zk1 ansible_host=10.0.0.1 zk_id=1\n" +
      "zk2 ansible_host=10.0.0.2 zk_id=2\n" +
      "\n" +
      "[zookeeper:vars]\n" +
      "ansible_python_interpreter=/usr/bin/python3\n" +
      "ansible_user=root\n",
  );
});

test("inventory-ini without group vars", () => {
  expect(inventoryIni({ web: { hosts: [{ name: "w1" }] } })).toBe("[web]\nw1\n");
});

test("inventory advice writes the file", () => {
  const dir = tmp();
  const file = `${dir}/hosts/inventory.ini`;
  const advice = inventoryAdvice(
    () => file,
    (opts) => ({
      zookeeper: {
        hosts: opts.servers.map((s: { name: string; ip: string }) => ({
          name: s.name,
          vars: { ansible_host: s.ip },
        })),
      },
    }),
  );
  const opts = { servers: [{ name: "zk1", ip: "10.0.0.1" }] };
  // before-advice passes opts through
  expect(advice(opts)).toEqual(opts);
  expect(readFileSync(file, "utf8")).toBe("[zookeeper]\nzk1 ansible_host=10.0.0.1\n");
});

const fakeRecap =
  "PLAY RECAP *********************************************\n" +
  "localhost                  : ok=1    changed=0    unreachable=0" +
  "    failed=0    skipped=0    rescued=0    ignored=0\n";

function stubAnsibleExec(): string[][] {
  const calls: string[][] = [];
  runtime.exec = async (cmd, opts) => {
    if (cmd[0] === "ansible-playbook") {
      calls.push(cmd);
      return { exit: 0, out: fakeRecap, err: "" };
    }
    return originalExec(cmd, opts);
  };
  return calls;
}

const specs = (dir: string) => [
  {
    template: { name: "redtest/create.yml", content: createYml },
    target: `${dir}/create.yml`,
    data: { group: "web", name: "test" },
  },
  {
    template: { name: "redtest/ansible.cfg", content: ansibleCfg },
    target: `${dir}/ansible.cfg`,
    data: { inventory: "inventory.ini", host_key_checking: "False" },
  },
];

test("ansible-with-spec scaffolds on create", async () => {
  const dir = tmp();
  stubAnsibleExec();
  const opts = await ansibleWithSpec(
    { "red/event": "create" },
    { dir, inventory: "inventory.ini" },
    specs(dir),
  );
  // scaffolded playbook is rendered
  expect(existsSync(`${dir}/create.yml`)).toBe(true);
  expect(readFileSync(`${dir}/create.yml`, "utf8")).toMatch(/hosts: web/);
  // scaffolded ansible.cfg is rendered
  expect(existsSync(`${dir}/ansible.cfg`)).toBe(true);
  expect(readFileSync(`${dir}/ansible.cfg`, "utf8")).toMatch(/host_key_checking = False/);
  // ansible-step ran and returned recap
  expect(opts["red/exit"]).toBe(0);
  expect(opts["ansible/recap"]).toEqual({
    localhost: { ok: 1, changed: 0, unreachable: 0, failed: 0, skipped: 0, rescued: 0, ignored: 0 },
  });
});

test("ansible-with-spec cleans up on delete", async () => {
  const dir = tmp();
  writeFileSync(`${dir}/create.yml`, "placeholder");
  writeFileSync(`${dir}/ansible.cfg`, "placeholder");
  stubAnsibleExec();
  const opts = await ansibleWithSpec(
    { "red/event": "delete" },
    { dir, inventory: "inventory.ini" },
    specs(dir),
  );
  // ansible-step ran the delete playbook
  expect(opts["red/exit"]).toBe(0);
  // scaffolded files are removed
  expect(existsSync(`${dir}/create.yml`)).toBe(false);
  expect(existsSync(`${dir}/ansible.cfg`)).toBe(false);
});

test("extra vars, user, key, and host-key-checking shape the command", async () => {
  const dir = tmp();
  writeFileSync(`${dir}/create.yml`, "placeholder");
  const calls = stubAnsibleExec();
  let seenEnv: Record<string, string | undefined> | undefined;
  const stub = runtime.exec;
  runtime.exec = async (cmd, opts) => {
    seenEnv = opts?.env;
    return stub(cmd, opts);
  };
  const { ansibleStep } = await import("../src/ansible.ts");
  await ansibleStep(
    { "red/event": "create" },
    {
      dir,
      privateKey: "/keys/id_ed25519",
      user: "root",
      extraVars: { ensemble: [{ id: 1 }] },
      hostKeyChecking: false,
    },
  );
  expect(calls[0]).toEqual([
    "ansible-playbook",
    "-i",
    "inventory.ini",
    "--private-key",
    "/keys/id_ed25519",
    "-u",
    "root",
    "-e",
    '{"ensemble":[{"id":1}]}',
    "create.yml",
  ]);
  expect(seenEnv).toEqual({ ANSIBLE_HOST_KEY_CHECKING: "False" });
});
