import type { EnvConfig } from "../config.js";
import { ApiTriggerSource } from "./api.js";
import { DingTalkFormSource } from "./dingtalk.js";
import { FeishuFormSource } from "./feishu.js";
import { MockFormSource } from "./mock.js";
import type { FormSource } from "./types.js";

/** 表单/触发源注册表：按配置构建可用源 */
export function createFormSources(cfg: EnvConfig): Record<"mock" | "feishu" | "dingtalk" | "api", FormSource> {
  return {
    mock: new MockFormSource(),
    feishu: new FeishuFormSource({
      encryptKey: cfg.FEISHU_ENCRYPT_KEY,
      verificationToken: cfg.FEISHU_VERIFICATION_TOKEN,
    }),
    dingtalk: new DingTalkFormSource({
      appKey: cfg.DINGTALK_APP_KEY,
      appSecret: cfg.DINGTALK_APP_SECRET,
    }),
    api: new ApiTriggerSource(),
  };
}

export type { FormSource } from "./types.js";
export { FormParseError, SOURCE_LABEL } from "./types.js";
