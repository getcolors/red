// Zod-backed validation gates for the before-while combinator.
//
// A gate VALIDATES, it never transforms: Zod's default object parsing strips
// unknown keys, and replacing opts with a parse result would silently drop
// every other namespace's keys from the threaded map. On success the gate
// returns the ORIGINAL opts (truthy, so the chain continues); on failure it
// throws a StepError, which the step boundary converts to "red/exit"/
// "red/err" through the ordinary error contract — the guarded step never
// runs and the failure message names each offending key.

import type { ZodType } from "zod";
import type { Opts } from "./workflow.ts";
import { StepError } from "./workflow.ts";

// Build a before-while advice from a Zod schema: opts pass through untouched
// when they validate; otherwise the gate throws (default exit 2) and the
// guarded step never runs.
export function schemaGate(schema: ZodType, opts?: { exit?: number }) {
  const exit = opts?.exit ?? 2;
  return (o: Opts): Opts => {
    const result = schema.safeParse(o);
    if (result.success) return o;
    const detail = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new StepError(`schema gate failed: ${detail}`, { exit });
  };
}
