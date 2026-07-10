// Flagship end-to-end test: a fake ZooKeeper cluster. Real template renders,
// real `tofu apply`/`destroy` — but the HCL contains only locals and outputs,
// so nothing real is created and no credentials are needed.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import mainTf from "../test-resources/zk/main.tf" with { type: "text" };
import zooCfg from "../test-resources/zk/zoo.cfg" with { type: "text" };
import { scaffold } from "../src/scaffold.ts";
import * as tofu from "../src/tofu.ts";
import type { Opts, StepFn } from "../src/workflow.ts";
import { adviceAdd, run, step, workflow } from "../src/workflow.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "red-zk-"));

const nodeDir = (opts: Opts, node: { id: number }) =>
  `${opts["zk/workdir"]}/nodes/${node.id}`;

// --- steps -------------------------------------------------------------------

const startStep: StepFn = (opts) => opts;

// Scaffold one node's main.tf and drive tofu over it. On delete, destroy
// before removing the files tofu still needs.
const nodeStep: StepFn = async (opts) => {
  const node = opts["zk/node"];
  const dir = nodeDir(opts, node);
  const specs = [
    {
      template: { name: "zk/main.tf", content: mainTf },
      target: `${dir}/main.tf`,
      data: { node },
    },
  ];
  if (opts["red/event"] === "delete") {
    const out = await tofu.tofuStep(opts, { dir });
    return (out["red/exit"] ?? 0) > 0 ? out : scaffold(out, specs);
  }
  return tofu.tofuStep(scaffold(opts, specs), { dir });
};

// Join step: render zoo.cfg (listing every member) into each server's
// directory. On create the member list comes from the branches' observed
// tofu outputs; on delete the desired state names the targets to remove.
const zooCfgStep: StepFn = (opts) => {
  const nodes = opts["zk/servers"];
  const servers =
    opts["red/event"] === "delete"
      ? nodes
      : opts["red/branches"]
          .map((b: Opts) => b["tofu/outputs"])
          .sort((a: { id: number }, b: { id: number }) => a.id - b.id);
  const specs = nodes.map((n: { id: number }) => ({
    template: { name: "zk/zoo.cfg", content: zooCfg },
    target: `${opts["zk/workdir"]}/nodes/${n.id}/zoo.cfg`,
    data: { servers },
  }));
  return scaffold(opts, specs);
};

// --- workflow ------------------------------------------------------------------

const wireFn = (s: string) => {
  switch (s) {
    case "zk/start":
      return [startStep, "zk/node"] as const;
    case "zk/node":
      return [nodeStep, "zk/zoo-cfg"] as const;
    case "zk/zoo-cfg":
      return [zooCfgStep] as const;
  }
};

const nextFn = (s: string, defaultNext: string[] | null, opts: Opts) => {
  if ((opts["red/exit"] ?? 0) > 0) return [];
  // fan out: one zk/node branch per server, in parallel
  if (s === "zk/start") {
    return opts["zk/servers"].map(
      (n: unknown) => ["zk/node", { ...opts, "zk/node": n }] as const,
    );
  }
  return (defaultNext ?? []).map((n) => [n, opts] as const);
};

// the backend is not hardwired: the local filesystem backend is injected
// with the advice facility
const clusterWf = adviceAdd(
  workflow({ start: "zk/start", wireFn, nextFn }),
  "zk/node",
  "before",
  "zk/backend",
  tofu.localBackendAdvice((o) => nodeDir(o, o["zk/node"])),
);

const desiredState = {
  "zk/servers": [
    { id: 1, name: "zk1", ip: "10.0.0.1" },
    { id: 2, name: "zk2", ip: "10.0.0.2" },
    { id: 3, name: "zk3", ip: "10.0.0.3" },
  ],
};

// --- composition: two clusters from the same workflow --------------------------
// `step` turns clusterWf into an ordinary step; the parent fans it out once
// per cluster (in parallel), scoping each run with `in`.

const twoClustersWf = workflow({
  start: "clusters/start",
  wireFn: (s) => {
    switch (s) {
      case "clusters/start":
        return [startStep, "clusters/cluster"] as const;
      case "clusters/cluster":
        return [
          step(clusterWf, {
            in: (opts) => {
              const c = opts["zk/cluster"];
              return {
                ...opts,
                "zk/servers": c.servers,
                "zk/workdir": `${opts["zk/workdir"]}/${c.name}`,
              };
            },
          }),
          "clusters/report",
        ] as const;
      case "clusters/report":
        return [
          (opts: Opts) => ({
            ...opts,
            "clusters/reported": new Set(
              opts["red/branches"].map((b: Opts) => b["zk/workdir"]),
            ),
          }),
        ] as const;
    }
  },
  nextFn: (s, defaultNext, opts) => {
    if ((opts["red/exit"] ?? 0) > 0) return [];
    if (s === "clusters/start") {
      return opts["zk/clusters"].map(
        (c: unknown) => ["clusters/cluster", { ...opts, "zk/cluster": c }] as const,
      );
    }
    return (defaultNext ?? []).map((n) => [n, opts] as const);
  },
});

