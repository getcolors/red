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
  timeoutMs?: number;
}

function capture(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const done = (async () => {
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value, { stream: true });
      }
    } finally {
      text += decoder.decode();
    }
  })();
  return { done, text: () => text, cancel: () => reader.cancel().catch(() => {}) };
}

async function spawnExec(cmd: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const proc = Bun.spawn(cmd, {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      detached: Boolean(opts.timeoutMs) && process.platform !== "win32",
    });
    const stdout = capture(proc.stdout);
    const stderr = capture(proc.stderr);
    const completed = Promise.all([stdout.done, stderr.done, proc.exited]);
    const deadline = new Promise<null>((resolve) => {
      if (opts.timeoutMs) timer = setTimeout(() => resolve(null), opts.timeoutMs);
    });
    const result = await Promise.race([completed, deadline]);
    if (result === null) {
      let killer: ReturnType<typeof Bun.spawn> | undefined;
      try {
        if (process.platform === "win32") {
          killer = Bun.spawn(["taskkill", "/PID", String(proc.pid), "/T", "/F"], {
            stdin: "ignore", stdout: "ignore", stderr: "ignore",
          });
        } else {
          // The group can still contain children after the original process exits.
          process.kill(-proc.pid, "SIGKILL");
        }
      } catch {
        proc.kill(9);
      }
      // A descendant can leave the group and retain the pipes. Never wait
      // indefinitely for EOF or for the platform's termination command.
      await Promise.race([
        Promise.allSettled([completed, ...(killer ? [killer.exited] : [])]),
        new Promise<void>((resolve) => { cleanupTimer = setTimeout(resolve, 1000); }),
      ]);
      killer?.kill(9);
      proc.kill(9);
      void stdout.cancel();
      void stderr.cancel();
      const out = stdout.text();
      const err = stderr.text();
      const timeout = `command timed out after ${opts.timeoutMs}ms`;
      return { exit: 124, out, err: err ? `${err}\n${timeout}` : timeout };
    }
    const exit = result[2];
    // Workflow helpers reserve positive codes for failure. Preserve shell
    // signal status if a runtime reports a negative process return code.
    return { exit: exit < 0 ? 128 - exit : exit, out: stdout.text(), err: stderr.text() };
  } catch (e) {
    // command not found and similar spawn failures follow the same shape
    return { exit: 127, out: "", err: e instanceof Error ? e.message : String(e) };
  } finally {
    if (timer) clearTimeout(timer);
    if (cleanupTimer) clearTimeout(cleanupTimer);
  }
}

async function spawnInherit(cmd: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  try {
    const proc = Bun.spawn(cmd, {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    const exit = await proc.exited;
    return { exit: exit < 0 ? 128 - exit : exit, out: "", err: "" };
  } catch (error) {
    return { exit: 127, out: "", err: error instanceof Error ? error.message : String(error) };
  }
}

export const runtime = {
  exec: spawnExec as (cmd: string[], opts?: ExecOptions) => Promise<ExecResult>,
  execInherit: spawnInherit as (cmd: string[], opts?: ExecOptions) => Promise<ExecResult>,
  log: ((...args: unknown[]) => console.log(...args)) as (...args: unknown[]) => void,
};
