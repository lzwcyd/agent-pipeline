/** 表单来源类型 */
export type FormSourceKind = "mock" | "feishu" | "dingtalk";

/** 触发类型：不限于表单 */
export type TriggerType = "form" | "api" | "schedule" | "manual" | "cli";

/** 触发元信息（标准触发结构的一部分） */
export interface TriggerMeta {
  /** 触发类型 */
  triggerType: TriggerType;
  /** 附加说明（如 “http-api v1”） */
  detail?: string;
}

/** 触发级流水线策略（可覆盖环境变量默认值） */
export interface SubmissionPolicy {
  /** 验收失败时的处理：rollback（回滚测试环境后打回开发）| rework（直接打回开发）| reject（直接终止） */
  acceptanceFailure?: "rollback" | "rework" | "reject";
  /** 验收预检通过后是否自动放行（覆盖 AUTO_ACCEPT） */
  autoAccept?: boolean;
  /** 打回开发上限（覆盖 MAX_REWORK） */
  maxRework?: number;
}

/** 一次标准化后的触发/提交（无论来源：表单、API、CLI…） */
export interface FormSubmission {
  /** 来源标识 */
  source: FormSourceKind | "api";
  /** 收集单/触发源 ID */
  sourceFormId: string;
  /** 单次提交 ID */
  submissionId: string;
  /** 提交人 */
  submitter: string;
  submitterId?: string;
  /** 需求标题 */
  title: string;
  /** 需求描述 */
  description: string;
  /** 建议优先级（如 P0/P1/P2，可选） */
  priority?: string;
  /** 原始字段 */
  fields: Record<string, unknown>;
  /** 提交时间 ISO */
  submittedAt: string;
  /** 触发元信息 */
  meta: TriggerMeta;
  /** 触发级策略（可选，覆盖环境变量） */
  policy?: SubmissionPolicy;
  /** 原始事件负载 */
  raw: unknown;
}

/** 流水线阶段（进行中的状态） */
export type StageKey =
  | "evaluating"
  | "dev_in_progress"
  | "testing"
  | "test_deploying"
  | "awaiting_acceptance"
  | "test_rollback"
  | "prod_deploying";

/** 流水线状态 */
export type PipelineStatus = StageKey | "submitted" | "rejected" | "failed" | "done";

/** 流水线事件（追加日志，供审计/展示） */
export type PipelineEvent =
  | { type: "submitted"; at: string }
  | { type: "stage_started"; stage: string; at: string }
  | { type: "stage_succeeded"; stage: string; at: string }
  | { type: "stage_failed"; stage: string; at: string; message: string }
  | { type: "rejected"; at: string; reason: string }
  | { type: "acceptance_verdict"; accepted: boolean; at: string }
  | { type: "product_decision"; accepted: boolean; by: string; note?: string; at: string }
  | { type: "rework"; from: string; reason: string; at: string }
  | { type: "retried"; stage: string; at: string }
  | { type: "done"; at: string };

/** 单个 Agent 的执行记录 */
export interface AgentResult {
  stage: StageKey;
  status: "ok" | "error";
  startedAt: string;
  finishedAt: string;
  /** 解析后的结构化输出（JSON） */
  output?: Record<string, unknown>;
  /** 原始 stdout */
  rawOutput?: string;
  error?: string;
}

/** Agent 在 artifacts 目录中产出的文件 */
export interface ArtifactFile {
  stage: StageKey;
  path: string;
  summary?: string;
}

export interface DeployInfo {
  mode: "kubectl" | "simulated";
  namespace: string;
  revision: string;
  url: string;
  evidence: string[];
  deployedAt: string;
}

export interface AcceptanceVerdict {
  accepted: boolean;
  verdicts: { item: string; result: "pass" | "fail" | "warn" }[];
  issues: string[];
  note?: string;
  at: string;
}

/** 一条需求流水线 */
export interface Pipeline {
  id: string;
  status: PipelineStatus;
  submission: FormSubmission;
  createdAt: string;
  updatedAt: string;
  events: PipelineEvent[];
  /** 各阶段 agent 结果，key = stage */
  agents: Partial<Record<StageKey, AgentResult>>;
  /** agent 产出的文件 */
  artifacts: ArtifactFile[];
  evaluation?: { approved: boolean; score?: number; reasons: string[]; suggestedPriority?: string };
  deploy?: { test?: DeployInfo; prod?: DeployInfo };
  acceptance?: AcceptanceVerdict;
  failure?: { stage: string; message: string };
  /** 人工验收决策是否待定（AUTO_ACCEPT=false 时） */
  acceptancePending?: boolean;
  /** 因测试/验收未通过被打回开发的次数（上限 MAX_REWORK） */
  reworkCount?: number;
  /** 每次阶段执行的历史记录（含打回后的多轮执行） */
  executions: PipelineExecution[];
}

/** 一次阶段执行记录（历史信息） */
export interface PipelineExecution {
  /** 阶段标识 */
  stage: string;
  /** 该阶段第几次执行（打回重跑会递增） */
  round: number;
  status: "ok" | "error";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** 成功时的结构化输出（JSON） */
  output?: Record<string, unknown>;
  /** 失败原因 */
  error?: string;
}

/** Agent 任务的统一入参（会整体作为 headless 任务的 task 文本） */
export interface AgentTask {
  pipelineId: string;
  role: "evaluator" | "developer" | "tester" | "ops" | "acceptance";
  stage: StageKey;
  requirement: {
    title: string;
    description: string;
    submitter: string;
    fields: Record<string, unknown>;
    priority?: string;
  };
  context: Record<string, unknown>;
  instructions: string;
  outputSchema: string;
  artifactsDir: string;
}
