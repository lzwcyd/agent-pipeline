import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { buildCodexArgs, parseCodexJsonl } from "../src/agents/codex-runner.js";
import { buildOpenCodeArgs, parseOpenCodeJsonl } from "../src/agents/opencode-runner.js";
import { createAgentRunner } from "../src/agents/provider.js";
import { runProcess } from "../src/agents/process.js";

describe("OpenCode provider", () => {
  it("counts every step_finish and preserves Provider-reported cost", () => {
    const parsed = parseOpenCodeJsonl(
      [
        "not-json",
        JSON.stringify({ type: "text", sessionID: "ses-open", part: { text: '{"status":"ok"}' } }),
        JSON.stringify({
          type: "step_finish",
          sessionID: "ses-open",
          part: {
            tokens: { input: 40, output: 12, reasoning: 2, cache: { read: 60, write: 3 } },
            cost: 0.004,
          },
        }),
        JSON.stringify({
          type: "step_finish",
          sessionID: "ses-open",
          part: {
            tokens: { input: 10, output: 4, reasoning: 1, cache: { read: 90, write: 0 } },
            cost: 0.002,
          },
        }),
      ].join("\n"),
      "provider/model",
    );

    expect(parsed.parsed).toEqual({ status: "ok" });
    expect(parsed.usage).toEqual({
      inputTokens: 50,
      outputTokens: 16,
      reasoningTokens: 3,
      cacheReadTokens: 150,
      cacheWriteTokens: 3,
      cacheHitRate: 0.75,
      requestCount: 2,
      sessionIds: ["ses-open"],
      models: ["provider/model"],
      costUsd: 0.006,
    });
  });

  it("builds the documented non-interactive command", () => {
    expect(buildOpenCodeArgs("payload", "/tmp/project", "provider/model")).toEqual([
      "run",
      "--format",
      "json",
      "--dir",
      "/tmp/project",
      "--model",
      "provider/model",
      "payload",
    ]);
  });
});

describe("Codex provider", () => {
  it("separates cached input and reasoning output from visible tokens", () => {
    const parsed = parseCodexJsonl(
      [
        JSON.stringify({ type: "thread.started", thread_id: "thread-codex" }),
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: '{"accepted":true}' } }),
        JSON.stringify({
          type: "turn.completed",
          usage: {
            input_tokens: 1000,
            cached_input_tokens: 700,
            cache_write_input_tokens: 25,
            output_tokens: 120,
            reasoning_output_tokens: 80,
          },
        }),
      ].join("\n"),
      "gpt-5",
    );

    expect(parsed.parsed).toEqual({ accepted: true });
    expect(parsed.usage).toEqual({
      inputTokens: 300,
      outputTokens: 40,
      reasoningTokens: 80,
      cacheReadTokens: 700,
      cacheWriteTokens: 25,
      cacheHitRate: 0.7,
      requestCount: 1,
      sessionIds: ["thread-codex"],
      models: ["gpt-5"],
      costUsd: null,
    });
  });

  it("uses the last completed agent message and clamps inconsistent counters", () => {
    const parsed = parseCodexJsonl(
      [
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "first" } }),
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: '```json\n{"status":"pass"}\n```' } }),
        JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: 10, cached_input_tokens: 30, output_tokens: 2, reasoning_output_tokens: 5 },
        }),
      ].join("\n"),
      undefined,
    );

    expect(parsed.parsed).toEqual({ status: "pass" });
    expect(parsed.usage).toMatchObject({ inputTokens: 0, outputTokens: 0, reasoningTokens: 5 });
    expect(parsed.usage.models).toEqual(["unknown"]);
  });

  it("builds sandboxed codex exec arguments", () => {
    expect(buildCodexArgs("payload", "/tmp/project", "gpt-5", "read-only")).toEqual([
      "exec",
      "--json",
      "-C",
      "/tmp/project",
      "--sandbox",
      "read-only",
      "--model",
      "gpt-5",
      "payload",
    ]);
  });
});

describe("provider process and factory", () => {
  it("returns partial output when a child process times out", async () => {
    const result = await runProcess({
      cli: process.execPath,
      args: ["-e", "process.stdout.write('started'); setTimeout(() => {}, 1000)"],
      cwd: process.cwd(),
      timeoutMs: 200,
    });

    expect(result.status).toBe("timeout");
    expect(result.stdout).toBe("started");
  });

  it("selects Codex and applies unified configuration defaults", () => {
    const cfg = loadConfig({ AGENT_RUNTIME: "codex" });

    expect(cfg.AGENT_CLI).toBe("codex");
    expect(cfg.AGENT_TIMEOUT_MS).toBe(600_000);
    expect(cfg.CODEX_SANDBOX).toBe("workspace-write");
    expect(createAgentRunner(cfg).runtime).toBe("codex");
  });
});
