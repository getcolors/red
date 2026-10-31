// Configuration helpers; applications own file selection and their CLI.
import type { Opts } from "./workflow.ts";

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

/** Parse YAML data without reading files or applying environment overrides. */
export function loadYaml(text: string): Opts {
  return (Bun.YAML.parse(text) ?? {}) as Opts;
}
