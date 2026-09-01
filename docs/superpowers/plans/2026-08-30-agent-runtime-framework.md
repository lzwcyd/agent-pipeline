# Generic Agent Runtime Framework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the DSH-specific runner with interchangeable OpenCode and Codex providers and persist complete normalized model usage across every pipeline execution path.

**Architecture:** The orchestrator consumes one `AgentRunner` interface. Provider adapters translate each CLI's JSONL protocol into a common result and request-level usage model; pipeline history is the source of truth for stage and pipeline aggregates, while the Web UI renders the persisted summary.

**Tech Stack:** Node.js 22, TypeScript 5.7, Vitest 2, Express 4, vanilla browser JavaScript/CSS, pnpm 10.

**Spec:** `docs/superpowers/specs/2026-08-30-agent-runtime-framework-design.md`

## Global Constraints

- `AGENT_RUNTIME` supports exactly `opencode` and `codex`; its default is `opencode`.
- Input Token means non-cached input; output Token excludes reasoning Token.
- Cache hit rate is `cacheReadTokens / (inputTokens + cacheReadTokens)` and is recomputed after merging.
- Cost is never estimated; `costUsd` is `null` when no Provider event reports cost.
- All successful, failed, timed-out, parallel and retried model completion events must be counted.
- Old pipeline files without `usage` remain readable without a migration.
- Remove all DSH runtime, headless profile and installation compatibility paths.

---

### Task 1: Usage Domain Model and Aggregation

**Files:**
- Create: `apps/gateway/src/agents/usage.ts`
- Modify: `apps/gateway/src/types.ts`
- Create: `apps/gateway/test/usage.test.ts`

**Interfaces:**
- Produces: `AgentRequestUsage`, `AgentUsage`, `EMPTY_USAGE`, `mergeUsage(...sources: Array<AgentUsage | AgentRequestUsage | undefined>): AgentUsage`.
- Produces: optional `usage?: AgentUsage` on `AgentResult` and `PipelineExecution`, required `usage: AgentUsage` on newly created `Pipeline` objects.

- [ ] **Step 1: Write failing aggregation tests**

```ts
import { describe, expect, it } from "vitest";
import { mergeUsage } from "../src/agents/usage.js";

describe("mergeUsage", () => {
  it("sums request usage and recomputes cache hit rate", () => {
    expect(mergeUsage(
      { runtime: "opencode", sessionId: "s1", model: "m1", inputTokens: 100, outputTokens: 20, reasoningTokens: 5, cacheReadTokens: 300, cacheWriteTokens: 10, costUsd: 0.01 },
      { runtime: "opencode", sessionId: "s1", model: "m1", inputTokens: 100, outputTokens: 10, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.02 },
    )).toEqual({
      inputTokens: 200, outputTokens: 30, reasoningTokens: 5,
      cacheReadTokens: 300, cacheWriteTokens: 10,
      cacheHitRate: 0.6, requestCount: 2,
      sessionIds: ["s1"], models: ["m1"], costUsd: 0.03,
    });
  });

  it("keeps unknown provider cost as null", () => {
    expect(mergeUsage({ runtime: "codex", model: "unknown", inputTokens: 1, outputTokens: 1, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }).costUsd).toBeNull();
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `corepack pnpm --filter @pipeline/gateway test -- test/usage.test.ts`

Expected: FAIL because `../src/agents/usage.js` does not exist.

- [ ] **Step 3: Implement the usage types and merger**

```ts
export type AgentRuntime = "opencode" | "codex";

export interface AgentRequestUsage {
  runtime: AgentRuntime;
  sessionId?: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd?: number;
}

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheHitRate: number;
  requestCount: number;
  sessionIds: string[];
  models: string[];
  costUsd: number | null;
}

