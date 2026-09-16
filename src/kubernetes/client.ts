/** Explicit-context kubectl transport. Credentials stay in kubectl's files. */
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtime, type ExecResult } from "../runtime.ts";
import type { Client, Descriptor, Resource } from "../kubernetes.ts";
export interface ClientOptions {
  context?: string;
  inCluster?: boolean;
  kubeconfig?: string;
  kubectl?: string;
  requestTimeoutSeconds?: number;
  timeoutMs?: number;
  serviceHost?: string;
  servicePort?: string;
  runner?: (
    argv: string[],
    env: Record<string, string>,
    timeoutMs: number,
  ) => ExecResult | Promise<ExecResult>;
}
export async function request(
  config: ClientOptions,
  args: string[],
  options: { input?: string; raw?: boolean; timeoutMs?: number } = {},
): Promise<any> {
  const dir = await mkdtemp(join(tmpdir(), "red-kubernetes-"));
  try {
    let cfg = { ...config };
    args = [...args];
    if (options.input !== undefined) {
      const i = args.findIndex(
        (v, i) =>
          v === "-" && i > 0 && ["-f", "--filename"].includes(args[i - 1]!),
      );
      if (i < 0) throw new Error("request input requires -f -");
      const file = join(dir, "input.json");
      await writeFile(file, options.input, { mode: 0o600 });
      args[i] = file;
    }
    if (cfg.inCluster) {
      const host = cfg.serviceHost ?? process.env.KUBERNETES_SERVICE_HOST,
        port = cfg.servicePort ?? process.env.KUBERNETES_SERVICE_PORT ?? "443";
      if (!host?.trim())
        throw new Error("In-cluster Kubernetes service address is unavailable");
      const base = "/var/run/secrets/kubernetes.io/serviceaccount",
        file = join(dir, "config.json");
      const data = {
        apiVersion: "v1",
        kind: "Config",
        clusters: [
          {
            name: "in-cluster",
            cluster: {
              server: `https://${host.includes(":") ? `[${host}]` : host}:${port}`,
              "certificate-authority": `${base}/ca.crt`,
            },
          },
        ],
        users: [
          { name: "service-account", user: { tokenFile: `${base}/token` } },
        ],
        contexts: [
          {
            name: "red-in-cluster",
            context: { cluster: "in-cluster", user: "service-account" },
          },
        ],
        "current-context": "red-in-cluster",
      };
      await writeFile(file, JSON.stringify(data), { mode: 0o600 });
      cfg = { ...cfg, kubeconfig: file, context: "red-in-cluster" };
    }
    const argv = [
      cfg.kubectl ?? "kubectl",
      ...(cfg.kubeconfig ? ["--kubeconfig", cfg.kubeconfig] : []),
      ...(cfg.context ? ["--context", cfg.context] : []),
      `--request-timeout=${cfg.requestTimeoutSeconds ?? 30}s`,
      ...args,
    ];
    const timeout = options.timeoutMs ?? cfg.timeoutMs ?? 45000;
    const result = cfg.runner
      ? await cfg.runner(argv, {}, timeout)
      : await runtime.exec(argv, { timeoutMs: timeout });
    if (result.exit !== 0)
      throw Object.assign(new Error("Kubernetes request failed"), {
        exit: result.exit,
        operation: args[0],
      });
    if (options.raw) return result.out;
    if (!result.out.trim()) return null;
    try {
      return JSON.parse(result.out);
    } catch {
      throw new Error("Invalid Kubernetes JSON response");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
export function kubectlClient(config: ClientOptions): Client & ClientOptions {
  if (
    !(typeof config.context === "string" && config.context.trim()) &&
    config.inCluster !== true
  )
    throw new Error(
      "An explicit Kubernetes context or inCluster true is required",
    );
  const type = (d: Descriptor) => `${d.plural}.${d.group}`;
  return {
    ...config,
    listResources: async (d, ns) =>
      (await request(config, ["get", type(d), "-n", ns, "-o", "json"])).items,
    getResource: (d, ns, name) =>
      request(config, [
        "get",
        type(d),
        name,
        "-n",
        ns,
        "--ignore-not-found",
        "-o",
        "json",
      ]),
    updateStatus: (d, r, status) =>
      request(
        config,
        [
          "replace",
          "--raw",
          `/apis/${d.group}/${d.version}/namespaces/${r.metadata.namespace}/${d.plural}/${r.metadata.name}/status`,
          "-f",
          "-",
        ],
        {
          input: JSON.stringify({
            apiVersion: r.apiVersion,
            kind: r.kind,
            metadata: Object.fromEntries(
              ["name", "namespace", "uid", "resourceVersion"]
                .filter((k) => k in r.metadata)
                .map((k) => [k, r.metadata[k]]),
            ),
            status,
          }),
        },
      ),
    updateFinalizers: (d, r, finalizers) =>
      request(config, [
        "patch",
        type(d),
        r.metadata.name,
        "-n",
        r.metadata.namespace,
        "--type=merge",
        "-p",
        JSON.stringify({
          metadata: { resourceVersion: r.metadata.resourceVersion, finalizers },
        }),
        "-o",
        "json",
      ]),
  };
}
