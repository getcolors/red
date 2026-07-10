// Progress reporting, built on the advice facility. Attach with `advise` to
// print step start/end with elapsed time; reads "red/step" from opts.

import { runtime } from "./runtime.ts";
import type { Opts, StepFn, Workflow } from "./workflow.ts";
import { adviceAddAll } from "./workflow.ts";

export const PROGRESS_ID = "red.progress/progress";

// An around advice that prints step name on entry and elapsed time on exit.
// Reads "red/step" from opts (stamped by the engine).
export async function progress(f: StepFn, opts: Opts): Promise<Opts> {
  const step = opts["red/step"];
  const event = opts["red/event"] ?? "create";
  runtime.log(`>>> ${step} (${event})`);
  const t0 = Date.now();
  const result = await f(opts);
  runtime.log(`<<< ${step} (${Date.now() - t0}ms)`);
  return result;
}

// Attach progress advice to every step. Returns the advised workflow.
export function advise(wf: Workflow): Workflow {
  return adviceAddAll(wf, "around", PROGRESS_ID, progress);
}
