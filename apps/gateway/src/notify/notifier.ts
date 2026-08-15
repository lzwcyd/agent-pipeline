import { createHmac, createHash } from "node:crypto";
import type { Pipeline } from "../types.js";
import type { EnvConfig } from "../config.js";

export type NotifyLevel = "info" | "success" | "warning" | "error";

export interface Notifier {
  /** 发送一条流水线通知 */
  notify(pipeline: Pipeline, title: string, body: string, level?: NotifyLevel): Promise<void>;
  close(): Promise<void>;
}

function feishuSign(secret: string, timestamp: string): string {
  return createHmac("sha256", `${timestamp}\n${secret}`).digest("base64");
}

function dingtalkSign(secret: string, timestamp: string): string {
  const stringToSign = `${timestamp}\n${secret}`;
  return createHash("sha256").update(stringToSign).digest("base64");
}

/** 组合通知器：console 永远启用，飞书/钉钉机器人按配置启用 */
export class CompositeNotifier implements Notifier {
  private readonly targets: Notifier[];

  constructor(private readonly cfg: EnvConfig) {
    const targets: Notifier[] = [new ConsoleNotifier()];
    const channels = cfg.NOTIFY_CHANNELS.split(",").map((s) => s.trim());
    if (channels.includes("feishu") && cfg.NOTIFY_FEISHU_WEBHOOK_URL) {
      targets.push(new FeishuNotifier(cfg.NOTIFY_FEISHU_WEBHOOK_URL, cfg.NOTIFY_FEISHU_SECRET));
    }
    if (channels.includes("dingtalk") && cfg.NOTIFY_DINGTALK_WEBHOOK_URL) {
      targets.push(new DingTalkNotifier(cfg.NOTIFY_DINGTALK_WEBHOOK_URL, cfg.NOTIFY_DINGTALK_SECRET));
    }
    this.targets = targets;
  }

  async notify(pipeline: Pipeline, title: string, body: string, level: NotifyLevel = "info"): Promise<void> {
    await Promise.allSettled(this.targets.map((t) => t.notify(pipeline, title, body, level)));
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.targets.map((t) => t.close()));
  }
}

export class ConsoleNotifier implements Notifier {
  async notify(_pipeline: Pipeline, title: string, body: string, level: NotifyLevel = "info"): Promise<void> {
    const tag = `[${level.toUpperCase()}]`;
    // eslint-disable-next-line no-console
    console.log(`${tag} ${title}\n${body.split("\n").map((l) => `      ${l}`).join("\n")}`);
  }
  async close(): Promise<void> {}
}

export class FeishuNotifier implements Notifier {
  constructor(
    private readonly webhookUrl: string,
    private readonly secret?: string,
  ) {}

  async notify(_pipeline: Pipeline, title: string, body: string): Promise<void> {
    const payload: Record<string, unknown> = {
      msg_type: "text",
      content: { text: `${title}\n${body}` },
    };
    if (this.secret) {
      const timestamp = String(Math.floor(Date.now() / 1000));
      payload.timestamp = timestamp;
      payload.sign = feishuSign(this.secret, timestamp);
    }
    const res = await fetch(this.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`飞书通知失败：HTTP ${res.status} ${await res.text()}`);
  }
  async close(): Promise<void> {}
}

export class DingTalkNotifier implements Notifier {
  constructor(
    private readonly webhookUrl: string,
    private readonly secret?: string,
  ) {}

  async notify(_pipeline: Pipeline, title: string, body: string): Promise<void> {
    const payload: Record<string, unknown> = {
      msgtype: "text",
      text: { content: `${title}\n${body}` },
    };
    let url = this.webhookUrl;
    if (this.secret) {
      const timestamp = Date.now();
      const sign = encodeURIComponent(dingtalkSign(this.secret, String(timestamp)));
      url = `${url}&timestamp=${timestamp}&sign=${sign}`;
    }
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`钉钉通知失败：HTTP ${res.status} ${await res.text()}`);
  }
  async close(): Promise<void> {}
}
