import type { Opts } from "./workflow.ts";

export interface PreflightContext { event: string | undefined; real: boolean }
export interface PreflightConfig {
  defaults?: Opts;
  overlay?: (opts: Opts, env: Record<string, string | undefined>) => Opts;
  validators?: Array<(opts: Opts, env: Record<string, string | undefined>, context: PreflightContext) => string[] | undefined>;
  afterValidate?: (opts: Opts, env: Record<string, string | undefined>, context: PreflightContext) => Opts | Promise<Opts>;
}

export async function preflight(
  original: Opts, config: PreflightConfig,
  env: Record<string, string | undefined> = process.env,
): Promise<Opts> {
  const opts = (config.overlay ?? ((x) => x))({ ...(config.defaults ?? {}), ...original }, env);
  const context = { event: typeof opts["red/event"] === "string" ? opts["red/event"] as string : undefined,
    real: !opts["red/dry-run"] };
  const errors = (config.validators ?? []).flatMap((validator) => validator(opts, env, context) ?? []);
  if (errors.length) return { ...opts, "red/exit": 2, "red/err": errors.join("\n") };
  return config.afterValidate ? await config.afterValidate(opts, env, context) : { ...opts, "red/exit": 0 };
}