export const EMPTY_USAGE: AgentUsage = {
  inputTokens: 0, outputTokens: 0, reasoningTokens: 0,
  cacheReadTokens: 0, cacheWriteTokens: 0, cacheHitRate: 0,
  requestCount: 0, sessionIds: [], models: [], costUsd: null,
};
```

Implement `mergeUsage` by treating an `AgentUsage` as `requestCount` already-completed requests, treating an `AgentRequestUsage` as one request, summing finite non-negative counters, preserving `null` until a cost is reported, de-duplicating display arrays, and recomputing the ratio from the final counters.

- [ ] **Step 4: Add the fields to persisted pipeline types and store defaults**

Add `usage?: AgentUsage` to `AgentResult` and `PipelineExecution`, add `usage: AgentUsage` to `Pipeline`, and initialize new pipelines with `structuredClone(EMPTY_USAGE)` in `PipelineStore.create()`.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `corepack pnpm --filter @pipeline/gateway test -- test/usage.test.ts && corepack pnpm --filter @pipeline/gateway typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/src/agents/usage.ts apps/gateway/src/types.ts apps/gateway/src/pipeline/store.ts apps/gateway/test/usage.test.ts
git commit -m "feat: add normalized agent usage model"
```

---

### Task 2: Provider Parsers, Runners, Factory and Unified Configuration

**Files:**
- Create: `apps/gateway/src/agents/runner.ts`
- Create: `apps/gateway/src/agents/process.ts`
- Create: `apps/gateway/src/agents/opencode-runner.ts`
- Create: `apps/gateway/src/agents/codex-runner.ts`
- Create: `apps/gateway/src/agents/provider.ts`
- Delete: `apps/gateway/src/agents/dsh-runner.ts`
- Modify: `apps/gateway/src/config.ts`
- Modify: `apps/gateway/src/index.ts`
- Modify: `apps/gateway/src/cli/index.ts`
- Create: `apps/gateway/test/runner.test.ts`
- Modify: `apps/gateway/test/http.test.ts`
- Modify: `apps/gateway/test/e2e.test.ts`

**Interfaces:**
- Consumes: `AgentRequestUsage`, `AgentUsage`, `mergeUsage` from Task 1 and `AgentTask` from `types.ts`.
- Produces: `AgentRunner.run(task, cwd): Promise<AgentRunResult>`; `parseOpenCodeJsonl(stdout, configuredModel)`; `parseCodexJsonl(stdout, configuredModel)`; `createAgentRunner(cfg, logger?)`.

- [ ] **Step 1: Write failing OpenCode and Codex parser tests**

```ts
it("parses every OpenCode step_finish as an actual request", () => {
  const out = parseOpenCodeJsonl([
    JSON.stringify({ type: "text", sessionID: "ses-o", part: { text: "{\"status\":\"ok\"}" } }),
    JSON.stringify({ type: "step_finish", sessionID: "ses-o", part: { tokens: { input: 40, output: 12, reasoning: 2, cache: { read: 60, write: 3 } }, cost: 0.004 } }),
    JSON.stringify({ type: "step_finish", sessionID: "ses-o", part: { tokens: { input: 10, output: 4, reasoning: 1, cache: { read: 90, write: 0 } }, cost: 0.002 } }),
  ].join("\n"), "provider/model");
  expect(out.parsed).toEqual({ status: "ok" });
  expect(out.usage).toMatchObject({ inputTokens: 50, outputTokens: 16, reasoningTokens: 3, cacheReadTokens: 150, requestCount: 2, costUsd: 0.006 });
});

