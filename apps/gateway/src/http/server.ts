import { openSync, readSync, statSync, closeSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import express, { type Request, type Response } from "express";
import type { EnvConfig } from "../config.js";
import type { FormSource } from "../forms/index.js";
import { FormParseError } from "../forms/index.js";
import type { Orchestrator } from "../pipeline/orchestrator.js";
import type { PipelineStore } from "../pipeline/store.js";
import type { PipelineTemplate } from "../pipeline/template.js";
import { parseTemplate } from "../pipeline/template.js";
import type { Pipeline } from "../types.js";
import { buildHistory } from "../pipeline/history.js";
import type { AppLogger } from "../logger.js";

export interface ServerDeps {
  cfg: EnvConfig;
  store: PipelineStore;
  orchestrator: Orchestrator;
  sources: Record<"mock" | "feishu" | "dingtalk" | "api", FormSource>;
  template: PipelineTemplate;
  logger: AppLogger;
}

/** 构造 Express 应用（不监听端口，便于测试） */
export function createApp(deps: ServerDeps) {
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  const publicDir = join(deps.cfg.repoRoot, "apps", "gateway", "public");

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, time: new Date().toISOString() });
  });

  // ── 静态 Web 控制台 ─────────────────────────────────────────────────────────
  app.use(express.static(publicDir));
  app.get("/", (_req, res) => {
    res.sendFile(join(publicDir, "index.html"));
  });

  // ── 脱敏配置查看（供 Web 控制台展示）───────────────────────────────────────
  app.get("/api/config", (_req, res) => {
    res.json({
      template: deps.template.name,
      port: deps.cfg.PORT,
      autoAccept: deps.cfg.AUTO_ACCEPT,
      acceptanceFailurePolicy: deps.cfg.ACCEPTANCE_FAILURE_POLICY,
      maxRework: deps.cfg.MAX_REWORK,
      pipelineMode: deps.cfg.PIPELINE_MODE,
      opsMode: deps.cfg.OPS_MODE,
      logLevel: deps.cfg.LOG_LEVEL,
      sources: {
        mock: deps.sources.mock.isConfigured(),
        feishu: deps.sources.feishu.isConfigured(),
        dingtalk: deps.sources.dingtalk.isConfigured(),
        api: deps.sources.api.isConfigured(),
      },
      kubectlAvailable: checkKubectl(),
      webUi: true,
    });
  });

  // ── 保存自定义流程模板（Web 控制台配置页）─────────────────────────────────
  app.post("/api/templates", (req: Request, res: Response) => {
    try {
      const { name, stages } = (req.body ?? {}) as { name?: string; stages?: unknown };
      if (!name || !Array.isArray(stages)) {
        res.status(400).json({ error: "需要 name（string）与 stages（数组）" });
        return;
      }
      const parsed = parseTemplate(name, stages);
      const target = join(deps.cfg.repoRoot, "config", "pipelines", "custom.json");
      writeFileSync(target, JSON.stringify(parsed, null, 2), "utf8");
      deps.logger.info({ template: parsed.name, file: target }, "custom template saved via web UI");
      res.json({
        ok: true,
        name: parsed.name,
        path: "config/pipelines/custom.json",
        note: "模板已保存。重启网关并设置 PIPELINE_TEMPLATE=config/pipelines/custom.json 生效（当前进程仍使用原模板）。",
      });
    } catch (err) {
      respondError(res, err);
    }
  });

  // ── 飞书事件订阅 ───────────────────────────────────────────────────────────
  app.post("/webhooks/feishu", (req: Request, res: Response) => {
    try {
      const raw = JSON.stringify(req.body ?? {});
      const feishu = deps.sources.feishu;
      if (!feishu.verifyAndDecrypt) throw new FormParseError("飞书适配器不支持验签模式");
      const payload = feishu.verifyAndDecrypt(
        req.headers as Record<string, string | string[] | undefined>,
        raw,
      );
      // URL 验证
      const asRecord = payload as Record<string, unknown>;
      if (asRecord.challenge !== undefined) {
        res.json({ challenge: asRecord.challenge });
        return;
      }
      const submission = deps.sources.feishu.parse(payload);
      void runAndRespond(deps, submission, res);
    } catch (err) {
      respondError(res, err);
    }
  });

  // ── 钉钉回调 ───────────────────────────────────────────────────────────────
  app.post("/webhooks/dingtalk", (req: Request, res: Response) => {
    try {
      const raw = JSON.stringify(req.body ?? {});
      const dingtalk = deps.sources.dingtalk;
      if (!dingtalk.verify) throw new FormParseError("钉钉适配器不支持验签模式");
      const payload = dingtalk.verify(
        req.headers as Record<string, string | string[] | undefined>,
        raw,
      );
      const submission = deps.sources.dingtalk.parse(payload);
      void runAndRespond(deps, submission, res);
    } catch (err) {
      respondError(res, err);
    }
  });

  // ── 模拟表单提交（开发/演示） ───────────────────────────────────────────────
  app.post("/api/mock/submit", (req: Request, res: Response) => {
    try {
      const submission = deps.sources.mock.parse(req.body);
      void runAndRespond(deps, submission, res);
    } catch (err) {
      respondError(res, err);
    }
  });

  // ── 标准接口触发 ───────────────────────────────────────────────────────────
  app.post("/api/pipelines", (req: Request, res: Response) => {
    try {
      const submission = deps.sources.api.parse(req.body);
      void runAndRespond(deps, submission, res);
    } catch (err) {
      respondError(res, err);
    }
  });

  // ── 流水线 API ─────────────────────────────────────────────────────────────
  app.get("/api/pipelines", (_req, res) => {
    const list = deps.store.list().map(summarize);
    res.json({ pipelines: list });
  });

  app.get("/api/pipelines/:id", (req, res) => {
    const p = deps.store.get(req.params.id);
    if (!p) {
      res.status(404).json({ error: `流水线不存在：${req.params.id}` });
      return;
    }
    res.json(p);
  });

  // ── 历史与状态查询 ─────────────────────────────────────────────────────────
  app.get("/api/pipelines/:id/history", (req, res) => {
    const p = deps.store.get(req.params.id);
    if (!p) {
      res.status(404).json({ error: `流水线不存在：${req.params.id}` });
      return;
    }
    res.json(buildHistory(p));
  });

  app.get("/api/pipelines/:id/events", (req, res) => {
    const p = deps.store.get(req.params.id);
    if (!p) {
      res.status(404).json({ error: `流水线不存在：${req.params.id}` });
      return;
    }
    res.json({ id: p.id, events: p.events });
  });

  // ── 流程模板 ───────────────────────────────────────────────────────────────
  app.get("/api/templates", (_req, res) => {
    res.json({
      name: deps.template.name,
      stages: deps.template.stages.map((s) => ({
        id: s.id,
        agent: s.agent,
        onSuccess: s.onSuccess,
        reworkTarget: s.reworkTarget,
        ops: s.ops,
        multi: s.multi,
      })),
    });
  });

  // ── 日志查询 ───────────────────────────────────────────────────────────────
  app.get("/api/logs", (req, res) => {
    try {
      const lines = Math.min(Math.max(Number(req.query.lines ?? 100), 1), 2000);
      const pipelineId = typeof req.query.pipelineId === "string" ? req.query.pipelineId : undefined;
      const level = typeof req.query.level === "string" ? req.query.level : undefined;
      const logFile = join(deps.cfg.logsDir, "pipeline.log");
      const entries = tailLogFile(logFile, lines);
      const filtered = entries.filter((e) => {
        if (pipelineId && e.pipelineId !== pipelineId) return false;
        if (level && e.level !== level) return false;
        return true;
      });
      res.json({ logFile, total: filtered.length, entries: filtered });
    } catch (err) {
      respondError(res, err, 500);
    }
  });

  // ── 验收与重试 ─────────────────────────────────────────────────────────────
  app.post("/api/pipelines/:id/accept", async (req, res) => {
    try {
      const { accepted, by, note } = (req.body ?? {}) as {
        accepted?: boolean;
        by?: string;
        note?: string;
      };
      const pipeline = await deps.orchestrator.productDecision(
        req.params.id,
        accepted === true,
        by ?? "产品",
        note,
      );
      res.json(summarize(pipeline));
    } catch (err) {
      respondError(res, err, 400);
    }
  });

  app.post("/api/pipelines/:id/retry", async (req, res) => {
    try {
      const pipeline = await deps.orchestrator.retry(req.params.id);
      res.json(summarize(pipeline));
    } catch (err) {
      respondError(res, err, 400);
    }
  });

  return app;
}

