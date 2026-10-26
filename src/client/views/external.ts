/**
 * ============================================================
 * views/external.ts — 外部 Agent（第三方 Git 仓库接入）
 * ============================================================
 * 职责：外部 Agent 卡片渲染、接入流程（clone + 自动识别）、补全启动命令、
 * 凭证注入开关。
 * 设计立场：
 *  - 接入 = 在服务器上运行第三方代码：UI 明确警示，凭证注入默认关闭且二次确认；
 *  - 待补全启动命令的 Agent 标记为 ext-incomplete，点击先走补全流程；
 *  - 移除时提示 clone 缓存一并删除、已建会话无法继续。
 */

import { $ } from "../core/dom.js";
import { api } from "../core/api.js";
import { state } from "../core/state.js";
import { uiAlert, uiConfirm } from "../modules/ui-dialog.js";
import type { ExternalAgent, SessionKind } from "../modules/types.js";

/** 新建会话（由 turn 层注入，避免 external → stream 的环） */
let createSessionFn: (
  kind?: SessionKind | null, demo?: number | null, prefill?: string | null, agentId?: string
) => Promise<void> = async () => {};

export function bindCreateSession(fn: typeof createSessionFn): void {
  createSessionFn = fn;
}

export async function loadExternalAgents(): Promise<void> {
  try {
    const data = await api<{ agents?: ExternalAgent[] }>("/api/external-agents");
    state.externalAgents = data.agents || [];
  } catch {
    state.externalAgents = []; // 旧服务进程没有该接口 → 静默降级
  }
  renderExternalCards();
}

