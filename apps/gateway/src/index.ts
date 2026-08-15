import "dotenv/config";
import { loadConfig } from "./config.js";
import { DshRunner } from "./agents/dsh-runner.js";
import { createFormSources } from "./forms/index.js";
import { PipelineStore } from "./pipeline/store.js";
import { Orchestrator } from "./pipeline/orchestrator.js";
import { loadTemplate } from "./pipeline/template.js";
import { CompositeNotifier } from "./notify/notifier.js";
import { createLogger } from "./logger.js";
import { buildCli } from "./cli/index.js";

async function main() {
  const cfg = loadConfig();
  const logger = createLogger({ level: cfg.LOG_LEVEL, logsDir: cfg.logsDir });
  const template = loadTemplate(cfg.pipelineTemplateFile);
  logger.info({ template: template.name, templateFile: cfg.pipelineTemplateFile ?? "builtin-default" }, "pipeline template loaded");

  const notifier = new CompositeNotifier(cfg);
  const store = new PipelineStore(cfg.pipelinesDir);
  const runner = new DshRunner({ cli: cfg.DSH_CLI, timeoutMs: cfg.DSH_AGENT_TIMEOUT_MS, logger });
  const sources = createFormSources(cfg);
  const orchestrator = new Orchestrator({ cfg, store, runner, notifier, template, logger });

  const program = buildCli({ cfg, store, orchestrator, runner, sources, notifier, logger, template });
  program.parseAsync(process.argv).catch((err) => {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, "cli error");
    process.exitCode = 1;
  });
}

void main();
