import { createCipheriv, createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FeishuFormSource, decryptAesCbc } from "../src/forms/feishu.js";
import { DingTalkFormSource } from "../src/forms/dingtalk.js";
import { FormParseError } from "../src/forms/types.js";

/** 与 feishu.ts 中解密互逆的加密（测试夹具用） */
function encryptAesCbc(encryptKey: string, plain: string): string {
  const key = Buffer.from(encryptKey, "base64");
  const iv = key.subarray(0, 16);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]).toString("base64");
}

const ENCRYPT_KEY = Buffer.alloc(32, 7).toString("base64"); // 固定 32 字节

describe("飞书适配器", () => {
  it("加密模式：验签 + 解密 + 解析表单事件", () => {
    const inner = {
      schema: "2.0",
      header: {
        event_id: "evt_001",
        event_type: "app.table.record.created",
        token: "t",
        create_time: "2026-08-15T10:00:00Z",
        app_id: "cli_app",
      },
      event: {
        table_id: "tbl_001",
        record_id: "rec_001",
        user_id: "ou_123",
        fields: { 标题: "新增导出功能", 描述: "支持 CSV/Excel", 提交人: "张三" },
      },
    };
    const rawBody = JSON.stringify({ encrypt: encryptAesCbc(ENCRYPT_KEY, JSON.stringify(inner)) });
    const timestamp = "1700000000";
    const nonce = "n1";
    const signature = createHash("sha256")
      .update(`${timestamp}${nonce}${ENCRYPT_KEY}${rawBody}`)
      .digest("base64");

    const src = new FeishuFormSource({ encryptKey: ENCRYPT_KEY });
    const payload = src.verifyAndDecrypt(
      {
        "x-lark-request-timestamp": timestamp,
        "x-lark-request-nonce": nonce,
        "x-lark-signature": signature,
      },
      rawBody,
    );
    const sub = src.parse(payload);
    expect(sub.source).toBe("feishu");
    expect(sub.title).toBe("新增导出功能");
    expect(sub.description).toBe("支持 CSV/Excel");
    expect(sub.submitter).toBe("张三");
    expect(sub.sourceFormId).toBe("tbl_001");
    expect(sub.submissionId).toBe("rec_001");
  });

  it("加密模式：签名被篡改时抛错", () => {
    const inner = { header: { event_type: "x" }, event: {} };
    const rawBody = JSON.stringify({ encrypt: encryptAesCbc(ENCRYPT_KEY, JSON.stringify(inner)) });
    const src = new FeishuFormSource({ encryptKey: ENCRYPT_KEY });
    expect(() =>
      src.verifyAndDecrypt(
        { "x-lark-request-timestamp": "1", "x-lark-request-nonce": "2", "x-lark-signature": "bad" },
        rawBody,
      ),
    ).toThrow(FormParseError);
  });

  it("URL 验证：返回 challenge", () => {
    const src = new FeishuFormSource({ verificationToken: "vt" });
    const payload = src.verifyAndDecrypt({}, JSON.stringify({ challenge: "abc123", token: "vt", type: "url_verification" }));
    expect((payload as { challenge: string }).challenge).toBe("abc123");
  });

  it("URL 验证：token 不匹配抛错", () => {
    const src = new FeishuFormSource({ verificationToken: "vt" });
    expect(() => src.verifyAndDecrypt({}, JSON.stringify({ challenge: "x", token: "wrong" }))).toThrow(FormParseError);
  });

  it("decryptAesCbc 与加密互逆", () => {
    const plain = JSON.stringify({ a: 1, b: "中文" });
    expect(decryptAesCbc(ENCRYPT_KEY, encryptAesCbc(ENCRYPT_KEY, plain))).toBe(plain);
  });
});

describe("钉钉适配器", () => {
  const SECRET = "SECabc123";
  function sign(timestamp: string): string {
    return createHmac("sha256", SECRET).update(`${timestamp}\n${SECRET}`).digest("base64");
  }

  it("验签通过并解析表单字段", () => {
    const body = JSON.stringify({
      EventType: "form_submit",
      formInstanceId: "inst_001",
      staffId: "u_001",
      formValues: [
        { name: "需求标题", value: "订单导出优化" },
        { name: "需求描述", value: "导出超过 1 万行时速度过慢" },
      ],
    });
    const timestamp = "1700000000";
    const src = new DingTalkFormSource({ appKey: "key", appSecret: SECRET });
    const payload = src.verify({ timestamp, sign: sign(timestamp) }, body);
    const sub = src.parse(payload);
    expect(sub.source).toBe("dingtalk");
    expect(sub.title).toBe("订单导出优化");
    expect(sub.description).toBe("导出超过 1 万行时速度过慢");
    expect(sub.submitter).toBe("u_001");
    expect(sub.sourceFormId).toBe("inst_001");
  });

  it("签名错误抛 FormParseError", () => {
    const src = new DingTalkFormSource({ appKey: "key", appSecret: SECRET });
    expect(() => src.verify({ timestamp: "1", sign: "bad" }, "{}")).toThrow(FormParseError);
  });

  it("缺少请求头抛错", () => {
    const src = new DingTalkFormSource({ appKey: "key", appSecret: SECRET });
    expect(() => src.verify({}, "{}")).toThrow(/缺少 timestamp\/sign/);
  });
});
