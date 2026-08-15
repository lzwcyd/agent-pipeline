import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { loadConfig } from "../src/config.js";
import { DshRunner } from "../src/agents/dsh-runner.js";
import { PipelineStore } from "../src/pipeline/store.js";
import { Orchestrator } from "../src/pipeline/orchestrator.js";
import { CompositeNotifier } from "../src/notify/notifier.js";
import { createLogger } from "../src/logger.js";
import { createFormSources } from "../src/forms/index.js";
import { createApp, type ServerDeps } from "../src/http/server.js";
import { DEFAULT_TEMPLATE } from "../src/pipeline/template.js";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const MOCK_DSH = join(REPO_ROOT, "scripts", "mock-dsh.mjs");

interface HttpHarness {
  baseUrl: string;
  deps: ServerDeps;
  close: () => Promise<void>;
}

async function makeHttpHarness(env: Record<string, string> = {}): Promise<HttpHarness> {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-http-"));
  const prev = { ...process.env };
  Object.assign(process.env, {
    DSH_CLI: MOCK_DSH,
    DSH_AGENT_TIMEOUT_MS: "60000",
    AUTO_ACCEPT: "true",
    MAX_REWORK: "3",
    PIPELINE_DATA_DIR: dir,
    NOTIFY_CHANNELS: "console",
    ...env,
  });
  const cfg = loadConfig();
  const logger = createLogger({ level: "info", logsDir: cfg.logsDir });
  const store = new PipelineStore(cfg.pipelinesDir);
  const notifier = new CompositeNotifier(cfg);
  const runner = new DshRunner({ cli: cfg.DSH_CLI, timeoutMs: cfg.DSH_AGENT_TIMEOUT_MS, logger });
  const sources = createFormSources(cfg);
  const orchestrator = new Orchestrator({ cfg, store, runner, notifier, template: DEFAULT_TEMPLATE, logger });
  const deps: ServerDeps = { cfg, store, orchestrator, sources, template: DEFAULT_TEMPLATE, logger };
  const app = createApp(deps);
  const server: Server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    deps,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      process.env = prev;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function waitPipeline(baseUrl: string, id: string, timeoutMs = 30000): Promise<Record<string, unknown>> {
  const start = Date.now();
  for (;;) {
    const res = await fetch(`${baseUrl}/api/pipelines/${id}`);
    const p = (await res.json()) as Record<string, unknown>;
    if (["done", "rejected", "failed"].includes(String(p.status))) return p;
    if (Date.now() - start > timeoutMs) throw new Error(`等待流水线 ${id} 超时`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

describe("HTTP API 集成测试（mock DSH runner）", () => {
  let h: HttpHarness;
  beforeEach(async () => {
    h = await makeHttpHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("GET /healthz", async () => {
    const res = await fetch(`${h.baseUrl}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("POST /api/pipelines 标准接口触发 → 202 → 全链路 done", async () => {
    const res = await fetch(`${h.baseUrl}/api/pipelines`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "HTTP 集成测试需求",
        description: "验证标准接口触发链路。",
        submitter: "测试",
        priority: "P2",
      }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { pipelineId: string; status: string };
    expect(body.status).toBe("submitted");

    const p = await waitPipeline(h.baseUrl, body.pipelineId);
    expect(p.status).toBe("done");
    const sub = p.submission as { source: string; meta: { triggerType: string } };
    expect(sub.source).toBe("api");
    expect(sub.meta.triggerType).toBe("api");
  });

  it("POST /api/mock/submit → 202 → done，且 history/logs/templates 可查询", async () => {
    const res = await fetch(`${h.baseUrl}/api/mock/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "模拟表单需求", description: "描述" }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { pipelineId: string };
    const p = await waitPipeline(h.baseUrl, body.pipelineId);
    expect(p.status).toBe("done");

    // history：结构完整
    const histRes = await fetch(`${h.baseUrl}/api/pipelines/${body.pipelineId}/history`);
    const hist = (await histRes.json()) as {
      status: string;
      template: string;
      executions: unknown[];
      events: unknown[];
      stats: { totalExecutions: number; stages: Record<string, unknown> };
    };
    expect(hist.status).toBe("done");
    expect(hist.template).toBe("default");
    expect(hist.executions.length).toBeGreaterThanOrEqual(6);
    expect(hist.events.length).toBeGreaterThan(0);
    expect(hist.stats.totalExecutions).toBe(hist.executions.length);
    expect(hist.stats.stages.evaluating).toBeTruthy();

    // events
    const evRes = await fetch(`${h.baseUrl}/api/pipelines/${body.pipelineId}/events`);
    const ev = (await evRes.json()) as { events: unknown[] };
    expect(ev.events.length).toBeGreaterThan(0);

    // templates
    const tplRes = await fetch(`${h.baseUrl}/api/templates`);
    const tpl = (await tplRes.json()) as { name: string; stages: unknown[] };
    expect(tpl.name).toBe("default");
    expect(tpl.stages.length).toBeGreaterThanOrEqual(7);

    // logs：agent 调用日志可查
    const logRes = await fetch(`${h.baseUrl}/api/logs?lines=200&pipelineId=${body.pipelineId}`);
    const logs = (await logRes.json()) as { entries: Array<{ pipelineId?: string; msg?: string }> };
    expect(logs.entries.length).toBeGreaterThan(0);
    expect(logs.entries.every((e) => e.pipelineId === body.pipelineId)).toBe(true);
  });

  it("飞书 URL 验证：challenge 应答", async () => {
    const res = await fetch(`${h.baseUrl}/webhooks/feishu`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challenge: "abc-123", token: "t", type: "url_verification" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { challenge: string };
    expect(body.challenge).toBe("abc-123");
  });

  it("非法负载：POST /api/pipelines 缺 title → 400", async () => {
    const res = await fetch(`${h.baseUrl}/api/pipelines`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "没有标题" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("title");
  });

  it("accept/retry 在错误状态下的防护", async () => {
    const res = await fetch(`${h.baseUrl}/api/pipelines/not-exist/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accepted: true }),
    });
    expect(res.status).toBe(400);
  });

  it("AUTO_ACCEPT=false：验收通过后停在等待，accept 接口放行到 done", async () => {
    await h.close();
    h = await makeHttpHarness({ AUTO_ACCEPT: "false" });
    const res = await fetch(`${h.baseUrl}/api/pipelines`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "人工验收需求", description: "验证 accept 接口" }),
    });
    const body = (await res.json()) as { pipelineId: string };

    // 等待进入验收等待
    const start = Date.now();
    let p = {} as Record<string, unknown>;
    for (;;) {
      const r = await fetch(`${h.baseUrl}/api/pipelines/${body.pipelineId}`);
      p = (await r.json()) as Record<string, unknown>;
      if (p.status === "awaiting_acceptance" || ["done", "rejected", "failed"].includes(String(p.status))) break;
      if (Date.now() - start > 30000) throw new Error("等待验收超时");
      await new Promise((r2) => setTimeout(r2, 300));
    }
    expect(p.status).toBe("awaiting_acceptance");
    expect(p.acceptancePending).toBe(true);

    // 产品人工确认通过
    const accRes = await fetch(`${h.baseUrl}/api/pipelines/${body.pipelineId}/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accepted: true, by: "产品-测试", note: "确认" }),
    });
    expect(accRes.status).toBe(200);

    const done = await waitPipeline(h.baseUrl, body.pipelineId);
    expect(done.status).toBe("done");
    expect(done.deploy).toHaveProperty("prod");
  });
});
