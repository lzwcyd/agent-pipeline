#!/usr/bin/env node
// 模拟 dsh headless agent：读取 task JSON（位置参数），按角色输出固定 JSON。
// 用于端到端测试与无 LLM 的演示。调用方式与真实 dsh 一致：
//   mock-dsh.mjs --profile headless '<task-json>'
// 行为开关（环境变量）：
//   MOCK_REJECT=1                评估阶段返回不通过
//   MOCK_TEST_FAIL=1             测试阶段返回不通过（打回开发）
//   MOCK_TEST_FAIL_ONCE=1        测试阶段第一次不通过，之后通过（模拟修复）
//   MOCK_ACCEPT_REJECT=1         验收阶段返回不通过（触发回滚+打回）
//   MOCK_ACCEPT_REJECT_ONCE=1    验收阶段第一次不通过，之后通过
//   MOCK_OPS_FAIL=1              运维部署返回失败
//   MOCK_ROLLBACK_FAIL=1         回滚动作返回失败
// once 类开关用 artifactsDir 下的状态文件按流水线计数。
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
let taskArg = "";
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--profile") {
    i += 1;
    continue;
  }
  taskArg = args[i] ?? "";
  break;
}

let task;
try {
  task = JSON.parse(taskArg);
} catch {
  console.error("mock-dsh: 无法解析 task JSON");
  process.exit(1);
}

const { role, artifactsDir } = task;

// 开发产物：模拟开发 agent 写入文件
if (role === "developer" && artifactsDir) {
  mkdirSync(artifactsDir, { recursive: true });
  writeFileSync(
    join(artifactsDir, "dev-plan.md"),
    `# 开发计划\n\n## 需求\n${task.requirement?.title ?? "-"}\n\n## 任务拆解\n1. 实现核心逻辑\n2. 补充单元测试\n\n## 打回修复\n${task.context?.reworkFeedback ? `针对问题：${task.context.reworkFeedback.reason}` : "无"}\n`,
  );
  writeFileSync(
    join(artifactsDir, "change-notes.md"),
    `# 变更说明\n\n- feat: 新增需求相关能力（模拟）\n`,
  );
  writeFileSync(
    join(artifactsDir, "tests.md"),
    `# 测试计划\n\n- unit: 核心逻辑单测\n- e2e: 冒烟用例\n`,
  );
}

/** 按流水线计数（once 开关用）：读文件 → 返回当前值并 +1 写回 */
function tickState(file) {
  let n = 0;
  try {
    n = Number(readFileSync(file, "utf8")) || 0;
  } catch {
    /* first time */
  }
  writeFileSync(file, String(n + 1));
  return n;
}

const responses = {
  evaluator: {
    approved: !process.env.MOCK_REJECT,
    score: process.env.MOCK_REJECT ? 30 : 88,
    reasons: process.env.MOCK_REJECT
      ? ["需求描述不完整，缺少验收标准"]
      : ["需求清晰可执行", "影响范围可控", "优先级合理"],
    missingInfo: process.env.MOCK_REJECT ? ["验收标准", "关联系统"] : [],
    suggestedPriority: "P1",
  },
  developer: {
    status: "ok",
    plan: "按模块拆解为 3 个任务，先核心逻辑后测试。",
    changes: [
      { file: "src/feature.ts", summary: "新增需求核心逻辑" },
      { file: "src/feature.test.ts", summary: "补充单元测试" },
    ],
    tests: [
      { name: "核心逻辑单测", type: "unit", command: "pnpm test", result: "passed" },
      { name: "冒烟用例", type: "e2e", command: "pnpm e2e", result: "planned" },
    ],
    version: "v1.1.0",
    notes: "模拟开发完成。",
  },
  tester: (() => {
    const first = tickState(join(artifactsDir ?? ".", ".mock-tester-state"));
    const fail =
      process.env.MOCK_TEST_FAIL === "1" ||
      (process.env.MOCK_TEST_FAIL_ONCE === "1" && first === 0);
    return {
      status: fail ? "fail" : "pass",
      summary: fail
        ? `第 ${first + 1} 轮测试：核心用例失败（模拟）`
        : "全部用例通过，覆盖全部需求验收点（模拟）",
      testCases: [
        { name: "核心功能用例", type: "unit", result: fail ? "failed" : "passed" },
        { name: "边界与异常用例", type: "integration", result: fail ? "failed" : "passed" },
        { name: "端到端冒烟", type: "e2e", result: "planned" },
      ],
      coverage: "需求验收点全覆盖（模拟）",
      issues: fail ? ["核心功能行为与需求描述不一致（模拟）", "异常分支缺少处理（模拟）"] : [],
      evidence: fail ? [] : ["用例执行结果全部通过（模拟）"],
    };
  })(),
  ops: (() => {
    const isRollback = task?.context?.ops?.action === "rollback";
    const env = task?.context?.deployTarget?.environment === "prod" ? "prod" : "test";
    const ns = isRollback
      ? task?.context?.rollback?.deployInfo?.namespace ?? "demo-test"
      : task?.context?.deployTarget?.namespace ?? "demo-test";
    if (isRollback) {
      return {
        deployed: process.env.MOCK_ROLLBACK_FAIL !== "1",
        mode: "simulated",
        namespace: ns,
        revision: "v1.0.0（回滚目标）",
        url: "http://test-demo-app.demo-test.svc.cluster.local/",
        evidence: process.env.MOCK_ROLLBACK_FAIL === "1"
          ? ["回滚失败（模拟）：镜像拉取超时"]
          : [`kubectl rollout undo deployment/test-demo-app -n demo-test （模拟）`, "已回滚到上一稳定版本 v1.0.0"],
        warnings: [],
      };
    }
    return process.env.MOCK_OPS_FAIL
      ? { deployed: false, mode: "simulated", namespace: ns, revision: "-", url: "", evidence: ["部署失败（模拟）"], warnings: ["资源不足"] }
      : {
          deployed: true,
          mode: "simulated",
          namespace: ns,
          revision: task?.context?.deployTarget?.version ?? "v1.1.0",
          url: `http://${env}-demo-app.${ns}.svc.cluster.local/`,
          evidence: [
            `kubectl apply -k k8s/demo-app/overlays/${env} （模拟）`,
            "Pod Ready 1/1",
            `namespace: ${ns}`,
          ],
          warnings: [],
        };
  })(),
  acceptance: (() => {
    const first = tickState(join(artifactsDir ?? ".", ".mock-accept-state"));
    const reject =
      process.env.MOCK_ACCEPT_REJECT === "1" ||
      (process.env.MOCK_ACCEPT_REJECT_ONCE === "1" && first === 0);
    return {
      accepted: !reject,
      verdicts: [
        { item: "需求覆盖", result: "pass" },
        { item: "测试通过", result: "pass" },
        { item: "部署健康检查", result: "pass" },
      ],
      issues: reject ? ["UI 交互不符合需求预期（模拟）"] : [],
      note: reject ? "建议打回补充实现。" : "验收通过。",
    };
  })(),
};

console.log(JSON.stringify(responses[role] ?? { error: `unknown role: ${role}` }));
