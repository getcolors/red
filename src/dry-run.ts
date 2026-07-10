// Dry-run support, built on the advice facility rather than hardwired into
// steps. Attach `advice` (an around) to side-effecting steps — or `advise` a
// whole list of them; when "red/dry-run" is set in opts (the CLI's --dry-run
// flag stamps it) the step is skipped with a note instead of run.

import { runtime } from "./runtime.ts";
import type { Opts, StepFn, Workflow } from "./workflow.ts";
import { adviceAdd } from "./workflow.ts";

export const SKIP_ID = "red.dry-run/skip";

// Build an around advice for `step`: when "red/dry-run" is set, print what
// would have run and skip the base function; otherwise call through.
export function advice(step: string) {
  return (f: StepFn, opts: Opts): Opts | Promise<Opts> => {
    if (opts["red/dry-run"]) {
      runtime.log(`dry-run: would run ${step} (${opts["red/event"] ?? "create"})`);
      return { ...opts, "red/exit": 0 };
    }
    return f(opts);
  };
}

// Attach dry-run advice to every step in `steps` under id "red.dry-run/skip".
// Returns the advised workflow; remove per step with
// adviceRemove(wf, step, SKIP_ID).
export function advise(wf: Workflow, steps: string[]): Workflow {
  return steps.reduce((w, s) => adviceAdd(w, s, "around", SKIP_ID, advice(s)), wf);
}