it("normalizes Codex cached input and reasoning output", () => {
  const out = parseCodexJsonl([
    JSON.stringify({ type: "thread.started", thread_id: "thr-c" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "{\"accepted\":true}" } }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 700, cache_write_input_tokens: 25, output_tokens: 120, reasoning_output_tokens: 80 } }),
  ].join("\n"), "gpt-5");
  expect(out.parsed).toEqual({ accepted: true });
  expect(out.usage).toMatchObject({ inputTokens: 300, outputTokens: 40, reasoningTokens: 80, cacheReadTokens: 700, cacheWriteTokens: 25, requestCount: 1, costUsd: null });
});
```

- [ ] **Step 2: Run parser tests and verify RED**

Run: `corepack pnpm --filter @pipeline/gateway test -- test/runner.test.ts`

Expected: FAIL because the provider modules do not exist.

- [ ] **Step 3: Define runner and process contracts**

```ts
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
```

Implement `runProcess({ cli, args, cwd, timeoutMs })` so timeout kills the child, retains captured streams and returns `status: "timeout"`; spawn errors return `status: "error"` with exit code `-1`.

- [ ] **Step 4: Implement Provider parsers and runners**

OpenCode arguments: `run --format json --dir <cwd> [--model <model>] <payload>`.

Codex arguments: `exec --json -C <cwd> --sandbox <sandbox> [--model <model>] <payload>`.

Both runners parse captured stdout even when the process is non-zero or timed out, then combine process state with parsed output and usage. A successful process without Agent JSON returns `status: "error"` and retains usage.

- [ ] **Step 5: Write failing configuration and factory tests**

```ts
it("selects codex and applies unified defaults", () => {
  const cfg = loadConfig({ AGENT_RUNTIME: "codex", PIPELINE_DATA_DIR: tempDir });
  expect(cfg.AGENT_CLI).toBe("codex");
  expect(cfg.AGENT_TIMEOUT_MS).toBe(600_000);
  expect(cfg.CODEX_SANDBOX).toBe("workspace-write");
  expect(createAgentRunner(cfg).runtime).toBe("codex");
});
```

- [ ] **Step 6: Replace DSH configuration and construction**

In `config.ts`, replace DSH fields with:

```ts
AGENT_RUNTIME: z.enum(["opencode", "codex"]).default("opencode"),
AGENT_CLI: z.string().optional(),
AGENT_MODEL: z.string().optional(),
AGENT_TIMEOUT_MS: z.coerce.number().positive().default(600_000),
CODEX_SANDBOX: z.enum(["read-only", "workspace-write", "danger-full-access"]).default("workspace-write"),
```

After parsing, set `AGENT_CLI: parsed.data.AGENT_CLI || parsed.data.AGENT_RUNTIME`. Construct the runner with `createAgentRunner(cfg, logger)` in `index.ts`, and change CLI dependency types and wait timeouts to `AgentRunner` and `AGENT_TIMEOUT_MS`.

- [ ] **Step 7: Run provider, config and type tests**

Run: `corepack pnpm --filter @pipeline/gateway test -- test/runner.test.ts test/http.test.ts test/e2e.test.ts && corepack pnpm --filter @pipeline/gateway typecheck`

Expected: parser and factory tests PASS; existing integration tests may still fail only where orchestrator usage persistence or mock CLI compatibility is not yet implemented.

- [ ] **Step 8: Commit**

```bash
git add apps/gateway/src/agents apps/gateway/src/config.ts apps/gateway/src/index.ts apps/gateway/src/cli/index.ts apps/gateway/test
git commit -m "feat: add OpenCode and Codex agent providers"
```

---

### Task 3: Orchestrator Usage Persistence and History Aggregation

**Files:**
- Modify: `apps/gateway/src/pipeline/orchestrator.ts`
- Modify: `apps/gateway/src/pipeline/history.ts`
- Modify: `apps/gateway/src/http/server.ts`
- Modify: `apps/gateway/test/e2e.test.ts`
- Modify: `apps/gateway/test/http.test.ts`

**Interfaces:**
- Consumes: `AgentRunner`, `AgentRunResult`, `AgentUsage`, `EMPTY_USAGE`, `mergeUsage`.
- Produces: usage-bearing `AgentResult`, `PipelineExecution`, `Pipeline.usage`, and `buildHistory(p).stats.usage`.

- [ ] **Step 1: Write failing end-to-end assertions for success, multi-run retry and failed retry**

```ts
expect(done.usage.requestCount).toBe(done.executions.reduce((n, ex) => n + (ex.usage?.requestCount ?? 0), 0));
expect(done.executions.every((ex) => (ex.usage?.requestCount ?? 0) >= 1)).toBe(true);

const devUsage = multi.executions.find((ex) => ex.stage === "dev_in_progress")!.usage!;
expect(devUsage.requestCount).toBe(5); // two contract requests + one bad-output retry + two implementation requests

