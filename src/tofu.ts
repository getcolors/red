// Event-aware OpenTofu steps: any non-"delete" event (conventionally
// "create") -> init + apply, "delete" -> init + destroy. After apply,
// `tofu output -json` is merged into opts under a namespaced key
// ("tofu/outputs" by default). The backend is not hardwired: attach a
// `before` advice built by `backendAdvice`, `localBackendAdvice`,
// `s3BackendAdvice`, or `gcsBackendAdvice` to write backend.tf before the
// tofu command runs.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runtime, type ExecResult } from "./runtime.ts";
import type { Opts } from "./workflow.ts";
import { StepError } from "./workflow.ts";

const initArgs = ["init", "-input=false", "-no-color"];
const applyArgs = ["apply", "-auto-approve", "-input=false", "-no-color"];
const destroyArgs = ["destroy", "-auto-approve", "-input=false", "-no-color"];

function tofu(dir: string, ...args: string[]): Promise<ExecResult> {
  return runtime.exec(["tofu", ...args], { cwd: dir });
}

function fail(opts: Opts, res: ExecResult, cmd: string): Opts {
  return {
    ...opts,
    "red/exit": res.exit,
    "red/err": `tofu ${cmd} failed: ${res.err || res.out || "(no output)"}`,
  };
}

function parseOutputs(out: string): Record<string, unknown> {
  const parsed = JSON.parse(out) as Record<string, { value: unknown }>;
  return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, v.value]));
}

// Parse `tofu output -json` in `dir` into a plain map of name -> value.
export async function outputs(dir: string): Promise<Record<string, unknown>> {
  const res = await tofu(dir, "output", "-json");
  if (res.exit > 0) {
    throw new StepError(`tofu output failed: ${res.err}`);
  }
  return parseOutputs(res.out);
}

// Run OpenTofu in `dir` according to "red/event". On success, apply merges
// the outputs under `outputKey` (default "tofu/outputs") — never top-level.
export async function tofuStep(
  opts: Opts,
  config: { dir: string; outputKey?: string },
): Promise<Opts> {
  const { dir, outputKey = "tofu/outputs" } = config;
  const isDelete = opts["red/event"] === "delete";
  const init = await tofu(dir, ...initArgs);
  if (init.exit > 0) return fail(opts, init, "init");
  const cmd = isDelete ? destroyArgs : applyArgs;
  const res = await tofu(dir, ...cmd);
  if (res.exit > 0) return fail(opts, res, cmd[0]!);
  if (isDelete) return { ...opts, "red/exit": 0 };
  return { ...opts, "red/exit": 0, [outputKey]: await outputs(dir) };
}

function hclValue(v: unknown): string {
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  return JSON.stringify(String(v));
}

function backendHcl(type: string, config: Record<string, unknown>): string {
  const attrs = Object.entries(config)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `    ${k} = ${hclValue(v)}\n`)
    .join("");
  return `terraform {\n  backend "${type}" {\n${attrs}  }\n}\n`;
}

type BackendConfig = Record<string, unknown> | ((opts: Opts) => Record<string, unknown>);

function resolveConfig(config: BackendConfig, opts: Opts): Record<string, unknown> {
  return typeof config === "function" ? config(opts) : config;
}

// Build a `before` advice that writes a backend config into the directory
// returned by dirFn(opts) before the step runs. `type` is the backend name
// ("local", "s3", "gcs", …); `config` is a flat map of backend attributes,
// or a function of opts returning one.
export function backendAdvice(dirFn: (opts: Opts) => string, type: string, config: BackendConfig) {
  return (opts: Opts): Opts => {
    const dir = dirFn(opts);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "backend.tf"), backendHcl(type, resolveConfig(config, opts)));
    return opts;
  };
}

// Backend advice for the local filesystem backend.
export function localBackendAdvice(dirFn: (opts: Opts) => string, config: BackendConfig = {}) {
  return backendAdvice(dirFn, "local", config);
}

// Backend advice for the S3 backend, e.g.
// {bucket: "my-state", key: "red/node-1.tfstate", region: "eu-west-1"}.
export function s3BackendAdvice(dirFn: (opts: Opts) => string, config: BackendConfig) {
  return backendAdvice(dirFn, "s3", config);
}

// Backend advice for the GCS backend, e.g.
// {bucket: "my-state", prefix: "red/node-1"}.
export function gcsBackendAdvice(dirFn: (opts: Opts) => string, config: BackendConfig) {
  return backendAdvice(dirFn, "gcs", config);
}
