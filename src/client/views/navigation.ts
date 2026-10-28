/**
 * ============================================================
 * views/navigation.ts — 会话切换：欢迎页 / 会话头 / 权限 chip / 历史回放
 * ============================================================
 * 职责：选中会话后的一切「头部与入口」状态，以及从服务端补拉历史。
 * 设计立场：
 *  - 切会话是纯视图动作：数据（blocks）已在 state 里，这里只负责重绘与头部文案；
 *  - 历史回放复用与实时流完全相同的 handleEvent —— 回放与实时不能有两套渲染逻辑；
 *  - 回放里的 interrupt 只是历史事件，服务端仍有 pending 时才恢复最后一张卡可点。
 */

import { $, chatScroll, inputEl, messagesEl, sendBtn, setSidebarOpen, welcomeEl } from "../core/dom.js";
import { api } from "../core/api.js";
import { saveLocal, state, transcript } from "../core/state.js";
import { uiAlert } from "../ui/dialog.js";
import { profileMetaForSession } from "../modules/agent-profile.js";
import { isContinuationRecord, lastAssistantBlock } from "../modules/chat-flow.js";
import { renderAll } from "../render/messages.js";
import { applyUsage, handleEvent } from "../stream/events.js";
import { finalize } from "../stream/turn.js";
import { markInterruptsResolved, markLatestInterruptPending, renderSessions } from "./sessions.js";
import { closeComposerMenu } from "../composer/menu.js";
import { updateContextBar } from "./composer-bar.js";
import { projectById } from "./projects.js";
import type { ChatBlock, PermissionModeId, Session } from "../modules/types.js";

const DEMO_BADGE_TEXT: Record<number, string> = {
  1: "示例 1 · 基础 ReAct", 2: "示例 2 · 对话记忆",
  3: "示例 3 · 人工审批", 4: "示例 4 · 多 Agent",
};

/* ---------------------------------------------------------------------------
 * 会话权限模式：输入框上方 🛡 chip，随会话切换联动
 * 只读 = 改世界工具一律拒绝；审批 = 高风险先确认（默认）；
 * 自主 = AI 判断当前操作是否高风险；自动 = 全部直接执行。
 * ------------------------------------------------------------------------- */
export interface PermissionMode {
  id: PermissionModeId;
  label: string;
  desc: string;
}

export const PERMISSION_MODES: PermissionMode[] = [
  { id: "readonly", label: "只读", desc: "只允许只读工具：写文件 / 执行命令 / 发消息 / 控制电脑一律拒绝" },
  { id: "approve", label: "审批", desc: "高风险操作执行前弹审批卡片，人工批准才执行（默认）" },
  { id: "autonomous", label: "自主", desc: "AI 判断当前操作风险：高风险才申请人工审批，低风险直接执行（评估失败按高风险）" },
  { id: "auto", label: "自动", desc: "全部工具直接执行，不再逐项审批（信任当前会话时使用）" },
];

export function showWelcomeState(): void {
  closeComposerMenu();
  const title = $("session-title");
  if (title) title.textContent = "选择会话";
  const breadcrumb = $("breadcrumb-project");
  if (breadcrumb) breadcrumb.textContent = projectById(state.projectView)?.name ?? "工作台";
  $("demo-badge")?.classList.add("hidden");
  welcomeEl.classList.remove("hidden");
  $("empty-session")?.classList.add("hidden");
  messagesEl.innerHTML = "";
  $("context-bar")?.classList.add("hidden");
  inputEl.disabled = true;
  sendBtn.disabled = true;
  inputEl.placeholder = "先选择一个 Demo 新建会话…";
}

export function showChatState(session: Session): void {
  welcomeEl.classList.add("hidden");
  $("empty-session")?.classList.toggle("hidden", transcript(session.id).length > 0);
  const title = $("session-title");
  if (title) title.textContent = session.title;
  const breadcrumb = $("breadcrumb-project");
  if (breadcrumb) breadcrumb.textContent = projectById(session.projectId)?.name ?? "未归属项目";
  const badge = $("demo-badge");
  if (badge) {
    const profile = profileMetaForSession(session);
    badge.textContent = session.kind === "demo"
      ? (DEMO_BADGE_TEXT[session.demo || 0] || `示例 ${session.demo}`)
      : session.kind === "external"
        ? `🔌 外部 · ${state.externalAgents.find((a) => a.id === session.agentId)?.name ?? "Agent"}`
        : profile ? `${profile.icon} ${profile.label}` : "未知 Agent";
    badge.classList.remove("hidden");
  }
  // 历史会话（服务重启后仅存于本地）只读：发送必然 404，直接禁用输入
  const stale = Boolean(session.stale);
  inputEl.disabled = stale;
  sendBtn.disabled = stale;
  inputEl.placeholder = stale
    ? "这是历史会话（服务已重启），仅供查看 —— 点击「＋ 新建对话」继续"
    : "给 Agent 发送消息…（Enter 发送 / Shift+Enter 换行）";
  renderPermChip(session);
  // 会话切换和新建后都要重算容量条；否则新会话会残留上一会话的用量。
  updateContextBar();
}

