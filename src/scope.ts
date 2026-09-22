/** Runtime capabilities belong in closures, never serialized workflow opts. */
export type CleanupPhase = "process" | "resource";
export type RegisterFinalizer = (phase: CleanupPhase, cleanup: () => unknown | Promise<unknown>) => void;

/** Process cleanup runs before resource cleanup, LIFO within each phase.
 * Await all owned work in the body; cancellation is cooperative (reject/abort
 * and await dependent work). Cleanup must stop and await owned processes.
 * All callbacks run; a body failure takes precedence over cleanup failures.
 */
export async function withScope<T>(body: (register: RegisterFinalizer) => T | Promise<T>): Promise<T> {
  const callbacks: Record<CleanupPhase, Array<() => unknown | Promise<unknown>>> = {process: [], resource: []};
  let open = true;
  const register: RegisterFinalizer = (phase, cleanup) => {
    if (!open) throw new Error("Scope is closed");
    if (!(phase === "process" || phase === "resource") || typeof cleanup !== "function") throw new Error("Invalid scope finalizer");
    callbacks[phase].push(cleanup);
  };
  let result!: T;
  let failed = false;
  let failure: unknown;
  try { result = await body(register); }
  catch (error) { failed = true; failure = error; }
  open = false;
  const errors: unknown[] = [];
  for (const phase of ["process", "resource"] as const) {
    for (const cleanup of callbacks[phase].reverse()) {
      try { await cleanup(); } catch (error) { errors.push(error); }
    }
  }
  if (failed) throw failure;
  if (errors.length) throw new AggregateError(errors, "Scope cleanup failed");
  return result;
}
