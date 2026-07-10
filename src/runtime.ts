// The runtime seam: every subprocess and every log line goes through this
// mutable object so tests can stub them (the port of green's
// `with-redefs [sh/sh ...]` sites) and future features can record runs.

export interface ExecResult {
  exit: number;
  out: string;
  err: string;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
}

async function spawnExec(cmd: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  try {
    const proc = Bun.spawn(cmd, {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const [out, err, exit] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exit, out, err };
  } catch (e) {
    // command not found and similar spawn failures follow the same shape
    return { exit: 127, out: "", err: e instanceof Error ? e.message : String(e) };
  }
}

export const runtime = {
  exec: spawnExec as (cmd: string[], opts?: ExecOptions) => Promise<ExecResult>,
  log: ((...args: unknown[]) => console.log(...args)) as (...args: unknown[]) => void,
};