/** 权限 chip 只对有 Agent 执行力的会话显示（demo / external / 历史失效会话隐藏） */
export function renderPermChip(session?: Session): void {
  const group = $("perm-group");
  const chip = $("cm-perm");
  if (!group || !chip) return;
  const current = session || state.sessions.find((x) => x.id === state.currentId);
  const available = Boolean(current) && !current?.stale && (current?.kind === "agent" || current?.kind === "estate");
  group.classList.toggle("hidden", !available);
  if (!available) return;
  const mode = PERMISSION_MODES.find((m) => m.id === (current?.permissionMode || "approve"));
  const text = document.querySelector("#cm-perm .cm-text");
  if (text) text.textContent = `权限·${mode?.label || "审批"}`;
  chip.title = `会话权限模式：${mode?.label || "审批"} —— ${mode?.desc || ""}`;
  // 弹出菜单开着时同步刷新勾选
  const menu = $("cm-perm-menu");
  if (menu && !menu.classList.contains("hidden")) renderPermMenu(menu);
}

export function renderPermMenu(menu: HTMLElement): void {
  const current = state.sessions.find((x) => x.id === state.currentId);
  const active = current?.permissionMode || "approve";
  menu.innerHTML = "";
  const sec = document.createElement("div");
  sec.className = "cm-sec";
  const head = document.createElement("span");
  head.textContent = "会话权限模式";
  const sub = document.createElement("span");
  sub.className = "cm-sub";
  sub.textContent = "当前会话";
  sec.append(head, sub);
  menu.appendChild(sec);
  for (const mode of PERMISSION_MODES) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "cm-item" + (mode.id === active ? " active" : "");
    item.innerHTML = `<span class="ck">${mode.id === active ? "✓" : ""}</span><span class="cm-label"></span>`;
    const label = item.querySelector(".cm-label");
    if (label) label.textContent = mode.label;
    item.title = mode.desc;
    item.addEventListener("click", async () => {
      if (mode.id === active || !state.currentId) { closeCmMenus(); return; }
      item.disabled = true;
      try {
        await api(`/api/sessions/${state.currentId}/permission`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: mode.id }),
        });
        const session = state.sessions.find((x) => x.id === state.currentId);
        if (session) session.permissionMode = mode.id;
        renderPermChip();
      } catch (err) {
        uiAlert(`切换失败：${(err as Error).message}`, "会话权限");
      }
      closeCmMenus();
    });
    menu.appendChild(item);
  }
  const desc = document.createElement("div");
  desc.className = "cm-desc";
  desc.textContent = PERMISSION_MODES.find((m) => m.id === active)?.desc || "";
  menu.appendChild(desc);
}

/** 关闭所有 composer chip 菜单（模型 / 思考 / 权限） */
export function closeCmMenus(): void {
  document.querySelectorAll(".cm-menu").forEach((el) => el.classList.add("hidden"));
  document.querySelectorAll(".cm-chip.on").forEach((el) => el.classList.remove("on"));
}

export function selectSession(sid: string): void {
  if (state.streaming) { uiAlert("当前正在生成回复，请先停止或等待完成", "请稍候"); return; }
  closeComposerMenu();
  state.currentId = sid;
  setSidebarOpen(false); // 窄屏抽屉：选中即收起
  const s = state.sessions.find((x) => x.id === sid);
  renderSessions();
  renderAll();
  if (s) showChatState(s);
  updateContextBar();
  chatScroll.scrollTop = chatScroll.scrollHeight;
  void hydrateFromServer(s); // 本地没有该会话的记录 → 从服务端拉取回放（修复历史会话打开为空）
}

/** 历史会话回放：localStorage 里没有这个会话的对话记录时（换浏览器 / 清过缓存），
 *  从服务端拉取每轮「用户消息 + 事件流」，用与实时流完全相同的 handleEvent 重放渲染。 */
export async function hydrateFromServer(s: Session | undefined): Promise<void> {
  if (!s || s.stale) return;
  try {
    const data = await api<{
      records?: Array<{
        user?: string;
        files?: Array<{ name: string; source: string; image?: boolean }>;
        events?: unknown[];
      }>;
      pendingApproval?: boolean;
    }>(`/api/sessions/${s.id}/transcript`);
    if (state.currentId !== s.id) return;

    const arr = transcript(s.id);
    const hadLocal = arr.length > 0;
    if (!hadLocal) {
      for (const rec of data.records || []) {
        const continuation = isContinuationRecord(rec);
        let ablock = continuation ? lastAssistantBlock(arr) : null;
        if (!ablock) {
          ablock = { t: "assistant", parts: [] };
          if (continuation) {
            arr.push(ablock);
          } else {
            arr.push({
              t: "user",
              text: rec.user || "",
              ...(rec.files?.length ? { files: rec.files } : {}),
            } satisfies ChatBlock, ablock);
          }
        }
        for (const ev of rec.events || []) handleEvent(ev as never, ablock);
        finalize(ablock);
      }
    } else {
      // 本地已有正文时不再重复重建 DOM，但仍从 journal 恢复本轮 usage；
      // 这样换浏览器/清缓存/切会话后容量条不会随机消失或回退。
      delete state.usage[s.id];
      for (const rec of data.records || []) {
        if (!isContinuationRecord(rec)) delete state.usage[s.id];
        for (const ev of rec.events || []) {
          if ((ev as { type?: string }).type === "usage") applyUsage(ev as never, undefined, s.id);
        }
      }
    }

    if (typeof data.pendingApproval === "boolean") {
      markInterruptsResolved(s.id);
      if (data.pendingApproval) markLatestInterruptPending(s.id);
      s.pendingApproval = data.pendingApproval;
      renderSessions();
    }
    saveLocal();
    if (state.currentId === s.id) {
      if (!hadLocal) renderAll();
      updateContextBar();
      chatScroll.scrollTop = chatScroll.scrollHeight;
    }
  } catch { /* 服务端也没有记录（会话从未对话过 / 服务重启过）→ 保持现状 */ }
}