/** 读取日志文件末尾 N 行并解析为 JSON 条目 */
function tailLogFile(file: string, lines: number): Array<Record<string, unknown> & { level?: string; pipelineId?: string }> {
  const st = statSync(file);
  const size = st.size;
  const maxRead = 512 * 1024; // 最多读 512KB 尾部
  const start = Math.max(0, size - maxRead);
  const buf = Buffer.alloc(size - start);
  const fd = openSync(file, "r");
  try {
    readSync(fd, buf, 0, buf.length, start);
  } finally {
    closeSync(fd);
  }
  const rows = buf.toString("utf8").split("\n").filter((l) => l.trim() !== "");
  const tail = rows.slice(-lines);
  return tail
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown> & { level?: string; pipelineId?: string };
      } catch {
        return { raw: line.slice(0, 500) };
      }
    })
    .filter((e) => e && typeof e === "object");
}

function summarize(p: Pipeline) {
  return {
    id: p.id,
    status: p.status,
    title: p.submission.title,
    source: p.submission.source,
    submitter: p.submission.submitter,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    evaluation: p.evaluation,
    acceptance: p.acceptance,
    deploy: p.deploy,
    failure: p.failure,
    acceptancePending: p.acceptancePending,
    reworkCount: p.reworkCount,
  };
}

async function runAndRespond(
  deps: ServerDeps,
  submission: Parameters<Orchestrator["handleSubmission"]>[0],
  res: Response,
) {
  try {
    // 异步驱动：立即返回，流水线在后台执行
    const pipeline = deps.orchestrator.startSubmission(submission);
    res.status(202).json({ pipelineId: pipeline.id, status: pipeline.status, note: "流水线已启动，后台执行中" });
  } catch (err) {
    respondError(res, err, 500);
  }
}

function respondError(res: Response, err: unknown, status = 400) {
  if (err instanceof FormParseError) {
    res.status(status).json({ error: err.message });
    return;
  }
  res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
}

/** 探测 kubectl 是否可用（供 /api/config 展示部署模式） */
function checkKubectl(): boolean {
  try {
    const r = spawnSync("kubectl", ["version", "--client", "-o", "json"], { timeout: 5000, encoding: "utf8" });
    return r.status === 0;
  } catch {
    return false;
  }
}

/** 在指定端口启动服务 */
export function startServer(deps: ServerDeps, port: number) {
  const app = createApp(deps);
  return app.listen(port, "127.0.0.1");
}
