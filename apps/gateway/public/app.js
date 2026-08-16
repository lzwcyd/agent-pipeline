/* agent-pipeline Web 控制台 —— 原生 JS，无构建 */
"use strict";

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtTime = (iso) => (iso ? String(iso).replace("T", " ").slice(0, 19) : "-");
const fmtDur = (ms) => (ms == null ? "-" : ms >= 60000 ? `${(ms / 60000).toFixed(1)}min` : `${Math.round(ms)}s`);
const statusClass = (s) => (s === "done" ? "st-done" : ["rejected", "failed"].includes(s) ? "st-rejected" : "st-submitted");

async function api(path, opts) {
  const res = await fetch(path, opts);
  let body = null;
  try { body = await res.json(); } catch { /* 非 JSON */ }
  if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
  return body;
}

/* ── 页签切换 ─────────────────────────────────────────────── */
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    btn.classList.add("active");
    $("#tab-" + btn.dataset.tab).classList.add("active");
    if (btn.dataset.tab === "progress") loadPipelines();
    if (btn.dataset.tab === "config") loadConfig();
  });
});

/* ── 触发页签 ─────────────────────────────────────────────── */
async function loadTemplateSelect() {
  try {
    const { default: defName, templates } = await api("/api/templates");
    const sel = $("#template-select");
    sel.innerHTML = `<option value="">（默认模板：${esc(defName)}）</option>` +
      templates.filter((t) => t.name !== defName).map((t) => `<option value="${esc(t.name)}">${esc(t.name)}</option>`).join("");
  } catch { /* ignore */ }
}

$("#trigger-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const payload = {
    title: f.title.value.trim(),
    description: f.description.value.trim(),
    submitter: f.submitter.value.trim() || "产品",
  };
  if (f.priority.value) payload.priority = f.priority.value;
  if (f.template.value) payload.template = f.template.value;
  try {
    if (f.fields.value.trim()) payload.fields = JSON.parse(f.fields.value);
    if (f.policy.value.trim()) payload.policy = JSON.parse(f.policy.value);
  } catch (err) {
    showResult("#trigger-result", `JSON 解析失败：${err.message}`, true);
    return;
  }
  try {
    const r = await api("/api/pipelines", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    showResult("#trigger-result", `✅ 已提交，流水线 ${r.pipelineId} 启动（${r.status}）\n点击「进度与日志」页签查看。`, false);
    f.reset();
  } catch (err) {
    showResult("#trigger-result", `❌ 提交失败：${err.message}`, true);
  }
});
function showResult(sel, text, isErr) {
  const el = $(sel);
  el.textContent = text;
  el.className = "result " + (isErr ? "err" : "ok");
}

