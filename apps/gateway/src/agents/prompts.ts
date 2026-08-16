/**
 * Agent 公共规则。
 * 所有角色都要求“只输出一个 JSON 对象”（无其他解释文字），网关据此驱动状态机。
 */

const COMMON_RULES = `
规则：
1. 只输出一个合法的 JSON 对象，不要输出 JSON 以外的任何文字、不要用代码围栏。
2. JSON 必须严格匹配给定的 schema（所有字段齐全）。
3. 你可以使用 bash/文件工具查看上下文，但最终答案只通过 stdout 的 JSON 给出。
`;

export const COMMON_RULES_TEXT = COMMON_RULES;
