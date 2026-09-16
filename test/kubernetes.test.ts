import { test, expect } from "bun:test";
import * as k from "../src/kubernetes.ts";
import { kubectlClient, request } from "../src/kubernetes/client.ts";
import { readFileSync, existsSync, statSync } from "node:fs";
const descriptor = {
  group: "colors.test",
  version: "v1",
  plural: "examples",
  kind: "Example",
};
function fixture() {
  let r: k.Resource = {
    apiVersion: "colors.test/v1",
    kind: "Example",
    metadata: {
      name: "demo",
      namespace: "dev",
      uid: "demo",
      generation: 1,
      resourceVersion: "1",
    },
    spec: {
      state: "running",
      reconcileInterval: "1s",
      config: { profile: "demo" },
    },
  };
  let now = 100000,
    actual: any = null;
  const effects: string[] = [];
  const update = (snap: k.Resource, patch: any) => {
    if (snap.metadata.resourceVersion !== r.metadata.resourceVersion)
      throw Object.assign(Error("SECRET"), { status: 409 });
    r = {
      ...r,
      ...patch,
      metadata: {
        ...(patch.metadata ?? r.metadata),
        resourceVersion: String(Number(r.metadata.resourceVersion) + 1),
      },
    };
    return r;
  };
  const client: k.Client = {
    listResources: () => [r],
    getResource: () => r,
    updateStatus: (_, s, status) => update(s, { status }),
    updateFinalizers: (_, s, finalizers) =>
      update(s, { metadata: { ...s.metadata, finalizers } }),
  };
  const p: k.Package = {
    resource: descriptor,
    identity: (o) => ["backend", o.profile],
    validate: (o) => (o.invalid ? ["SECRET"] : []),
    observe: (o) => ({
      exists: actual !== null,
      matches: actual === o["red/event"],
      ready: true,
    }),
    converge: (o) => {
      effects.push(String(o["red/event"]));
      actual = o["red/event"];
      return {};
    },
    delete: () => {
      effects.push("delete");
      actual = null;
      return {};
    },
  };
  const cfg = k.controller({
    packages: [p],
    client,
    now: () => now,
    pollMs: 2,
  });
  return {
    p,
    cfg,
    effects,
    get r() {
      return r;
    },
    tick: () => (now += 1001),
    drift: () => (actual = null),
    edit: (fn: (r: k.Resource) => void) => {
      r = structuredClone(r);
      fn(r);
      r.metadata.generation++;
      r.metadata.resourceVersion = String(
        Number(r.metadata.resourceVersion) + 1,
      );
    },
    run: () => k.reconcile(cfg, p, "dev", "demo"),
  };
}
test("status records the identity used to acquire the lock", async () => {
  const f = fixture();
  let reads = 0;
  f.p.identity = () =>
    ++reads === 1
      ? { backend: "s3", profile: "demo" }
      : { profile: "demo", backend: "s3" };
  await f.run();
  expect(f.r.status?.phase).toBe("Ready");
  expect(f.r.status?.stateIdentity).toBe(
    "b31cd38f9fcf4d1acda385fd2fbef1167dc22a1d8945ac71aa45a974aae6b144",
  );
});
test("convergence, drift, stopped state, suspension, requests", async () => {
  const f = fixture();
  await f.run();
  expect(f.r.status?.phase).toBe("Ready");
  expect(f.r.status?.stateIdentity).toBe(
    "dedb8c5ac00ab11f7a5322e9b72801c297052fb02724949dad6c19fbc28fd4ac",
  );
  await f.run();
  expect(f.effects.length).toBe(1);
  f.drift();
  f.tick();
  await f.run();
  expect(f.effects.length).toBe(2);
  f.edit((r) => (r.spec!.state = "stopped"));
  await f.run();
  expect(f.effects.at(-1)).toBe("stop");
  f.edit((r) => (r.spec!.suspend = true));
  await f.run();
  f.tick();
  f.drift();
  await f.run();
  expect(f.r.status?.phase).toBe("Suspended");
  expect(f.effects.length).toBe(3);
  f.edit((r) => (r.spec!.suspend = false));
  await f.run();
  f.drift();
  f.r.metadata.annotations = { [k.requestAnnotation]: "now" };
  await f.run();
  expect(f.effects.length).toBe(5);
});
test("validation, immutable identity, sanitized backoff reset", async () => {
  const f = fixture();
  f.edit((r) => (r.spec!.config.invalid = true));
  await f.run();
  expect(f.r.status?.phase).toBe("Invalid");
  expect(JSON.stringify(f.r.status)).not.toContain("SECRET");
  f.tick();
  await f.run();
  expect(f.effects).toEqual([]);
  f.edit((r) => delete r.spec!.config.invalid);
  await f.run();
  const identity = f.r.status?.stateIdentity;
  f.edit((r) => (r.spec!.config.profile = "other"));
  await f.run();
  expect(f.r.status?.profile).toBe("demo");
  expect(f.r.status?.stateIdentity).toBe(identity);
  const g = fixture();
  g.p.validate = () => {
    throw Error("SECRET");
  };
  await g.run();
  expect(g.r.status?.retryCount).toBe(1);
  g.tick();
  await g.run();
  expect(g.r.status?.retryCount).toBe(2);
  g.edit((r) => (r.spec!.config.value = 1));
  await g.run();
  expect(g.r.status?.retryCount).toBe(1);
  expect(JSON.stringify(g.r.status)).not.toContain("SECRET");
});
test("matching but unready state never reapplies", async () => {
  const f = fixture();
  f.p.observe = () => ({ exists: true, matches: true, ready: false });
  await f.run();
  f.tick();
  await f.run();
  expect(f.r.status?.retryCount).toBe(2);
  expect(f.effects).toEqual([]);
});
test("Destroy protection, incomplete deletion and Retain", async () => {
  const f = fixture();
  await f.run();
  f.edit((r) => {
    r.metadata.deletionTimestamp = "now";
    r.spec!.deletionPolicy = "Destroy";
    r.spec!.suspend = true;
    r.spec!.config["compute-prevent-destroy"] = true;
  });
  await f.run();
  expect(f.r.status?.phase).toBe("Blocked");
  f.edit((r) => (r.spec!.config["compute-prevent-destroy"] = false));
  const del = f.p.delete;
  f.p.delete = () => ({});
  await f.run();
  expect(f.r.status?.phase).toBe("Failed");
  expect(f.r.metadata.finalizers).toContain(k.finalizer);
  f.p.delete = del;
  f.tick();
  await f.run();
  expect(f.r.metadata.finalizers).toEqual([]);
  const g = fixture();
  await g.run();
  g.edit((r) => {
    r.metadata.deletionTimestamp = "now";
    r.metadata.finalizers.push("other");
    r.spec!.config.invalid = true;
  });
  await g.run();
  expect(g.r.metadata.finalizers).toEqual(["other"]);
  expect(g.effects).toEqual(["create"]);
});
test("conflicts block effects and stale completion", async () => {
  for (const method of ["updateStatus", "updateFinalizers"] as const) {
    const f = fixture(),
      original = f.cfg.client[method];
    f.cfg.client[method] = () => {
      throw Object.assign(Error("conflict"), { status: 409 });
    };
    await expect(f.run()).rejects.toThrow();
    expect(f.effects).toEqual([]);
    f.cfg.client[method] = original;
    await f.run();
    expect(f.r.status?.phase).toBe("Ready");
  }
  const f = fixture(),
    original = f.p.converge;
  f.p.converge = (o) => {
    f.edit((r) => (r.spec!.config.value = 1));
    return original(o);
  };
  await f.run();
  expect(f.r.status?.observedGeneration).toBe(1);
  expect(f.r.metadata.generation).toBe(2);
  expect(f.r.status?.phase).toBe("Reconciling");
});
test("locks span controllers and shutdown drains callbacks", async () => {
  const f = fixture();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    entry = new Promise<void>((r) => (entered = r)),
    original = f.p.converge;
  f.p.converge = async (o) => {
    entered();
    await gate;
    return original(o);
  };
  const rt = k.start(f.cfg);
  await entry;
  expect(await f.run()).toBe("busy");
  let stopped = false;
  const done = k.stop(rt).then(() => (stopped = true));
  await Bun.sleep(10);
  expect(stopped).toBe(false);
  release();
  await done;
  expect(f.effects).toEqual(["create"]);
});
test("transport contexts, private files, optimistic versions, cleanup", async () => {
  expect(() => kubectlClient({})).toThrow();
  let path = "";
  const calls: string[][] = [];
  const client = kubectlClient({
    context: "test",
    runner: (argv, _, timeout) => {
      calls.push(argv);
      expect(timeout).toBe(45000);
      const i = argv.indexOf("-f");
      if (i >= 0) {
        path = argv[i + 1]!;
        expect(statSync(path).mode & 0o777).toBe(0o600);
        expect(
          JSON.parse(readFileSync(path, "utf8")).metadata.resourceVersion,
        ).toBe("1");
      }
      return { exit: 0, out: '{"items":[]}', err: "" };
    },
  });
  await client.listResources(descriptor, "dev");
  await client.updateStatus(descriptor, fixture().r, { phase: "Ready" });
  expect(existsSync(path)).toBe(false);
  await client.updateFinalizers(descriptor, fixture().r, []);
  expect(calls.at(-1)).toContain(
    '{"metadata":{"resourceVersion":"1","finalizers":[]}}',
  );
  await expect(
    request({ runner: () => ({ exit: 1, out: "SECRET", err: "SECRET" }) }, [
      "get",
    ]),
  ).rejects.toThrow("Kubernetes request failed");
});
test("in-cluster token rotation and IPv6", async () => {
  await request(
    {
      inCluster: true,
      serviceHost: "::1",
      runner: (argv) => {
        const cfg = JSON.parse(
          readFileSync(argv[argv.indexOf("--kubeconfig") + 1]!, "utf8"),
        );
        expect(cfg.clusters[0].cluster.server).toBe("https://[::1]:443");
        expect(cfg.users[0].user.tokenFile).toEndWith("/token");
        return { exit: 0, out: "", err: "" };
      },
    },
    ["get"],
  );
});