/* ── 配置页签 ─────────────────────────────────────────────── */
async function loadConfig() {
  try {
    const [cfg, tpl] = await Promise.all([api("/api/config"), api("/api/templates")]);
    $("#cfg-badge").textContent = `默认模板：${cfg.template} · 模板数：${tpl.templates.length} · ${cfg.pipelineMode} · OPS:${cfg.opsMode} · 端口 ${cfg.port}`;
    const rows = [
      ["流程模板", cfg.template],
      ["流水线模式", cfg.pipelineMode],
      ["验收失败策略", cfg.acceptanceFailurePolicy],
      ["自动验收", cfg.autoAccept],
      ["打回上限", cfg.maxRework],
      ["OPS 模式", cfg.opsMode + (cfg.kubectlAvailable ? "（kubectl 可用）" : "（模拟部署）")],
      ["日志级别", cfg.logLevel],
      ["触发源", Object.entries(cfg.sources).filter(([, v]) => v).map(([k]) => k).join(" / ") || "无"],
    ];
    $("#config-table").innerHTML = rows
      .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`)
      .join("");
    renderTemplateList(tpl);
  } catch (err) {
    $("#cfg-badge").textContent = "配置加载失败";
  }
}

/* 模板列表管理 */
let currentTpl = null;

function renderTemplateList(tpl) {
  currentTpl = tpl;
  const sel = $("#template-list");
  sel.innerHTML = tpl.templates
    .map((t) => `<option value="${esc(t.name)}" ${t.name === tpl.default ? "selected" : ""}>${esc(t.name)}${t.name === tpl.default ? "（默认）" : ""}${t.builtin ? "（内置）" : ""}</option>`)
    .join("");
  const def = tpl.templates.find((t) => t.name === tpl.default) || tpl.templates[0];
  if (def) selectTemplate(def);
  // 触发页模板下拉同步
  loadTemplateSelect();
}

function selectTemplate(t) {
  $("#template-name").value = t.name;
  $("#template-name").disabled = t.builtin; // 内置 default 不可改名/覆盖
  $("#template-editor").value = JSON.stringify(t.stages, null, 2);
  $("#template-delete").disabled = t.builtin;
  $("#template-delete").dataset.name = t.name;
}

$("#template-list").addEventListener("change", async (e) => {
  const name = e.target.value;
  const t = currentTpl?.templates.find((x) => x.name === name);
  if (t) selectTemplate(t);
});

$("#template-new").addEventListener("click", () => {
  $("#template-name").value = "my-template";
  $("#template-name").disabled = false;
  $("#template-editor").value = JSON.stringify(
    (currentTpl?.templates.find((t) => t.name === currentTpl.default) || currentTpl?.templates[0] || { stages: [] }).stages,
    null, 2,
  );
  $("#template-delete").disabled = true;
});

$("#template-save").addEventListener("click", async () => {
  const msg = $("#template-msg");
  const name = $("#template-name").value.trim();
  let stages;
  try {
    stages = JSON.parse($("#template-editor").value);
  } catch (err) {
    msg.textContent = `❌ 模板 JSON 解析失败：${err.message}`;
    msg.className = "result inline err";
    return;
  }
  msg.textContent = "保存中…";
  try {
    const r = await api("/api/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, stages }),
    });
    msg.textContent = `✅ ${r.note}`;
    msg.className = "result inline ok";
    loadConfig();
  } catch (err) {
    msg.textContent = `❌ ${err.message}`;
    msg.className = "result inline err";
  }
});

$("#template-delete").addEventListener("click", async () => {
  const name = $("#template-delete").dataset.name;
  if (!name) return;
  if (!confirm(`确定删除模板「${name}」？删除后无法恢复。`)) return;
  try {
    await api(`/api/templates/${name}`, { method: "DELETE" });
    loadConfig();
    loadTemplateSelect();
  } catch (err) {
    alert(`删除失败：${err.message}`);
  }
});

/* ── 进度与日志页签 ───────────────────────────────────────── */
let selectedId = null;
let pollTimer = null;

$("#refresh").addEventListener("click", () => { loadPipelines(); if (selectedId) loadDetail(selectedId); });

async function loadPipelines() {
  try {
    const { pipelines } = await api("/api/pipelines");
    const tb = $("#pipeline-table tbody");
    tb.innerHTML = pipelines
      .map(
        (p) => `<tr data-id="${p.id}" class="row">
          <td class="mono">${p.id.slice(0, 8)}</td>
          <td>${esc(p.title.slice(0, 30))}</td>
          <td><span class="status ${statusClass(p.status)}">${p.status}</span></td>
          <td>${esc(p.source)}</td>
          <td>${p.reworkCount ?? 0}</td>
          <td class="muted">${fmtTime(p.updatedAt)}</td>
          <td><button class="sm" data-open="${p.id}">查看</button></td>
        </tr>`,
      )
      .join("");
    tb.querySelectorAll("[data-open]").forEach((b) =>
      b.addEventListener("click", () => { selectedId = b.dataset.open; loadDetail(selectedId); }),
    );
  } catch { /* 忽略瞬时错误 */ }
}

async function loadDetail(id) {
  const [p, logs] = await Promise.all([
    api(`/api/pipelines/${id}`),
    api(`/api/logs?lines=300&pipelineId=${id}`).catch(() => ({ entries: [] })),
  ]);
  const d = $("#detail");
  d.innerHTML = `
    <div class="card">
      <h2>流水线 ${p.id.slice(0, 8)} <span class="status ${statusClass(p.status)}">${p.status}</span>
        <span class="actions">
          ${p.status === "awaiting_acceptance" && p.acceptancePending ? `<button class="sm primary" id="act-accept">✅ 验收通过</button><button class="sm" id="act-reject">⛔ 拒绝</button>` : ""}
          ${p.status === "failed" ? `<button class="sm" id="act-retry">🔁 重试</button>` : ""}
        </span>
      </h2>
      <div class="detail-grid">
        <div>
          <b>${esc(p.submission.title)}</b>
          <div class="muted">提交人：${esc(p.submission.submitter)} · 来源：${esc(p.submission.source)} · 模板：${esc(p.templateName)}</div>
          <pre class="json">${esc(p.submission.description)}</pre>
        </div>
        <div>
          <b>事件流</b>
          <ul class="timeline">
            ${p.events.map((ev) => `<li><span class="t">${fmtTime(ev.at)}</span>${esc(ev.type)}${ev.stage ? " → " + esc(ev.stage) : ""}</li>`).join("")}
          </ul>
        </div>
        <div class="full">
          <b>执行历史（${p.executions.length} 次）</b>
          <table class="ex-table">
            <tr><th>阶段</th><th>轮次</th><th>结果</th><th>耗时</th><th>说明</th></tr>
            ${p.executions.map((ex) => {
              const out = ex.output || {};
              const note = ex.status === "error" ? (ex.error || "").slice(0, 60)
                : ex.stage === "dev_in_progress" && out.multi ? `多 Agent：${Object.keys(out.services || {}).join(",")}`
                : ex.stage === "testing" ? (out.status || "") : "";
              return `<tr><td class="mono">${esc(ex.stage)}</td><td>${ex.round}</td><td>${ex.status}</td><td>${fmtDur(ex.durationMs)}</td><td class="muted">${esc(note)}</td></tr>`;
            }).join("")}
          </table>
        </div>
        <div>
          <b>阶段 Agent 输出</b>
          <pre class="json">${esc(JSON.stringify(p.agents, null, 1).slice(0, 6000))}</pre>
        </div>
        <div>
          <b>实时日志（按流水线过滤）</b>
          <div class="logbox" id="logbox">
            ${logs.entries.map((e) => `<div class="lvl-${e.level}">[${fmtTime(e.time)}] ${esc(e.msg)}${e.role ? " · " + esc(e.role) : ""}${e.durationMs ? " · " + fmtDur(e.durationMs) : ""}</div>`).join("")}
          </div>
        </div>
      </div>
    </div>`;

  if (p.status === "awaiting_acceptance" && p.acceptancePending) {
    $("#act-accept").addEventListener("click", () => decide(id, true));
    $("#act-reject").addEventListener("click", () => decide(id, false));
  }
  if (p.status === "failed" && $("#act-retry")) {
    $("#act-retry").addEventListener("click", async () => {
      await api(`/api/pipelines/${id}/retry`, { method: "POST" });
      loadDetail(id);
    });
  }
  startLogPoll(id);
}

async function decide(id, accepted) {
  const note = prompt(accepted ? "验收备注（可选）" : "拒绝原因（必填）", accepted ? "确认验收通过" : "");
  if (note === null) return;
  try {
    await api(`/api/pipelines/${id}/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accepted, by: "Web 控制台", note }),
    });
    loadDetail(id);
    loadPipelines();
  } catch (err) { alert(`操作失败：${err.message}`); }
}

/* 详情打开后轮询日志（30s 停止），列表每 5s 刷新 */
function startLogPoll(id) {
  if (pollTimer) clearInterval(pollTimer);
  let rounds = 0;
  pollTimer = setInterval(async () => {
    rounds += 1;
    if (rounds > 6) { clearInterval(pollTimer); pollTimer = null; return; }
    try {
      const logs = await api(`/api/logs?lines=60&pipelineId=${id}`);
      const box = $("#logbox");
      if (box) {
        box.innerHTML = logs.entries.map((e) => `<div class="lvl-${e.level}">[${fmtTime(e.time)}] ${esc(e.msg)}${e.role ? " · " + esc(e.role) : ""}${e.durationMs ? " · " + fmtDur(e.durationMs) : ""}</div>`).join("");
        box.scrollTop = box.scrollHeight;
      }
    } catch { /* ignore */ }
  }, 5000);
}

/* 初始化 */
(async () => {
  try {
    const cfg = await api("/api/config");
    $("#cfg-badge").textContent = `模板：${cfg.template} · ${cfg.pipelineMode} · OPS:${cfg.opsMode} · 端口 ${cfg.port}`;
  } catch { /* 服务未完全就绪 */ }
  loadPipelines();
  loadTemplateSelect();
})();
