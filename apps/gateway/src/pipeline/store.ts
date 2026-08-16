import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Pipeline } from "../types.js";

/**
 * 流水线持久化：data/pipelines/<id>.json，原子写（tmp + rename）。
 * 不做并发控制（单网关进程内串行编排），每个 id 独立文件。
 */
export class PipelineStore {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  create(submission: Pipeline["submission"], templateName = "default", templateSnapshot?: unknown): Pipeline {
    const now = new Date().toISOString();
    const pipeline: Pipeline = {
      id: randomUUID(),
      status: "submitted",
      templateName,
      templateSnapshot,
      submission,
      createdAt: now,
      updatedAt: now,
      events: [{ type: "submitted", at: now }],
      agents: {},
      artifacts: [],
      executions: [],
    };
    this.save(pipeline);
    return pipeline;
  }

  save(pipeline: Pipeline): void {
    const file = this.path(pipeline.id);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(pipeline, null, 2), "utf8");
    renameSync(tmp, file);
  }

  get(id: string): Pipeline | undefined {
    try {
      const raw = readFileSync(this.path(id), "utf8");
      return JSON.parse(raw) as Pipeline;
    } catch {
      return undefined;
    }
  }

  list(): Pipeline[] {
    const files = readdirSync(this.dir).filter((f) => f.endsWith(".json"));
    const pipelines = files
      .map((f) => {
        try {
          return JSON.parse(readFileSync(join(this.dir, f), "utf8")) as Pipeline;
        } catch {
          return undefined;
        }
      })
      .filter((p): p is Pipeline => p !== undefined);
    return pipelines.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private path(id: string): string {
    return join(this.dir, `${id}.json`);
  }
}