export function renderExternalCards(): void {
  const wrap = $("external-cards");
  if (!wrap) return;
  wrap.innerHTML = "";
  if (!state.externalAgents.length) {
    const empty = document.createElement("div");
    empty.className = "ext-empty";
    empty.textContent = "还没有接入外部 Agent —— 粘贴一个 Git 仓库地址即可（仓库里放一份 agent.json 说明如何启动效果最佳）";
    wrap.appendChild(empty);
    return;
  }
  for (const a of state.externalAgents) {
    const card = document.createElement("button");
    card.className = "demo-card ext-card" + (a.command ? "" : " ext-incomplete");
    card.type = "button";
    card.innerHTML = `
      <div class="d-head"><span class="d-num">🔌</span><span class="d-name"></span>
        <button class="ext-del" title="移除该外部 Agent">✕</button></div>
      <div class="d-desc"></div>
      <div class="d-eg"></div>`;
    const nameEl = card.querySelector(".d-name");
    if (nameEl) nameEl.textContent = a.name;
    const descEl = card.querySelector(".d-desc");
    if (descEl) descEl.textContent = a.description || a.url;
    const egEl = card.querySelector(".d-eg");
    if (egEl) egEl.textContent = a.command ? `$ ${a.command} ${a.args.join(" ")}` : "⚠ 待补全启动命令";
    card.querySelector(".ext-del")?.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!(await uiConfirm(`移除外部 Agent「${a.name}」？\n其 clone 缓存会一并删除；已创建的会话将无法继续发送。`, { title: "移除外部 Agent", okText: "移除", danger: true }))) return;
      try {
        const res = await api<{ agents?: ExternalAgent[] }>(`/api/external-agents/${a.id}`, { method: "DELETE" });
        state.externalAgents = res.agents || [];
        renderExternalCards();
      } catch (err) { uiAlert(`移除失败：${(err as Error).message}`, "外部 Agent"); }
    });
    // 🔑 凭证注入开关：高风险（网关 Key 会进入第三方仓库的子进程环境），强制二次确认
    card.addEventListener("contextmenu", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const next = !a.passCredentials;
      const ok = await uiConfirm(
        next
          ? `开启凭证注入？\n当前网关 API Key / 地址将进入「${a.name}」子进程的环境变量。\n只对可信、开源且看过代码的仓库开启！`
          : `关闭「${a.name}」的凭证注入？其后子进程将拿不到网关 Key。`,
        { title: "凭证注入", okText: next ? "开启" : "关闭", danger: next }
      );
      if (!ok) return;
      try {
        const res = await api<{ agent: ExternalAgent }>(`/api/external-agents/${a.id}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ passCredentials: next, confirmCredentials: true }),
        });
        const idx = state.externalAgents.findIndex((x) => x.id === a.id);
        if (idx >= 0) state.externalAgents[idx] = res.agent;
        renderExternalCards();
      } catch (err) { uiAlert(`设置失败：${(err as Error).message}`, "凭证注入"); }
    });
    card.addEventListener("click", async () => {
      try {
        if (!a.command) {
          await completeExternalAgent(a); // 待补全：先要一条启动命令
          return;
        }
        await createSessionFn("external", null, null, a.id);
      } catch (err) { uiAlert("创建外部 Agent 会话失败：" + (err as Error).message, "外部 Agent"); }
    });
    wrap.appendChild(card);
  }
}

/** 接入流程：Git 地址 → clone + 自动发现 → 必要时补启动命令 */
export async function addExternalFlow(): Promise<void> {
  const { uiPrompt } = await import("../modules/ui-dialog.js");
  const url = await uiPrompt(
    "输入第三方 Agent 的 Git 仓库地址：\n服务端会 clone 到本地并自动识别启动方式（agent.json > package.json > 常见入口）",
    { title: "接入外部 Agent", placeholder: "https://github.com/user/agent-repo" }
  );
  if (typeof url !== "string" || !url.trim()) return;
  const addBtn = $("add-external-btn") as HTMLButtonElement | null;
  const prevText = addBtn?.textContent;
  if (addBtn) { addBtn.disabled = true; addBtn.textContent = "⏳ 克隆中…（最长 2 分钟）"; }
  try {
    const res = await api<{ agents?: ExternalAgent[]; agent: ExternalAgent; hint?: string }>(
      "/api/external-agents",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      }
    );
    state.externalAgents = res.agents || [];
    renderExternalCards();
    if (res.agent.command) {
      await uiAlert(
        `已接入「${res.agent.name}」\n启动命令：${res.agent.command} ${res.agent.args.join(" ")}${res.hint ? `\n\n${res.hint}` : ""}`,
        "接入成功"
      );
    } else {
      await uiAlert(`仓库已 clone，但没有识别出启动方式。\n${res.hint || ""}`, "需要补全启动命令");
      await completeExternalAgent(res.agent);
    }
  } catch (err) {
    uiAlert(`接入失败：${(err as Error).message}`, "外部 Agent");
  } finally {
    if (addBtn) { addBtn.disabled = false; addBtn.textContent = prevText ?? "＋ 接入外部 Agent（Git 地址）"; }
  }
}

/** 为「待补全」的外部 Agent 询问并保存启动命令（如 node cli.js） */
async function completeExternalAgent(agent: ExternalAgent): Promise<void> {
  const { uiPrompt } = await import("../modules/ui-dialog.js");
  const cmdLine = await uiPrompt(
    `为「${agent.name}」输入启动命令（在仓库目录内执行）：\n用户消息会替换 args 里的 {{prompt}} 占位符；没有占位符时通过 stdin 传入`,
    { title: "补全启动命令", placeholder: "例如 node cli.js --prompt {{prompt}}" }
  );
  if (typeof cmdLine !== "string" || !cmdLine.trim()) return;
  const parts = cmdLine.trim().split(/\s+/);
  try {
    const res = await api<{ agent: ExternalAgent }>(`/api/external-agents/${agent.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: parts[0], args: parts.slice(1) }),
    });
    const idx = state.externalAgents.findIndex((x) => x.id === agent.id);
    if (idx >= 0) state.externalAgents[idx] = res.agent;
    renderExternalCards();
    await createSessionFn("external", null, null, agent.id);
  } catch (err) {
    uiAlert(`保存失败：${(err as Error).message}`, "外部 Agent");
  }
}
