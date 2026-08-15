import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import type { AgentTask } from "../types.js";

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** 从 stdout 解析出的 JSON（尽力而为） */
  parsed: Record<string, unknown> | null;
}

/** 从 agent 输出中抽取 JSON：支持纯 JSON、围栏代码块、以及“前文+JSON”混合 */
export function extractJson(text: string): unknown | null {
  if (!text) return null;
  const trimmed = text.trim();
  // 1) 直接是 JSON
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fallthrough */
  }
  // 2) 围栏代码块（可能带语言标注）
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      /* fallthrough */
    }
  }
  // 3) 第一个 { 到最后一个 } 之间的内容
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) {
    try {
      return JSON.parse(trimmed.slice(first, last + 1));
    } catch {
      /* fallthrough */
    }
  }
  return null;
}

/**
 * 调用 DSH headless agent：`<DSH_CLI> --profile headless "<task>"`。
 * task 为单个位置参数；agent 把 task 作为用户消息执行，最终文本写 stdout。
 */
export class DshRunner {
  constructor(
    private readonly opts: {
      cli: string;
      timeoutMs: number;
    },
  ) {}

  async run(task: AgentTask, cwd: string): Promise<RunResult> {
    mkdirSync(cwd, { recursive: true });
    const payload = JSON.stringify(task);
    return new Promise<RunResult>((resolvePromise, rejectPromise) => {
      const child = spawn(this.opts.cli, ["--profile", "headless", payload], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });
      let stdout = "";
      let stderr = "";
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        rejectPromise(
          new Error(`DSH agent 超时（${this.opts.timeoutMs}ms）：pipeline=${task.pipelineId} stage=${task.stage}`),
        );
      }, this.opts.timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rejectPromise(err);
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const parsed = extractJson(stdout) as Record<string, unknown> | null;
        resolvePromise({ exitCode: code ?? -1, stdout, stderr, parsed });
      });
    });
  }
}