const twoClustersState = {
  "zk/clusters": [
    {
      name: "alpha",
      servers: [
        { id: 1, name: "zk1", ip: "10.0.1.1" },
        { id: 2, name: "zk2", ip: "10.0.1.2" },
      ],
    },
    {
      name: "beta",
      servers: [
        { id: 1, name: "zk1", ip: "10.0.2.1" },
        { id: 2, name: "zk2", ip: "10.0.2.2" },
      ],
    },
  ],
};

describe.skipIf(!Bun.which("tofu"))("zookeeper end-to-end (real tofu)", () => {
  test(
    "fake cluster: create fans out, joins, is idempotent; delete tears down",
    async () => {
      const state = { ...desiredState, "zk/workdir": tmp() };
      const work = state["zk/workdir"];

      // create: fan-out, parallel tofu applies, join renders zoo.cfg
      const created = await run(clusterWf, { ...state, "red/event": "create" });
      expect(created["red/err"]).toBeUndefined();
      expect(created["red/exit"]).toBe(0);
      expect(created["red/branches"]).toHaveLength(3);
      // observed outputs flowed back into each branch
      expect(
        new Set(created["red/branches"].map((b: Opts) => b["tofu/outputs"].name)),
      ).toEqual(new Set(["zk1", "zk2", "zk3"]));
      for (const { id } of state["zk/servers"]) {
        const dir = `${work}/nodes/${id}`;
        expect(existsSync(`${dir}/main.tf`)).toBe(true);
        // advice wrote the backend
        expect(existsSync(`${dir}/backend.tf`)).toBe(true);
        // local backend state
        expect(existsSync(`${dir}/terraform.tfstate`)).toBe(true);
        const cfg = readFileSync(`${dir}/zoo.cfg`, "utf8");
        for (const { id: sid, ip } of state["zk/servers"]) {
          // every zoo.cfg lists every member
          expect(cfg).toContain(`server.${sid}=${ip}:2888:3888`);
        }
      }

      // create is idempotent
      const again = await run(clusterWf, { ...state, "red/event": "create" });
      expect(again["red/exit"]).toBe(0);

      // delete: destroys each node and removes the generated files
      const deleted = await run(clusterWf, { ...state, "red/event": "delete" });
      expect(deleted["red/err"]).toBeUndefined();
      expect(deleted["red/exit"]).toBe(0);
      for (const { id } of state["zk/servers"]) {
        expect(existsSync(`${work}/nodes/${id}/main.tf`)).toBe(false);
        expect(existsSync(`${work}/nodes/${id}/zoo.cfg`)).toBe(false);
      }
    },
    240000,
  );

  test(
    "two clusters from one workflow, composed and isolated",
    async () => {
      const work = tmp();
      const state = { ...twoClustersState, "zk/workdir": work };

      // create: the cluster workflow runs twice, in parallel
      const created = await run(twoClustersWf, { ...state, "red/event": "create" });
      expect(created["red/err"]).toBeUndefined();
      expect(created["red/exit"]).toBe(0);
      expect(created["red/branches"]).toHaveLength(2);
      expect(created["clusters/reported"]).toEqual(
        new Set([`${work}/alpha`, `${work}/beta`]),
      );
      for (const { name, servers } of state["zk/clusters"]) {
        for (const { id } of servers) {
          const dir = `${work}/${name}/nodes/${id}`;
          expect(existsSync(`${dir}/main.tf`)).toBe(true);
          expect(existsSync(`${dir}/terraform.tfstate`)).toBe(true);
          const cfg = readFileSync(`${dir}/zoo.cfg`, "utf8");
          for (const { id: sid, ip } of servers) {
            // zoo.cfg lists this cluster's members
            expect(cfg).toContain(`server.${sid}=${ip}:2888:3888`);
          }
        }
      }
      // clusters stay isolated: alpha's zoo.cfg must not list beta's nodes
      expect(readFileSync(`${work}/alpha/nodes/1/zoo.cfg`, "utf8")).not.toContain("10.0.2.");

      // delete tears down both clusters
      const deleted = await run(twoClustersWf, { ...state, "red/event": "delete" });
      expect(deleted["red/err"]).toBeUndefined();
      expect(deleted["red/exit"]).toBe(0);
      for (const { name, servers } of state["zk/clusters"]) {
        for (const { id } of servers) {
          expect(existsSync(`${work}/${name}/nodes/${id}/main.tf`)).toBe(false);
          expect(existsSync(`${work}/${name}/nodes/${id}/zoo.cfg`)).toBe(false);
        }
      }
    },
    240000,
  );
});
