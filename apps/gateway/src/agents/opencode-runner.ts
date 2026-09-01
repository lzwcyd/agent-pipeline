import { mkdirSync } from "node:fs";
import type { AppLogger } from "../logger.js";
import type { AgentTask } from "../types.js";
import { runProcess } from "./process.js";
import { extractJson, type AgentRunResult, type AgentRunner, type ParsedAgentOutput } from "./runner.js";
import { mergeUsage, type AgentRequestUsage } from "./usage.js";

function lineObjects(stdout: string): Record<string, unknown>[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const value = JSON.parse(line) as unknown;
        return value && typeof value === "object" ? [value as Record<string, unknown>] : [];
      } catch {
        return [];
      }
    });
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export function parseOpenCodeJsonl(stdout: string, configuredModel?: string): ParsedAgentOutput {
  const text: string[] = [];
  const requests: AgentRequestUsage[] = [];
  const model = configuredModel || "unknown";

  for (const event of lineObjects(stdout)) {
    const part = event.part && typeof event.part === "object" ? event.part as Record<string, unknown> : {};
    if (event.type === "text" && typeof part.text === "string") text.push(part.text);
    if (event.type !== "step_finish") continue;
    const tokens = part.tokens && typeof part.tokens === "object" ? part.tokens as Record<string, unknown> : {};
    const cache = tokens.cache && typeof tokens.cache === "object" ? tokens.cache as Record<string, unknown> : {};
    const sessionId = typeof event.sessionID === "string"
      ? event.sessionID
      : typeof part.sessionID === "string" ? part.sessionID : undefined;
    requests.push({
      runtime: "opencode",
      sessionId,
      model,
      inputTokens: finite(tokens.input),
      outputTokens: finite(tokens.output),
      reasoningTokens: finite(tokens.reasoning),
      cacheReadTokens: finite(cache.read),
      cacheWriteTokens: finite(cache.write),
      ...(typeof part.cost === "number" && Number.isFinite(part.cost) ? { costUsd: Math.max(0, part.cost) } : {}),
    });
  }

  const finalText = text.join("");
  return {
    text: finalText,
    parsed: extractJson(finalText) as Record<string, unknown> | null,
    usage: mergeUsage(...requests),
  };
}

export function buildOpenCodeArgs(payload: string, cwd: string, model?: string): string[] {
  return ["run", "--format", "json", "--dir", cwd, ...(model ? ["--model", model] : []), payload];
}

export class OpenCodeRunner implements AgentRunner {
  readonly runtime = "opencode" as const;

  constructor(private readonly opts: { cli: string; model?: string; timeoutMs: number; logger?: AppLogger }) {}

  async run(task: AgentTask, cwd: string): Promise<AgentRunResult> {
    mkdirSync(cwd, { recursive: true });
    const startedAt = Date.now();
    this.opts.logger?.info({ pipelineId: task.pipelineId, stage: task.stage, role: task.role, runtime: this.runtime, cli: this.opts.cli }, "agent run started");
    const processResult = await runProcess({
      cli: this.opts.cli,
      args: buildOpenCodeArgs(JSON.stringify(task), cwd, this.opts.model),
      cwd,
      timeoutMs: this.opts.timeoutMs,
    });
    const output = parseOpenCodeJsonl(processResult.stdout, this.opts.model);
    const status = processResult.status === "ok" && processResult.exitCode === 0 && output.parsed ? "ok" : processResult.status === "timeout" ? "timeout" : "error";
    const error = status === "ok" ? undefined : processResult.error ?? (processResult.stderr || "agent output is not valid JSON").slice(-800);
    this.opts.logger?.info({ pipelineId: task.pipelineId, stage: task.stage, role: task.role, runtime: this.runtime, exitCode: processResult.exitCode, durationMs: Date.now() - startedAt, requestCount: output.usage.requestCount }, "agent run finished");
    return { ...processResult, status, parsed: output.parsed, usage: output.usage, error };
  }
}
