import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

/** 从当前工作目录向上查找仓库根（含 pnpm-workspace.yaml 的目录） */
export function resolveRepoRoot(from = process.cwd()): string {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("未找到仓库根（缺少 pnpm-workspace.yaml）");
    dir = parent;
  }
}

const envSchema = z.object({
  PORT: z.coerce.number().default(3081),
  PIPELINE_DATA_DIR: z.string().default("data"),
  DSH_CLI: z.string().default("dsh"),
  DSH_AGENT_TIMEOUT_MS: z.coerce.number().default(600_000),
  AUTO_ACCEPT: z
    .string()
    .default("true")
    .transform((v) => v !== "false" && v !== "0"),
  OPS_MODE: z.enum(["auto", "kubectl", "simulated"]).default("auto"),
  /** 部署目标：auto（配了 SSH 主机则 ssh，否则 k8s）| k8s | ssh（KVM/传统服务器） */
  OPS_TARGET: z.enum(["auto", "k8s", "ssh"]).default("auto"),
  /** SSH 部署配置（target=ssh 时使用） */
  OPS_SSH_HOST: z.string().optional(),
  OPS_SSH_USER: z.string().default("root"),
  OPS_SSH_PORT: z.coerce.number().default(22),
  OPS_SSH_DEPLOY_DIR: z.string().default("/opt/my-app"),
  OPS_SSH_SERVICE: z.string().default("my-app"),
  /** 构建产物路径/glob（相对 dev 产物目录，如 dist/、target/*.jar） */
  OPS_SSH_ARTIFACT: z.string().default("dist"),
  PIPELINE_MODE: z.enum(["simulation", "real"]).default("simulation"),
  /** 验收失败时的默认处理：rollback（回滚测试环境后打回开发）| rework（直接打回开发）| reject（直接终止） */
  ACCEPTANCE_FAILURE_POLICY: z.enum(["rollback", "rework", "reject"]).default("rollback"),
  /** 测试/验收未通过打回开发的最大次数，超限终止 */
  MAX_REWORK: z.coerce.number().default(3),
  /** 默认模板名（缺省 default）。也可指向 JSON 文件路径（兼容旧配置，注册为同名模板并设为默认） */
  PIPELINE_TEMPLATE: z.string().optional(),
  /** 模板注册目录（扫描 *.json 全量注册，Web 保存也写入这里） */
  PIPELINE_TEMPLATES_DIR: z.string().default("config/pipelines"),
  /** 真实工程工作区（相对仓库根）：目标工程目录放这里，开发 Agent 可读写 */
  DEV_WORKSPACE_DIR: z.string().default("data/workspace"),
  /** 目标工程目录名（相对 DEV_WORKSPACE_DIR，real 模式下开发 Agent 的工作仓库） */
  DEV_PROJECT_DIR: z.string().optional(),
  /** 运维清单目录（相对仓库根；缺省 k8s/demo-app） */
  OPS_MANIFESTS_DIR: z.string().default("k8s/demo-app"),
  /** 测试/生产命名空间（缺省 demo-test / demo-prod） */
  OPS_TEST_NAMESPACE: z.string().default("demo-test"),
  OPS_PROD_NAMESPACE: z.string().default("demo-prod"),
  /** 日志级别：trace|debug|info|warn|error */
  LOG_LEVEL: z.string().default("info"),
  NOTIFY_CHANNELS: z.string().default("console"),
  NOTIFY_FEISHU_WEBHOOK_URL: z.string().optional(),
  NOTIFY_FEISHU_SECRET: z.string().optional(),
  NOTIFY_DINGTALK_WEBHOOK_URL: z.string().optional(),
  NOTIFY_DINGTALK_SECRET: z.string().optional(),
  FEISHU_ENCRYPT_KEY: z.string().optional(),
  FEISHU_VERIFICATION_TOKEN: z.string().optional(),
  FEISHU_APP_ID: z.string().optional(),
  FEISHU_APP_SECRET: z.string().optional(),
  DINGTALK_APP_KEY: z.string().optional(),
  DINGTALK_APP_SECRET: z.string().optional(),
});

export type EnvConfig = ReturnType<typeof loadConfig>;

/** 统一配置入口：环境变量 + 仓库根路径解析 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`环境变量配置无效：${detail}`);
  }
  const repoRoot = resolveRepoRoot();
  const dataDir = resolve(repoRoot, parsed.data.PIPELINE_DATA_DIR);
  return {
    ...parsed.data,
    repoRoot,
    dataDir,
    pipelinesDir: join(dataDir, "pipelines"),
    artifactsRoot: join(dataDir, "artifacts"),
    logsDir: join(dataDir, "logs"),
    k8sManifestsDir: join(repoRoot, "k8s", "demo-app"),
    // 模板注册目录相对仓库根解析
    templatesDir: resolve(repoRoot, parsed.data.PIPELINE_TEMPLATES_DIR),
    devWorkspaceDir: resolve(repoRoot, parsed.data.DEV_WORKSPACE_DIR),
    devProjectDir: parsed.data.DEV_PROJECT_DIR,
    opsManifestsDir: resolve(repoRoot, parsed.data.OPS_MANIFESTS_DIR),
    opsTestNamespace: parsed.data.OPS_TEST_NAMESPACE,
    opsProdNamespace: parsed.data.OPS_PROD_NAMESPACE,
    // 兼容旧配置：PIPELINE_TEMPLATE 为文件路径时注册为额外模板；否则视为默认模板名
    defaultTemplate: parsed.data.PIPELINE_TEMPLATE ? resolve(repoRoot, parsed.data.PIPELINE_TEMPLATE) : "default",
  };
}
