import { spawn } from "node:child_process";

export interface ProcessRunOptions {
  cli: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
}

export interface ProcessRunResult {
  status: "ok" | "error" | "timeout";
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
}

/** 启动 CLI 并保留超时/失败前已经产生的输出。 */
export function runProcess(opts: ProcessRunOptions): Promise<ProcessRunResult> {
  return new Promise((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(opts.cli, opts.args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const finish = (result: ProcessRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drainTimer);
      resolvePromise(result);
    };

    const timeoutResult = (): ProcessRunResult => ({
      status: "timeout",
      exitCode: -1,
      stdout,
      stderr,
      error: `agent CLI timed out after ${opts.timeoutMs}ms`,
    });
    const timer = setTimeout(() => {
      timedOut = true;
      // close 在 stdout/stderr 排空后触发；保留终止前已经写入管道的 JSONL。
      // 若后代进程持有管道不释放，限定额外等待时间，避免永久挂起。
      drainTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(timeoutResult());
      }, 1000);
      child.kill("SIGKILL");
    }, opts.timeoutMs);

    child.on("error", (error) => {
      if (!timedOut) finish({ status: "error", exitCode: -1, stdout, stderr, error: error.message });
    });
    child.on("close", (code) => {
      finish(timedOut ? timeoutResult() : { status: "ok", exitCode: code ?? -1, stdout, stderr });
    });
  });
}
