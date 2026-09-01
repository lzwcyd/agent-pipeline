import { mkdirSync } from "node:fs";
import type { AppLogger } from "../logger.js";
import type { AgentTask } from "../types.js";
import { runProcess } from "./process.js";
import { extractJson, type AgentRunResult, type AgentRunner, type ParsedAgentOutput } from "./runner.js";
import { mergeUsage, type AgentRequestUsage } from "./usage.js";

export type CodexSandbox = "read-only" | "workspace-write" | "danger-full-access";

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export function parseCodexJsonl(stdout: string, configuredModel?: string): ParsedAgentOutput {
  let sessionId: string | undefined;
  let finalText = "";
  const requests: AgentRequestUsage[] = [];
  const model = configuredModel || "unknown";

  for (const line of stdout.split(/\r?\n/)) {
    let event: Record<string, unknown>;
    try {
      const value = JSON.parse(line) as unknown;
      if (!value || typeof value !== "object") continue;
      event = value as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type === "thread.started" && typeof event.thread_id === "string") sessionId = event.thread_id;
    const item = event.item && typeof event.item === "object" ? event.item as Record<string, unknown> : {};
    if (event.type === "item.completed" && item.type === "agent_message" && typeof item.text === "string") {
      finalText = item.text;
    }
    if (event.type !== "turn.completed") continue;
    const usage = event.usage && typeof event.usage === "object" ? event.usage as Record<string, unknown> : {};
    const cachedInput = finite(usage.cached_input_tokens);
    const reasoningOutput = finite(usage.reasoning_output_tokens);
    requests.push({
      runtime: "codex",
      sessionId,
      model,
      inputTokens: Math.max(0, finite(usage.input_tokens) - cachedInput),
      outputTokens: Math.max(0, finite(usage.output_tokens) - reasoningOutput),
      reasoningTokens: reasoningOutput,
      cacheReadTokens: cachedInput,
      cacheWriteTokens: finite(usage.cache_write_input_tokens),
    });
  }

  return {
    text: finalText,
    parsed: extractJson(finalText) as Record<string, unknown> | null,
    usage: mergeUsage(...requests),
  };
}

export function buildCodexArgs(payload: string, cwd: string, model: string | undefined, sandbox: CodexSandbox): string[] {
  return ["exec", "--json", "-C", cwd, "--sandbox", sandbox, ...(model ? ["--model", model] : []), payload];
}

export class CodexRunner implements AgentRunner {
  readonly runtime = "codex" as const;

  constructor(private readonly opts: { cli: string; model?: string; timeoutMs: number; sandbox: CodexSandbox; logger?: AppLogger }) {}

  async run(task: AgentTask, cwd: string): Promise<AgentRunResult> {
    mkdirSync(cwd, { recursive: true });
    const startedAt = Date.now();
    this.opts.logger?.info({ pipelineId: task.pipelineId, stage: task.stage, role: task.role, runtime: this.runtime, cli: this.opts.cli }, "agent run started");
    const processResult = await runProcess({
      cli: this.opts.cli,
      args: buildCodexArgs(JSON.stringify(task), cwd, this.opts.model, this.opts.sandbox),
      cwd,
      timeoutMs: this.opts.timeoutMs,
    });
    const output = parseCodexJsonl(processResult.stdout, this.opts.model);
    const status = processResult.status === "ok" && processResult.exitCode === 0 && output.parsed ? "ok" : processResult.status === "timeout" ? "timeout" : "error";
    const error = status === "ok" ? undefined : processResult.error ?? (processResult.stderr || "agent output is not valid JSON").slice(-800);
    this.opts.logger?.info({ pipelineId: task.pipelineId, stage: task.stage, role: task.role, runtime: this.runtime, exitCode: processResult.exitCode, durationMs: Date.now() - startedAt, requestCount: output.usage.requestCount }, "agent run finished");
    return { ...processResult, status, parsed: output.parsed, usage: output.usage, error };
  }
}
