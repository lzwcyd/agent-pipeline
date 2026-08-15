#!/usr/bin/env node
// 向运行中的网关发送一次模拟表单提交（等价于 POST /api/mock/submit）。
// 用法：
//   node scripts/simulate-submit.mjs --title "..." [--description "..."] [--submitter 产品] [--port 3081]
import { argv } from "node:process";

const args = argv.slice(2);
const get = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] ?? fallback : fallback;
};

const port = get("--port", "3081");
const payload = {
  title: get("--title", "演示需求：增加报表导出功能"),
  description:
    get("--description", "在管理后台增加报表导出能力，支持 CSV/Excel 两种格式，导出数据量上限 10 万行。"),
  submitter: get("--submitter", "产品-张三"),
  fields: JSON.parse(get("--fields", "{}")),
};

const res = await fetch(`http://127.0.0.1:${port}/api/mock/submit`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});
const body = await res.json();
console.log(`HTTP ${res.status}`, body);
if (!res.ok) process.exit(1);