expect(retried.usage.requestCount).toBeGreaterThan(failed.usage.requestCount);
```

- [ ] **Step 2: Run focused E2E tests and verify RED**

Run: `corepack pnpm --filter @pipeline/gateway test -- test/e2e.test.ts`

Expected: FAIL because executions and pipelines do not yet persist runner usage.

- [ ] **Step 3: Make the orchestrator depend only on `AgentRunner`**

Replace the concrete `DshRunner` type in `OrchestratorDeps` with `AgentRunner`. Use `run.status === "ok" && run.exitCode === 0 && run.parsed` as the success condition.

- [ ] **Step 4: Persist usage on all ordinary stage outcomes**

Create an `AgentResult` before dispatch for both success and error. On error, save it in `agents[stage]`, append an error `PipelineExecution` with `usage`, recompute `Pipeline.usage = mergeUsage(...executions.map(e => e.usage))`, then transition to failed. On success, attach the same usage to Agent result and execution before recomputing the pipeline summary.

- [ ] **Step 5: Merge every multi-Agent child invocation**

Change `MultiRunResult` to always carry `usage: AgentUsage`. Each contract attempt, bad-output retry and implementation attempt contributes its runner usage through `mergeUsage`. A partial failure returns the accumulated usage so `fail()` persists it.

- [ ] **Step 6: Derive history stats from executions**

In `buildHistory`, compute:

```ts
const usage = mergeUsage(...p.executions.map((execution) => execution.usage));
```

Return it as `stats.usage`, and use it to tolerate old pipeline snapshots whose top-level `usage` is absent. Ensure saves normalize top-level usage from executions.

- [ ] **Step 7: Run E2E and HTTP tests**

Run: `corepack pnpm --filter @pipeline/gateway test -- test/e2e.test.ts test/http.test.ts`

Expected: PASS, including usage counts for multi-Agent and retry cases.

- [ ] **Step 8: Commit**

```bash
git add apps/gateway/src/pipeline apps/gateway/src/http/server.ts apps/gateway/test/e2e.test.ts apps/gateway/test/http.test.ts
git commit -m "feat: aggregate usage across pipeline executions"
```

---

### Task 4: Unified Mock Agent and Both Runtime Protocols

**Files:**
- Create: `scripts/mock-agent.mjs`
- Delete: `scripts/mock-dsh.mjs`
- Modify: `apps/gateway/test/e2e.test.ts`
- Modify: `apps/gateway/test/http.test.ts`
- Create: `apps/gateway/test/mock-agent.test.ts`

**Interfaces:**
- Produces: one executable test double that detects OpenCode `run` arguments or Codex `exec` arguments and emits the matching JSONL event protocol.
- Preserves: every existing `MOCK_*` business and failure switch.

- [ ] **Step 1: Write failing executable behavior tests**

Spawn `scripts/mock-agent.mjs` once with OpenCode arguments and once with Codex arguments. Assert each process exits zero, the OpenCode stream contains `text` and `step_finish`, the Codex stream contains `thread.started`, `item.completed` and `turn.completed`, and both final Agent messages contain the same evaluator JSON.

- [ ] **Step 2: Run the mock test and verify RED**

Run: `corepack pnpm --filter @pipeline/gateway test -- test/mock-agent.test.ts`

Expected: FAIL because `scripts/mock-agent.mjs` does not exist.

- [ ] **Step 3: Port role behavior and emit runtime-specific JSONL**

Parse the payload after OpenCode options or as the final Codex prompt. Keep artifact creation and state ticks from `mock-dsh.mjs`. Emit fixed usage per model completion:

```js
const usage = { input: 100, output: 30, reasoning: 10, cache: { read: 300, write: 20 } };
```

OpenCode emits `text` followed by `step_finish` with `sessionID`, `tokens` and `cost: 0.001`. Codex emits `thread.started`, `item.completed` and `turn.completed` with `input_tokens: 400`, `cached_input_tokens: 300`, `output_tokens: 40`, `reasoning_output_tokens: 10`, and `cache_write_input_tokens: 20`.

- [ ] **Step 4: Point all harnesses to the unified executable**

Use `MOCK_AGENT = join(REPO_ROOT, "scripts", "mock-agent.mjs")`, set `AGENT_CLI: MOCK_AGENT`, `AGENT_TIMEOUT_MS: "60000"`, and select runtime per test. Run one complete pipeline for each runtime and retain the larger existing suite on OpenCode.

- [ ] **Step 5: Run mock, E2E and HTTP tests**

Run: `corepack pnpm --filter @pipeline/gateway test -- test/mock-agent.test.ts test/e2e.test.ts test/http.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/mock-agent.mjs apps/gateway/test
git rm scripts/mock-dsh.mjs
git commit -m "test: unify mock agent runtime protocols"
```

---

### Task 5: Web Usage Presentation

**Files:**
- Modify: `apps/gateway/public/app.js`
- Modify: `apps/gateway/public/style.css`
- Modify: `apps/gateway/public/index.html`
- Modify: `apps/gateway/src/http/server.ts`
- Modify: `apps/gateway/test/http.test.ts`

**Interfaces:**
- Consumes: `Pipeline.usage` and `buildHistory(p).stats.usage`.
- Produces: runtime configuration rows, pipeline list summary, detail usage cards and per-execution usage columns.

- [ ] **Step 1: Write failing HTTP contract assertions**

```ts
expect(config).toMatchObject({ agentRuntime: "opencode", agentCli: MOCK_AGENT, agentTimeoutMs: 60000, codexSandbox: "workspace-write" });
expect(detail.usage).toMatchObject({ requestCount: expect.any(Number), cacheHitRate: expect.any(Number) });
expect(history.stats.usage.requestCount).toBe(detail.usage.requestCount);
```

- [ ] **Step 2: Run HTTP tests and verify RED**

Run: `corepack pnpm --filter @pipeline/gateway test -- test/http.test.ts`

Expected: FAIL because configuration and usage fields are not exposed under the new names.

- [ ] **Step 3: Expose sanitized runtime configuration**

Return `agentRuntime`, `agentCli`, `agentModel`, `agentTimeoutMs`, and `codexSandbox` from `/api/config`. Render them in the configuration table and header badge.

- [ ] **Step 4: Render pipeline and execution usage**

Add browser helpers:

```js
const fmtTokens = (n) => Number(n || 0).toLocaleString("zh-CN");
const fmtCost = (n) => n == null ? "—" : `$${Number(n).toFixed(4)}`;
const fmtHitRate = (n) => `${(Number(n || 0) * 100).toFixed(1)}%`;
```

Add list columns for requests, Token and cost. Add a detail grid with the five Token counters, cache hit rate, requests, sessions, models and cost. Add requests/Token/cost columns to execution history. Use text escaping for session and model values.

- [ ] **Step 5: Run HTTP tests and manually inspect static output structure**

Run: `corepack pnpm --filter @pipeline/gateway test -- test/http.test.ts && corepack pnpm --filter @pipeline/gateway typecheck`

Expected: PASS with no browser JavaScript syntax errors when `node --check apps/gateway/public/app.js` is run.

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/public apps/gateway/src/http/server.ts apps/gateway/test/http.test.ts
git commit -m "feat: display agent usage in web console"
```

