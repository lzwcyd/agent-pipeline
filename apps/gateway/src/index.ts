import { join } from "node:path";
import { existsSync } from "node:fs";
import { config as dotenvConfig } from "dotenv";
import { loadConfig, resolveRepoRoot } from "./config.js";
import { DshRunner } from "./agents/dsh-runner.js";
import { createFormSources } from "./forms/index.js";
import { PipelineStore } from "./pipeline/store.js";
import { Orchestrator } from "./pipeline/orchestrator.js";
import { TemplateRegistry, loadTemplate } from "./pipeline/template.js";
import { AgentRegistry } from "./agents/registry.js";
import { CompositeNotifier } from "./notify/notifier.js";
import { createLogger } from "./logger.js";
import { buildCli } from "./cli/index.js";

async function main() {
  // .env 位于仓库根（pnpm 会把脚本 cwd 设到包目录，需显式定位）
  dotenvConfig({ path: join(resolveRepoRoot(), ".env") });
  const cfg = loadConfig();
  const logger = createLogger({ level: cfg.LOG_LEVEL, logsDir: cfg.logsDir });

  // Agent 定义注册表：内置 6 个 + config/agents/*.json 自定义扩展
  const agentRegistry = new AgentRegistry({ dir: join(cfg.repoRoot, "config", "agents") });

  // 模板注册表：扫描 config/pipelines/*.json 全量注册（校验 agent 存在性）
  const registry = new TemplateRegistry({ dir: cfg.templatesDir, validAgents: agentRegistry.names() });
  // 兼容旧配置：PIPELINE_TEMPLATE 为文件路径时注册为额外模板并设为默认；否则视为模板名
  let defaultTemplate = "default";
  if (cfg.PIPELINE_TEMPLATE) {
    if (existsSync(cfg.defaultTemplate)) {
      const t = loadTemplate(cfg.defaultTemplate);
      try {
        registry.save(t.name, t.stages);
        defaultTemplate = t.name;
        logger.info({ template: t.name, file: cfg.defaultTemplate }, "registered template from PIPELINE_TEMPLATE path");
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, "PIPELINE_TEMPLATE 注册失败，使用默认模板");
      }
    } else {
      defaultTemplate = cfg.PIPELINE_TEMPLATE;
      if (!registry.has(defaultTemplate)) {
        logger.warn({ template: defaultTemplate }, "默认模板不存在，回退到 default");
        defaultTemplate = "default";
      }
    }
  }
  logger.info({ templates: registry.names(), agents: agentRegistry.names(), defaultTemplate }, "platform registries loaded");

  const notifier = new CompositeNotifier(cfg);
  const store = new PipelineStore(cfg.pipelinesDir);
  const runner = new DshRunner({ cli: cfg.DSH_CLI, timeoutMs: cfg.DSH_AGENT_TIMEOUT_MS, logger });
  const sources = createFormSources(cfg);
  const orchestrator = new Orchestrator({ cfg, store, runner, notifier, registry, agentRegistry, defaultTemplate, logger });

  // 平台中断恢复：启动后自动续跑未完成的流水线（后台执行）
  void orchestrator.resumePending().then((n) => {
    if (n > 0) logger.info({ resumed: n }, "pending pipelines resumed");
  });

  const program = buildCli({ cfg, store, orchestrator, runner, sources, notifier, logger, registry, agentRegistry, defaultTemplate });
  program.parseAsync(process.argv).catch((err) => {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, "cli error");
    process.exitCode = 1;
  });
}

void main();
