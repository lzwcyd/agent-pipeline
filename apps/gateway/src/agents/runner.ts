import type { AgentTask } from "../types.js";
import type { AgentRuntime, AgentUsage } from "./usage.js";

export interface AgentRunResult {
  status: "ok" | "error" | "timeout";
  exitCode: number;
  stdout: string;
  stderr: string;
  parsed: Record<string, unknown> | null;
  usage: AgentUsage;
  error?: string;
}

export interface AgentRunner {
  readonly runtime: AgentRuntime;
  run(task: AgentTask, cwd: string): Promise<AgentRunResult>;
}

export interface ParsedAgentOutput {
  text: string;
  parsed: Record<string, unknown> | null;
  usage: AgentUsage;
}

/** 支持纯 JSON、围栏代码块以及前后带说明的 JSON。 */
export function extractJson(text: string): unknown | null {
  if (!text) return null;
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Continue with tolerant extraction.
  }
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      // Continue with object extraction.
    }
  }
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) {
    try {
      return JSON.parse(trimmed.slice(first, last + 1));
    } catch {
      return null;
    }
  }
  return null;
}
