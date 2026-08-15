import { describe, expect, it } from "vitest";
import { MockFormSource } from "../src/forms/mock.js";
import { FeishuFormSource } from "../src/forms/feishu.js";
import { DingTalkFormSource } from "../src/forms/dingtalk.js";
import { ApiTriggerSource } from "../src/forms/api.js";
import { FormParseError, extractPolicy } from "../src/forms/types.js";
import { extractJson } from "../src/agents/dsh-runner.js";

describe("Mock 表单源", () => {
  it("解析最小负载（含标准 meta）", () => {
    const sub = new MockFormSource().parse({ title: "需求A", description: "描述A", submitter: "小张" });
    expect(sub.source).toBe("mock");
    expect(sub.title).toBe("需求A");
    expect(sub.submitter).toBe("小张");
    expect(sub.submissionId).toBeTruthy();
    expect(sub.meta.triggerType).toBe("form");
  });

  it("缺少 title 抛错", () => {
    expect(() => new MockFormSource().parse({ description: "x" })).toThrow(FormParseError);
  });
});

describe("标准接口触发（ApiTriggerSource）", () => {
  it("解析标准结构负载", () => {
    const sub = new ApiTriggerSource().parse({
      title: "接口需求",
      description: "描述",
      submitter: "调用方",
      priority: "P1",
      fields: { 模块: "后台" },
      policy: { acceptanceFailure: "rework" },
    });
    expect(sub.source).toBe("api");
    expect(sub.meta.triggerType).toBe("api");
    expect(sub.priority).toBe("P1");
    expect(sub.policy?.acceptanceFailure).toBe("rework");
    expect(sub.fields["模块"]).toBe("后台");
  });

  it("缺少 title 抛错", () => {
    expect(() => new ApiTriggerSource().parse({ description: "x" })).toThrow(FormParseError);
  });
});

describe("触发级策略提取（_policy）", () => {
  it("合法策略被解析", () => {
    expect(extractPolicy({ _policy: { acceptanceFailure: "rework", autoAccept: false, maxRework: 5 } })).toEqual({
      acceptanceFailure: "rework",
      autoAccept: false,
      maxRework: 5,
    });
  });

  it("非法值被忽略、空策略返回 undefined", () => {
    expect(extractPolicy({ _policy: { acceptanceFailure: "bad" } })).toBeUndefined();
    expect(extractPolicy({})).toBeUndefined();
    expect(extractPolicy({ _policy: "string" })).toBeUndefined();
  });

  it("mock 表单字段中携带 _policy 生效", () => {
    const sub = new MockFormSource().parse({
      title: "T",
      fields: { _policy: { acceptanceFailure: "reject" } },
    });
    expect(sub.policy?.acceptanceFailure).toBe("reject");
  });
});

describe("agent 输出 JSON 抽取", () => {
  it("纯 JSON", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("带围栏", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("前文+JSON", () => {
    expect(extractJson('结果如下：\n{"a":1}\n完毕')).toEqual({ a: 1 });
  });

  it("非法内容返回 null", () => {
    expect(extractJson("这不是 JSON")).toBeNull();
    expect(extractJson("")).toBeNull();
  });
});

describe("跨源归一化一致性", () => {
  it("同一需求在不同源下映射为相同结构", () => {
    const mock = new MockFormSource().parse({ title: "T", description: "D", submitter: "P" });
    const feishu = new FeishuFormSource({}).parse({
      header: { event_type: "app.table.record.created" },
      event: { fields: { title: "T", desc: "D", submitter: "P" } },
    });
    const dingtalk = new DingTalkFormSource({}).parse({
      formValues: [
        { name: "title", value: "T" },
        { name: "desc", value: "D" },
        { name: "submitter", value: "P" },
      ],
    });
    for (const sub of [mock, feishu, dingtalk]) {
      expect(sub.title).toBe("T");
      expect(sub.description).toBe("D");
      expect(sub.submitter).toBe("P");
    }
  });
});
