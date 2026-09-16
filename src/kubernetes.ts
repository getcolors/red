/** Polling controllers with process-local state locks and optimistic transport writes.
 * Run one controller process; coordinate external writers separately.
 */
import { createHash } from "node:crypto";
import type { Opts } from "./workflow.ts";
export const finalizer = "colors.getcolors.ai/infrastructure";
export const requestAnnotation = "colors.getcolors.ai/reconcile-request";
type Awaitable<T> = T | Promise<T>;
export interface Descriptor {
  group: string;
  version: string;
  plural: string;
  kind: string;
}
export interface Resource {
  metadata: Record<string, any>;
  spec?: Record<string, any>;
  status?: Record<string, any>;
  [key: string]: any;
}
export interface Package {
  resource: Descriptor;
  validate(opts: Opts): Awaitable<unknown[] | null | undefined>;
  identity(opts: Opts): Awaitable<unknown>;
  observe(
    opts: Opts,
  ): Awaitable<{ exists?: boolean; matches?: boolean; ready?: boolean }>;
  converge(opts: Opts): Awaitable<Opts>;
  delete(opts: Opts): Awaitable<Opts>;
}
export interface Client {
  listResources(resource: Descriptor, namespace: string): Awaitable<Resource[]>;
  getResource(
    resource: Descriptor,
    namespace: string,
    name: string,
  ): Awaitable<Resource | null | undefined>;
  updateStatus(
    resource: Descriptor,
    snapshot: Resource,
    status: Record<string, any>,
  ): Awaitable<Resource>;
  updateFinalizers(
    resource: Descriptor,
    snapshot: Resource,
    finalizers: string[],
  ): Awaitable<Resource>;
}
export interface ControllerOptions {
  packages: Package[];
  client: Client;
  workers?: number;
  pollMs?: number;
  namespace?: string;
  now?: () => number;
  retryBaseMs?: number;
  retryMaxMs?: number;
}
export type Controller = Required<ControllerOptions>;
const held = new Set<string>();
function identityText(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(identityText).join(" ")}]`;
  if (value == null) return "nil";
  if (typeof value === "object")
    return `{${Object.entries(value)
      .map(([k, v]) => `${JSON.stringify(k)} ${identityText(v)}`)
      .join(", ")}}`;
  return JSON.stringify(value);
}
// Structural identities compare by value, independent of object insertion order.
function identityKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(identityKey).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${identityKey(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function controller(options: ControllerOptions): Controller {
  const cfg = {
    workers: 2,
    pollMs: 500,
    namespace: "default",
    now: Date.now,
    retryBaseMs: 1000,
    retryMaxMs: 60000,
    ...options,
  };
  if (
    !Array.isArray(cfg.packages) ||
    !cfg.packages.length ||
    !cfg.client ||
    !["listResources", "getResource", "updateStatus", "updateFinalizers"].every(
      (k) => typeof (cfg.client as any)[k] === "function",
    ) ||
    !cfg.packages.every(
      (p) =>
        p &&
        ["group", "version", "plural", "kind"].every(
          (k) => typeof (p.resource as any)?.[k] === "string",
        ) &&
        ["validate", "identity", "observe", "converge", "delete"].every(
          (k) => typeof (p as any)[k] === "function",
        ),
    ) ||
    ![cfg.workers, cfg.pollMs].every((n) => Number.isInteger(n) && n > 0)
  )
    throw new Error("Invalid Kubernetes controller configuration");
  return cfg;
}
const instant = (ms: number) =>
  new Date(ms).toISOString().replace(/\.000Z$/, "Z");
function interval(r: Resource): number | undefined {
  const value = r.spec?.reconcileInterval ?? "60s";
  const m =
    typeof value === "string" ? /^([1-9][0-9]*)(ms|s|m|h)$/.exec(value) : null;
  if (!m) return;
  const n = Number(m[1]) * { ms: 1, s: 1000, m: 60000, h: 3600000 }[m[2]!]!;
  return Number.isSafeInteger(n) ? n : undefined;
}
const request = (r: Resource) =>
  r.metadata.annotations?.[requestAnnotation] ?? "";
const changed = (r: Resource) =>
  r.status?.observedGeneration !== (r.metadata.generation ?? 1) ||
  r.status?.lastHandledRequest !== request(r);
const retries = (r: Resource) => (changed(r) ? 0 : (r.status?.retryCount ?? 0));
function due(c: Controller, r: Resource): boolean {
  return (
    changed(r) ||
    (!!r.metadata.deletionTimestamp && !r.status?.deletionObserved) ||
    (!["Invalid", "Suspended"].includes(r.status?.phase) &&
      (Date.parse(r.status?.nextReconcileTime) || 0) <= c.now())
  );
}
function options(r: Resource): Opts {
  return {
    ...r.spec?.config,
    profile:
      r.spec?.config?.profile ?? `${r.metadata.namespace}--${r.metadata.name}`,
    "red/event": r.metadata.deletionTimestamp
      ? "delete"
      : r.spec?.state === "stopped"
        ? "stop"
        : "create",
    "red.kubernetes/resource": r,
  };
}
function publish(
  c: Controller,
  p: Package,
  r: Resource,
  o: Opts,
  identity: string,
  phase: string,
  reason: string,
  ready: boolean,
  extra: Record<string, any> = {},
) {
  const now = instant(c.now()),
    generation = r.metadata.generation ?? 1;
  const previous = r.status?.conditions?.find((v: any) => v.type === "Ready");
  const value = ready ? "True" : "False";
  return c.client.updateStatus(p.resource, r, {
    phase,
    profile: o.profile,
    stateIdentity: identity,
    observedGeneration: generation,
    lastHandledRequest: request(r),
    lastReconcileTime: now,
    retryCount: 0,
    deletionObserved: !!r.metadata.deletionTimestamp,
    conditions: [
      {
        type: "Ready",
        status: value,
        reason,
        observedGeneration: generation,
        lastTransitionTime:
          previous?.status === value && previous?.reason === reason
            ? previous.lastTransitionTime
            : now,
      },
    ],
    ...extra,
  });
}
function failure(
  c: Controller,
  p: Package,
  r: Resource,
  o: Opts,
  id: string,
  reason: string,
) {
  const attempt = retries(r) + 1;
  return publish(c, p, r, o, id, "Failed", reason, false, {
    retryCount: attempt,
    nextReconcileTime: instant(
      c.now() +
        Math.min(c.retryMaxMs, c.retryBaseMs * 2 ** Math.min(20, attempt - 1)),
    ),
  });
}
function successful(result: Opts) {
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    (result["red/exit"] ?? 0) !== 0
  )
    throw new Error("Package workflow failed");
}
async function locked(
  c: Controller,
  p: Package,
  r: Resource,
  o: Opts,
  id: string,
) {
  const deleting = !!r.metadata.deletionTimestamp,
    policy = r.spec?.deletionPolicy ?? "Retain";
  const finals: string[] = r.metadata.finalizers ?? [],
    finalized = finals.includes(finalizer),
    old = r.status ?? {};
  const remove = () => finals.filter((f) => f !== finalizer);
  if (deleting && (policy === "Retain" || !finalized)) {
    if (finalized) await c.client.updateFinalizers(p.resource, r, remove());
    return;
  }
  if (
    (old.profile != null && old.profile !== o.profile) ||
    (old.stateIdentity != null && old.stateIdentity !== id)
  ) {
    await publish(
      c,
      p,
      r,
      { ...o, profile: old.profile },
      old.stateIdentity,
      "Invalid",
      "ImmutableStateIdentity",
      false,
    );
    return;
  }
  if (
    !["running", "stopped"].includes(r.spec?.state ?? "running") ||
    !["Retain", "Destroy"].includes(policy) ||
    interval(r) === undefined
  ) {
    await publish(c, p, r, o, id, "Invalid", "InvalidConfiguration", false);
    return;
  }
  let errors: unknown[] | null | undefined = undefined;
  try {
    errors = await p.validate(o);
  } catch {
    await failure(c, p, r, o, id, "ValidationFailed");
    return;
  }
  if (errors?.length) {
    await publish(c, p, r, o, id, "Invalid", "InvalidConfiguration", false);
    return;
  }
  if (deleting && o["compute-prevent-destroy"] === true) {
    await publish(c, p, r, o, id, "Blocked", "DestructionProtected", false, {
      nextReconcileTime: instant(c.now() + interval(r)!),
    });
    return;
  }
  if (!deleting && r.spec?.suspend === true) {
    await publish(c, p, r, o, id, "Suspended", "Suspended", false);
    return;
  }
  if (!deleting && !finalized)
    r = await c.client.updateFinalizers(p.resource, r, [...finals, finalizer]);
  const phase = deleting ? "Deleting" : "Reconciling";
  const active = await publish(c, p, r, o, id, phase, phase, false, {
    retryCount: retries(r),
  });
  try {
    if (deleting) {
      if ((await p.observe(o)).exists === true) successful(await p.delete(o));
      if ((await p.observe(o)).exists !== false)
        throw new Error("Infrastructure remains after deletion");
      await c.client.updateFinalizers(p.resource, active, remove());
    } else {
      if ((await p.observe(o)).matches !== true)
        successful(await p.converge(o));
      const found = await p.observe(o);
      if (found.matches === true && found.ready === true)
        await publish(c, p, active, o, id, "Ready", "Converged", true, {
          nextReconcileTime: instant(c.now() + interval(r)!),
        });
      else await failure(c, p, active, o, id, "NotReady");
    }
  } catch (error) {
    if ((error as any)?.status !== 409)
      await failure(c, p, active, o, id, "ExecutionFailed");
  }
}
export async function reconcile(
  c: Controller,
  p: Package,
  namespace: string,
  name: string,
): Promise<"busy" | undefined> {
  const r = await c.client.getResource(p.resource, namespace, name);
  if (!r || !due(c, r)) return;
  const key = identityKey(await p.identity(options(r)));
  if (held.has(key)) return "busy";
  held.add(key);
  try {
    const latest = await c.client.getResource(p.resource, namespace, name);
    if (
      latest &&
      latest.metadata.uid === r.metadata.uid &&
      key === identityKey(await p.identity(options(latest))) &&
      due(c, latest)
    )
      await locked(
        c,
        p,
        latest,
        options(latest),
        createHash("sha256")
          .update(identityText(await p.identity(options(latest))))
          .digest("hex"),
      );
  } finally {
    held.delete(key);
  }
}
export interface ControllerRuntime {
  config: Controller;
  running: boolean;
  errors: number;
  workers: Promise<void>[];
  poller: Promise<void>;
  wake: () => void;
}
export function start(c: Controller): ControllerRuntime {
  const queue: [string, Package, string, string][] = [],
    pending = new Set<string>(),
    waiters = new Set<() => void>();
  const rt: ControllerRuntime = {
    config: c,
    running: true,
    errors: 0,
    workers: [],
    poller: Promise.resolve(),
    wake: () => {
      for (const wake of [...waiters]) wake();
    },
  };
  const pause = (ms: number) =>
    new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      waiters.add(done);
      if (!rt.running) done();
    });
  rt.workers = Array.from({ length: c.workers }, async () => {
    while (rt.running) {
      const item = queue.shift();
      if (!item) {
        await pause(10);
        continue;
      }
      const [key, p, ns, name] = item;
      try {
        await reconcile(c, p, ns, name);
      } catch {
        rt.errors++;
      } finally {
        pending.delete(key);
      }
    }
  });
  rt.poller = (async () => {
    while (rt.running) {
      for (const p of c.packages) {
        if (!rt.running) break;
        try {
          for (const r of await c.client.listResources(
            p.resource,
            c.namespace,
          )) {
            if (!rt.running) break;
            const ns = r.metadata.namespace ?? c.namespace,
              name = r.metadata.name,
              key = identityKey([p.resource, ns, name]);
            if (!pending.has(key)) {
              pending.add(key);
              queue.push([key, p, ns, name]);
            }
          }
        } catch {
          rt.errors++;
        }
      }
      await pause(c.pollMs);
    }
  })();
  return rt;
}
export async function stop(rt: ControllerRuntime): Promise<void> {
  rt.running = false;
  rt.wake();
  await rt.poller;
  await Promise.all(rt.workers);
}
