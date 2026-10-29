// The runtime seam: every log line the library writes (dry-run notes,
// progress lines) goes through this mutable object so tests can stub it.
// Steps run their own commands directly (Bun.spawn, fetch, an SDK client);
// the library has no subprocess runner.

export const runtime = {
  log: ((...args: unknown[]) => console.log(...args)) as (...args: unknown[]) => void,
};
