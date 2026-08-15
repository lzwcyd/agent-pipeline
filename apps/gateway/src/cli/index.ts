import { Command } from "commander";
import type { EnvConfig } from "../config.js";
import type { Orchestrator } from "../pipeline/orchestrator.js";
import type { PipelineStore } from "../pipeline/store.js";
import type { DshRunner } from "../agents/dsh-runner.js";
import type { FormSource } from "../forms/index.js";
import type { Notifier } from "../notify/notifier.js";
import { startServer } from "../http/server.js";
import { buildHistory } from "../pipeline/history.js";
import type { PipelineTemplate } from "../pipeline/template.js";
import type { AppLogger } from "../logger.js";

export interface CliDeps {
  cfg: EnvConfig;
  store: PipelineStore;
  orchestrator: Orchestrator;
  runner: DshRunner;
  sources: Record<"mock" | "feishu" | "dingtalk" | "api", FormSource>;
  notifier: Notifier;
  logger: AppLogger;
  template: PipelineTemplate;
}

export function buildCli(deps: CliDeps): Command {
  const program = new Command();
  program
    .name("pipeline-gateway")
    .description("agent-pipeline：多 Agent 研发交付流水线网关")
    .version("0.1.0");

  program
    .command("serve")
    .description("启动 HTTP 服务（webhook + 流水线 API）")
    .option("-p, --port <port>", "监听端口", String(deps.cfg.PORT))
    .action((opts: { port: string }) => {
      const server = startServer(deps, Number(opts.port));
      const port = Number(opts.port);
      server.listen(port, () => {
        // eslint-disable-next-line no-console
        console.log(`🚀 pipeline-gateway 已启动：http://127.0.0.1:${port}`);
        console.log(`   模拟提交：POST /api/mock/submit`);
        console.log(`   飞书 webhook：POST /webhooks/feishu`);
        console.log(`   钉钉 webhook：POST /webhooks/dingtalk`);
        console.log(`   流水线列表：GET /api/pipelines`);
      });
    });

  program
    .command("simulate")
    .description("模拟一次表单提交（走同一编排流水线）")
    .requiredOption("-t, --title <title>", "需求标题")
    .option("-d, --description <desc>", "需求描述", "")
    .option("-s, --submitter <name>", "提交人", "模拟产品")
    .option("--source <source>", "mock|feishu|dingtalk", "mock")
    .option("--fields <json>", "附加字段 JSON", "{}")
    .action(async (opts: { title: string; description: string; submitter: string; source: string; fields: string }) => {
      const submission = deps.sources.mock.parse({
        title: opts.title,
        description: opts.description,
        submitter: opts.submitter,
        fields: JSON.parse(opts.fields),
        sourceFormId: `cli-${opts.source}`,
      });
      const pipeline = deps.orchestrator.startSubmission(submission);
      // eslint-disable-next-line no-console
      console.log(`流水线 ${pipeline.id} 已启动，等待执行完成……`);
      const finished = await deps.orchestrator.awaitPipeline(pipeline.id, deps.cfg.DSH_AGENT_TIMEOUT_MS * 6);
      // eslint-disable-next-line no-console
      console.log(`流水线 ${pipeline.id} 终态：${finished.status}`);
      await deps.notifier.close();
    });

  program
    .command("template")
    .description("查看当前流程模板（阶段序列与 agent 配置）")
    .action(() => {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(deps.template, null, 2));
    });

  const pipelines = program.command("pipelines").description("流水线管理");

  pipelines
    .command("list")
    .description("列出流水线")
    .action(() => {
      const list = deps.store.list();
      // eslint-disable-next-line no-console
      console.table(
        list.map((p) => ({
          id: p.id.slice(0, 8),
          status: p.status,
          title: p.submission.title.slice(0, 40),
          source: p.submission.source,
          updated: p.updatedAt.slice(0, 19).replace("T", " "),
        })),
      );
    });

  pipelines
    .command("show <id>")
    .description("查看流水线详情")
    .action((id: string) => {
      const p = deps.store.get(id);
      if (!p) throw new Error(`流水线不存在：${id}`);
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(p, null, 2));
    });

  pipelines
    .command("history <id>")
    .description("查看流水线当前状态与历史执行信息")
    .action((id: string) => {
      const p = deps.store.get(id);
      if (!p) throw new Error(`流水线不存在：${id}`);
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(buildHistory(p), null, 2));
    });

  pipelines
    .command("accept <id>")
    .description("产品人工验收通过")
    .option("-b, --by <name>", "验收人", "产品")
    .option("-n, --note <note>", "备注")
    .action(async (id: string, opts: { by: string; note?: string }) => {
      const p = await deps.orchestrator.productDecision(id, true, opts.by, opts.note);
      // eslint-disable-next-line no-console
      console.log(`流水线 ${id} 状态：${p.status}`);
      await deps.notifier.close();
    });

  pipelines
    .command("reject <id>")
    .description("产品人工验收拒绝")
    .option("-b, --by <name>", "验收人", "产品")
    .option("-n, --note <note>", "备注", "不通过")
    .action(async (id: string, opts: { by: string; note: string }) => {
      const p = await deps.orchestrator.productDecision(id, false, opts.by, opts.note);
      // eslint-disable-next-line no-console
      console.log(`流水线 ${id} 状态：${p.status}`);
      await deps.notifier.close();
    });

  pipelines
    .command("retry <id>")
    .description("失败后重试失败阶段")
    .action(async (id: string) => {
      const p = await deps.orchestrator.retry(id);
      // eslint-disable-next-line no-console
      console.log(`流水线 ${id} 状态：${p.status}`);
      await deps.notifier.close();
    });

  return program;
}
