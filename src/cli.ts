// CLI plumbing: `./red <event> [-f|--file red.yml] [--start step]
// [--end step] [--dry-run]`. The first positional argument is the lifecycle
// event, stamped into opts as "red/event". --start/--end run a slice of the
// graph.

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Opts, Workflow } from "./workflow.ts";
import { run } from "./workflow.ts";

export const usage =
  "Usage: red <event> [-f|--file red.yml] [--start step] [--end step] [--dry-run]";

// The parameter namespace every colour shares, so one variable serves green,
// red and blue without naming any of them.
const parPrefix = "COLORS_PAR_";

export function parName(key: string): string {
  return `${parPrefix}${key.toUpperCase().replaceAll("-", "_")}`;
}

function coerce(old: unknown, value: string): unknown {
  if (typeof old === "boolean") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  if (typeof old === "number" && Number.isInteger(old) && /^-?\d+$/.test(value)) {
    return Number(value);
  }
  return value;
}

export function readPars(
  opts: Opts,
  env: Record<string, string | undefined> = process.env,
): Opts {
  return Object.entries(env).reduce((result, [name, value]) => {
    if (!name.startsWith(parPrefix) || name.length === parPrefix.length || value === undefined) {
      return result;
    }
    const key = name.slice(parPrefix.length).toLowerCase().replaceAll("_", "-");
    return { ...result, [key]: coerce(result[key], value) };
  }, { ...opts });
}

export function findUp(name: string, start = process.cwd()): string | undefined {
  let dir = resolve(start);
  for (;;) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function stageDir(
  opts: Opts, tool: string,
  config: { defaultWorkdir?: string; defaultProfile?: string; stateFileKey?: string } = {},
): string {
  const workdir = String(opts.workdir ?? config.defaultWorkdir ?? ".colors");
  const stateFile = opts[config.stateFileKey ?? "red/state-file"];
  const root = !isAbsolute(workdir) && typeof stateFile === "string"
    ? join(dirname(stateFile), workdir) : workdir;
  return join(root, String(opts.profile ?? config.defaultProfile ?? "default"), tool);
}

export interface CliConfig {
  defaultFile?: string;
  searchParents?: boolean;
  allowedEvents?: string[];
}

// Parse `args`, load the desired state, stamp "red/event", run `workflow`.
// Returns the final opts map ("red/exit" 2 on usage/state-file errors).
export async function runCli(workflow: Workflow, args: string[], config: CliConfig = {}): Promise<Opts> {
  try {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        file: { type: "string", short: "f", default: config.searchParents
          ? findUp(config.defaultFile ?? "red.yml") ?? config.defaultFile ?? "red.yml"
          : config.defaultFile ?? "red.yml" },
        start: { type: "string" },
        end: { type: "string" },
        "dry-run": { type: "boolean" },
      },
    });
    const event = positionals[0];
    if (!event || (config.allowedEvents && !config.allowedEvents.includes(event))) {
      return { "red/exit": 2, "red/err": usage };
    }
    if (!existsSync(values.file)) {
      return { "red/exit": 2, "red/err": `desired state file not found: ${values.file}` };
    }
    // "red/state-file" is the absolute path the state came from, so a project
    // can resolve its own relative paths against the file rather than against
    // whatever directory the command happened to run in.
    const state = readPars({
      ...((Bun.YAML.parse(readFileSync(values.file, "utf8")) ?? {}) as Opts),
      "red/state-file": resolve(values.file),
    });
    const wf: Workflow = {
      ...workflow,
      ...(values.start ? { start: values.start } : {}),
      ...(values.end ? { end: values.end } : {}),
    };
    const opts: Opts = {
      ...state,
      "red/event": event,
      ...(values["dry-run"] ? { "red/dry-run": true } : {}),
    };
    return await run(wf, opts);
  } catch (t) {
    return {
      "red/exit": 2,
      "red/err": t instanceof Error ? t.message || t.constructor.name : String(t),
    };
  }
}

// Run and exit the process with "red/exit", printing "red/err" and
// "red/trace" to stderr. For use from the project's ./red bun script.
export async function execCli(workflow: Workflow, args: string[] = Bun.argv.slice(2), config: CliConfig = {}): Promise<never> {
  // a stray un-awaited rejection cannot be attributed to a branch; report it
  // and fail the process instead of letting the runtime decide
  process.on("unhandledRejection", (reason) => {
    console.error(`unhandled rejection: ${reason instanceof Error ? reason.stack : String(reason)}`);
    process.exit(1);
  });
  const res = await runCli(workflow, args, config);
  if (res["red/err"]) {
    console.error(res["red/err"]);
    if (res["red/trace"]) console.error(res["red/trace"]);
  }
  return process.exit(res["red/exit"] ?? 0);
}
