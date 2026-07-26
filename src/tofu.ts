// Event-aware OpenTofu steps and deterministic Terraform configuration helpers.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runtime, type ExecResult } from "./runtime.ts";
import { scaffold, type Spec } from "./scaffold.ts";
import type { Opts } from "./workflow.ts";
import { StepError } from "./workflow.ts";

const initArgs = ["init", "-input=false", "-no-color"];
const applyArgs = ["apply", "-auto-approve", "-input=false", "-no-color"];
const destroyArgs = ["destroy", "-auto-approve", "-input=false", "-no-color"];

export interface TofuConfig {
  dir: string;
  outputKey?: string;
  env?: Record<string, string | undefined>;
}

function tofu(dir: string, env: Record<string, string | undefined> | undefined, ...args: string[]) {
  return runtime.exec(["tofu", ...args], { cwd: dir, env });
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

export async function outputs(
  dir: string,
  env?: Record<string, string | undefined>,
): Promise<Record<string, unknown>> {
  const res = await tofu(dir, env, "output", "-json");
  if (res.exit > 0) throw new StepError(`tofu output failed: ${res.err}`);
  return parseOutputs(res.out);
}

export async function tofuStep(opts: Opts, config: TofuConfig): Promise<Opts> {
  const { dir, outputKey = "tofu/outputs", env } = config;
  const isDelete = opts["red/event"] === "delete";
  const init = await tofu(dir, env, ...initArgs);
  if (init.exit > 0) return fail(opts, init, "init");
  const cmd = isDelete ? destroyArgs : applyArgs;
  const res = await tofu(dir, env, ...cmd);
  if (res.exit > 0) return fail(opts, res, cmd[0]!);
  if (isDelete) return { ...opts, "red/exit": 0 };
  return { ...opts, "red/exit": 0, [outputKey]: await outputs(dir, env) };
}

// Render before create/build. Delete must also render before destroy, then
// remove the rendered files only after a successful destroy.
export async function tofuWithSpec(
  opts: Opts,
  specs: Spec[],
  config: TofuConfig,
): Promise<Opts> {
  if (opts["red/event"] === "build") return scaffold(opts, specs);
  if (opts["red/event"] === "delete") {
    const rendered = scaffold({ ...opts, "red/event": "create" }, specs);
    const ran = await tofuStep({ ...rendered, "red/event": "delete" }, config);
    return (ran["red/exit"] ?? 0) > 0 ? ran : scaffold(ran, specs);
  }
  return tofuStep(scaffold(opts, specs), config);
}

function jsonKey(key: unknown): string {
  return String(key);
}

function jsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(jsonValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [jsonKey(key), jsonValue(nested)]),
    );
  }
  return value;
}

// Matches Cheshire's pretty-printer, which is Green's byte-level artifact
// contract: spaces around colons and compact empty collections.
function prettyJson(value: unknown, indent = 0): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return "[ ]";
    return `[ ${value.map((item) => prettyJson(item, indent)).join(", ")} ]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{ }";
    const pad = " ".repeat(indent + 2);
    const close = " ".repeat(indent);
    return `{\n${entries
      .map(([key, nested]) => `${pad}${JSON.stringify(key)} : ${prettyJson(nested, indent + 2)}`)
      .join(",\n")}\n${close}}`;
  }
  return JSON.stringify(value);
}

function backendJson(type: string, config: Record<string, unknown>): string {
  return `${prettyJson(jsonValue({ terraform: { backend: { [type]: config } } }))}\n`;
}

type BackendConfig = Record<string, unknown> | ((opts: Opts) => Record<string, unknown>);

function resolveConfig(config: BackendConfig, opts: Opts): Record<string, unknown> {
  return typeof config === "function" ? config(opts) : config;
}

export function backendAdvice(dirFn: (opts: Opts) => string, type: string, config: BackendConfig) {
  return (opts: Opts): Opts => {
    const dir = dirFn(opts);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "backend.tf.json"), backendJson(type, resolveConfig(config, opts)));
    return opts;
  };
}

export function localBackendAdvice(dirFn: (opts: Opts) => string, config: BackendConfig = {}) {
  return backendAdvice(dirFn, "local", config);
}

export function s3BackendAdvice(dirFn: (opts: Opts) => string, config: BackendConfig) {
  return backendAdvice(dirFn, "s3", config);
}

export function gcsBackendAdvice(dirFn: (opts: Opts) => string, config: BackendConfig) {
  return backendAdvice(dirFn, "gcs", config);
}

export function r2BackendAdvice(dirFn: (opts: Opts) => string, config: BackendConfig) {
  return s3BackendAdvice(dirFn, (opts) => {
    const { bucket, key, endpoint } = resolveConfig(config, opts);
    return {
      bucket,
      key,
      region: "auto",
      endpoints: { s3: endpoint },
      skip_credentials_validation: true,
      skip_metadata_api_check: true,
      skip_region_validation: true,
      skip_requesting_account_id: true,
      use_path_style: false,
    };
  });
}

export function backends(
  choose: (opts: Opts) => string,
  advices: Record<string, (opts: Opts) => Opts>,
) {
  return (opts: Opts): Opts => {
    const name = choose(opts);
    const advice = advices[name];
    if (!advice) throw new StepError(`unsupported OpenTofu backend: ${name}`);
    return advice(opts);
  };
}

export function hclList(values: unknown[]): string {
  return `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;
}

export function hclMap(values: Record<string, string>): string {
  const entries = Object.entries(values).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return "{}";
  return `{\n${entries
    .map(([key, value]) => `    ${JSON.stringify(key)} : ${JSON.stringify(value)}`)
    .join(",\n")}\n  }`;
}

export function constructName(name: string): string {
  const slash = name.indexOf("/");
  const namespace = slash < 0 ? "" : name.slice(0, slash);
  const localName = slash < 0 ? name : name.slice(slash + 1);
  const sanitize = (part: string) => part.replace(/[-.]/g, "_");
  return `${namespace ? `${sanitize(namespace)}_` : ""}${sanitize(localName)}`;
}

export function construct(
  group: string,
  type: string,
  name: string,
  block: Record<string, unknown>,
): Record<string, unknown> {
  return { [group]: { [type]: { [constructName(name)]: block } } };
}

export function deepMerge(...maps: Record<string, any>[]): Record<string, any> {
  const result: Record<string, any> = {};
  for (const map of maps) {
    for (const [key, value] of Object.entries(map)) {
      const old = result[key];
      result[key] =
        old && value && !Array.isArray(old) && !Array.isArray(value) &&
        typeof old === "object" && typeof value === "object"
          ? deepMerge(old, value)
          : value;
    }
  }
  return result;
}

export function constructsJson(constructs: Record<string, unknown>[]): string {
  return prettyJson(jsonValue(constructs.length ? deepMerge(...constructs) : {}));
}
