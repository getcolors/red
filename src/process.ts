import { runtime, type ExecOptions, type ExecResult } from "./runtime.ts";

export function posixQuote(value: unknown): string { return `'${String(value).replaceAll("'", "'\\''")}'`; }

export async function runInherit(args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  return runtime.execInherit(args, opts);
}

export interface PlanCommand { label: string; args: string[]; options?: ExecOptions }
export interface PlanOptions {
  runner?: (command: PlanCommand) => Promise<ExecResult>;
  continueOnError?: (command: PlanCommand, result: ExecResult) => boolean;
  cleanup?: () => void | Promise<void>;
}
export async function runPlan(commands: PlanCommand[], options: PlanOptions = {}): Promise<ExecResult & { command?: PlanCommand }> {
  const runner = options.runner ?? ((command) => runtime.exec(command.args, command.options));
  try {
    for (const command of commands) {
      const result = await runner(command);
      if (result.exit && !options.continueOnError?.(command, result)) return { ...result, command };
    }
    return { exit: 0, out: "", err: "" };
  } finally { await options.cleanup?.(); }
}
