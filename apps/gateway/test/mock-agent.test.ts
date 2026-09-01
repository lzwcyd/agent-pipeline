import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const MOCK_AGENT = resolve(REPO_ROOT, "scripts", "mock-agent.mjs");
const TASK = JSON.stringify({
  pipelineId: "pipe-test",
  stage: "evaluating",
  role: "evaluator",
  requirement: { title: "test" },
});

function run(args: string[]) {
  const result = spawnSync(process.execPath, [MOCK_AGENT, ...args], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("mock-agent", () => {
  it("emits OpenCode JSONL with a model completion", () => {
    const events = run(["run", "--format", "json", "--dir", REPO_ROOT, TASK]);
    expect(events.map((event) => event.type)).toEqual(["text", "step_finish"]);
    expect(events[0]?.sessionID).toBe("mock-opencode-pipe-test");
    expect(JSON.parse(String((events[0]?.part as Record<string, unknown>).text))).toMatchObject({ approved: true });
    expect((events[1]?.part as Record<string, unknown>).tokens).toMatchObject({
      input: 100,
      output: 30,
      reasoning: 10,
      cache: { read: 300, write: 20 },
    });
  });

  it("emits Codex JSONL with a completed turn", () => {
    const events = run(["exec", "--json", "-C", REPO_ROOT, "--sandbox", "workspace-write", TASK]);
    expect(events.map((event) => event.type)).toEqual(["thread.started", "item.completed", "turn.completed"]);
    expect(events[0]?.thread_id).toBe("mock-codex-pipe-test");
    const item = events[1]?.item as Record<string, unknown>;
    expect(JSON.parse(String(item.text))).toMatchObject({ approved: true });
    expect(events[2]?.usage).toMatchObject({
      input_tokens: 400,
      cached_input_tokens: 300,
      output_tokens: 40,
      reasoning_output_tokens: 10,
      cache_write_input_tokens: 20,
    });
  });
});