---

### Task 6: Legacy Removal, Documentation and Full Verification

**Files:**
- Delete: `profiles/headless/`
- Delete: `scripts/install-headless-profile.sh`
- Modify: `scripts/demo-run.sh`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/deployment.md`
- Modify: `docs/usage.md`
- Modify: `docs/real-project-guide.md`
- Modify: `docs/testing.md`

**Interfaces:**
- Documents the exact environment variables and commands implemented in Tasks 1–5.
- Leaves no DSH, headless profile, `mock-dsh.mjs`, `DSH_CLI`, or `DSH_AGENT_TIMEOUT_MS` reference.

- [ ] **Step 1: Capture the legacy-reference check before cleanup**

Run:

```bash
rg -n "DSH|DshRunner|dsh |mock-dsh|headless profile|profiles/headless|install-headless" README.md .env.example apps scripts docs profiles
```

Expected: matches identify every legacy reference that must be removed.

- [ ] **Step 2: Remove legacy files and update the demo script**

Delete the profile tree and installer. Change `demo-run.sh` to derive `AGENT_CLI` from `AGENT_RUNTIME`, verify `<cli> --version`, start the gateway and submit the demo without installing external files.

- [ ] **Step 3: Rewrite environment and user documentation**

Document these exact examples:

```dotenv
AGENT_RUNTIME=opencode
AGENT_CLI=opencode
AGENT_MODEL=anthropic/claude-sonnet-4-20250514
AGENT_TIMEOUT_MS=600000
CODEX_SANDBOX=workspace-write
```

and:

```dotenv
AGENT_RUNTIME=codex
AGENT_CLI=codex
AGENT_MODEL=gpt-5
AGENT_TIMEOUT_MS=600000
CODEX_SANDBOX=workspace-write
```

Explain AgentRunner/provider flow, normalized usage formulas, unknown cost behavior, multi-Agent/retry aggregation, Web fields, mock-agent testing and Codex sandbox implications in the named README and docs files.

- [ ] **Step 4: Verify all legacy references are gone**

Run:

```bash
rg -n "DSH|DshRunner|dsh |mock-dsh|headless profile|profiles/headless|install-headless|DSH_CLI|DSH_AGENT_TIMEOUT_MS" README.md .env.example apps scripts docs profiles || true
```

Expected: no output. Also run `test ! -e profiles/headless && test ! -e scripts/install-headless-profile.sh && test ! -e scripts/mock-dsh.mjs`.

- [ ] **Step 5: Run full verification**

Run:

```bash
corepack pnpm test
corepack pnpm typecheck
corepack pnpm build
node --check apps/gateway/public/app.js
git diff --check
```

Expected: every command exits zero with no warnings attributable to the change.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "docs: document generic agent runtimes and usage"
```
