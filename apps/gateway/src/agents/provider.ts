import type { EnvConfig } from "../config.js";
import type { AppLogger } from "../logger.js";
import { CodexRunner } from "./codex-runner.js";
import { OpenCodeRunner } from "./opencode-runner.js";
import type { AgentRunner } from "./runner.js";

export function createAgentRunner(cfg: EnvConfig, logger?: AppLogger): AgentRunner {
  const common = { cli: cfg.AGENT_CLI, model: cfg.AGENT_MODEL, timeoutMs: cfg.AGENT_TIMEOUT_MS, logger };
  return cfg.AGENT_RUNTIME === "codex"
    ? new CodexRunner({ ...common, sandbox: cfg.CODEX_SANDBOX })
    : new OpenCodeRunner(common);
}
