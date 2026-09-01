import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCodexJsonl } from "../src/agents/codex-runner.js";
import { runProcess } from "../src/agents/process.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

describe("process timeout drain", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  it("waits for close and retains usage bytes drained after the kill signal", async () => {
    vi.useFakeTimers();
    const usageLine = JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } }) + "\n";
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => {
        // 模拟 kill 后，已在管道中的数据晚于超时回调到达。
        setTimeout(() => {
          child.stdout.end(usageLine);
          child.stderr.end("partial diagnostics");
          child.emit("close", null);
        }, 1);
        return true;
      },
    });
    vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);

    const pending = runProcess({ cli: "agent", args: [], cwd: process.cwd(), timeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(11);
    const result = await pending;

    expect(result.status).toBe("timeout");
    expect(result.stdout).toBe(usageLine);
    expect(result.stderr).toBe("partial diagnostics");
    expect(parseCodexJsonl(result.stdout).usage).toMatchObject({ requestCount: 1, inputTokens: 10, outputTokens: 2 });
  });

  it("bounds the wait if a killed process never closes its pipes", async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true,
    });
    vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);
    let settled = false;
    const pending = runProcess({ cli: "agent", args: [], cwd: process.cwd(), timeoutMs: 10 });
    void pending.then(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(10);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1500);
    expect((await pending).status).toBe("timeout");
  });
});
