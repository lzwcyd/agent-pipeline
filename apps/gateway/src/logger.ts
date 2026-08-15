import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";

/**
 * 统一日志：pino 结构化 JSON，输出到 stdout + data/logs/pipeline.log。
 * 每条日志含时间戳；编排/agent 调用会附带 pipelineId/stage 等字段。
 */
export function createLogger(opts: { level: string; logsDir: string }) {
  mkdirSync(opts.logsDir, { recursive: true });
  const stream = pino.multistream([
    { stream: process.stdout },
    { stream: createWriteStream(join(opts.logsDir, "pipeline.log"), { flags: "a" }) },
  ]);
  return pino(
    {
      level: opts.level,
      timestamp: pino.stdTimeFunctions.isoTime,
      base: undefined,
    },
    stream,
  );
}

export type AppLogger = ReturnType<typeof createLogger>;