test("worker bound, coalescing, queued shutdown and polling isolation", async () => {
  const f = fixture();
  const resources = ["a", "b", "c", "d"].map((name) => ({
    ...structuredClone(f.r),
    metadata: { ...f.r.metadata, name, uid: name },
    spec: { ...f.r.spec, config: { profile: name } },
  }));
  const objects = new Map(resources.map((r) => [r.metadata.name, r]));
  const update = (r: any, patch: any) => {
    const next = { ...r, ...patch };
    objects.set(r.metadata.name, next);
    return next;
  };
  f.cfg.client = {
    listResources: (d) => {
      if (d.kind === "Broken") throw Error("SECRET");
      return [...objects.values()];
    },
    getResource: (_, __, name) => objects.get(name),
    updateStatus: (_, r, status) => update(r, { status }),
    updateFinalizers: (_, r, finalizers) =>
      update(r, { metadata: { ...r.metadata, finalizers } }),
  };
  let active = 0,
    peak = 0,
    completed = 0,
    release!: () => void,
    entered!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    entry = new Promise<void>((r) => (entered = r));
  const done = new Set();
  f.p.observe = (o) => ({
    exists: done.has(o.profile),
    matches: done.has(o.profile),
    ready: true,
  });
  f.p.converge = async (o) => {
    active++;
    peak = Math.max(peak, active);
    if (active === 2) entered();
    await gate;
    done.add(o.profile);
    active--;
    completed++;
    return {};
  };
  f.cfg.packages = [
    { ...f.p, resource: { ...descriptor, kind: "Broken" } },
    f.p,
  ];
  const rt = k.start(f.cfg);
  await entry;
  await Bun.sleep(10);
  expect(peak).toBe(2);
  expect(rt.errors).toBeGreaterThan(0);
  const stopping = k.stop(rt);
  release();
  await stopping;
  expect(completed).toBe(2);
});

test("invalid controller and interval reject work", async () => {
  const f = fixture();
  expect(() => k.controller({ ...f.cfg, workers: 0 })).toThrow();
  for (const value of ["0s", "-1s", "1.5s", "5d", 22]) {
    f.edit((r) => (r.spec!.reconcileInterval = value));
    await f.run();
    expect(f.r.status?.phase).toBe("Invalid");
  }
  expect(f.effects).toEqual([]);
});
