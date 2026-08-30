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
      resolvePromise(result);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({
        status: "timeout",
        exitCode: -1,
        stdout,
        stderr,
        error: `agent CLI timed out after ${opts.timeoutMs}ms`,
      });
    }, opts.timeoutMs);

    child.on("error", (error) => {
      finish({ status: "error", exitCode: -1, stdout, stderr, error: error.message });
    });
    child.on("close", (code) => {
      finish({ status: "ok", exitCode: code ?? -1, stdout, stderr });
    });
  });
}
