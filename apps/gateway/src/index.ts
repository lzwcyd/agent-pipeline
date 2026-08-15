import "dotenv/config";
import { loadConfig } from "./config.js";
import { DshRunner } from "./agents/dsh-runner.js";
import { createFormSources } from "./forms/index.js";
import { PipelineStore } from "./pipeline/store.js";
import { Orchestrator } from "./pipeline/orchestrator.js";
import { CompositeNotifier } from "./notify/notifier.js";
import { buildCli } from "./cli/index.js";

async function main() {
  const cfg = loadConfig();
  const notifier = new CompositeNotifier(cfg);
  const store = new PipelineStore(cfg.pipelinesDir);
  const runner = new DshRunner({ cli: cfg.DSH_CLI, timeoutMs: cfg.DSH_AGENT_TIMEOUT_MS });
  const sources = createFormSources(cfg);
  const orchestrator = new Orchestrator({
    cfg,
    store,
    runner,
    notifier,
  });

  const program = buildCli({ cfg, store, orchestrator, runner, sources, notifier });
  program.parseAsync(process.argv).catch((err) => {
    // eslint-disable-next-line no-console
    console.error("发生错误：", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}

void main();
