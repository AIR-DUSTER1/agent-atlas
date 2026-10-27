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
import { handleEvent } from "../stream/events.js";
import { finalize } from "../stream/turn.js";
import { markInterruptsResolved, markLatestInterruptPending, renderSessions } from "./sessions.js";
import { closeComposerMenu } from "../composer/menu.js";
import { updateContextBar } from "./composer-bar.js";
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
  if (title) title.textContent = "未选择会话";
  $("demo-badge")?.classList.add("hidden");
  welcomeEl.classList.remove("hidden");
  messagesEl.innerHTML = "";
  $("context-bar")?.classList.add("hidden");
  inputEl.disabled = true;
  sendBtn.disabled = true;
  inputEl.placeholder = "先选择一个 Demo 新建会话…";
}

export function showChatState(session: Session): void {
  welcomeEl.classList.add("hidden");
  const title = $("session-title");
  if (title) title.textContent = session.title;
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
  if (!s || s.stale) return;                       // 服务重启后的残留会话：服务端也没有记录
  if (transcript(s.id).length) return;             // 本地已有 → 不拉
  try {
    const data = await api<{
      records?: Array<{
        user?: string;
        files?: Array<{ name: string; source: string; image?: boolean }>;
        events?: unknown[];
      }>;
      pendingApproval?: boolean;
    }>(`/api/sessions/${s.id}/transcript`);
    const arr = transcript(s.id);
    if (arr.length) return;                        // 竞态防护：等待期间本地已写入
    for (const rec of data.records || []) {
      const continuation = isContinuationRecord(rec);
      let ablock = continuation ? lastAssistantBlock(arr) : null;
      if (!ablock) {
        ablock = { t: "assistant", parts: [] };
        if (continuation) {
          // 旧数据缺少可合并的助手块时仍保持「无新用户气泡」，避免伪造一条审批消息。
          arr.push(ablock);
        } else {
          const userBlock: ChatBlock = {
            t: "user",
            text: rec.user || "",
            ...(rec.files?.length ? { files: rec.files } : {}),
          };
          arr.push(userBlock, ablock);
        }
      }
      for (const ev of rec.events || []) handleEvent(ev as never, ablock);
      finalize(ablock);
    }
    // 回放中的 interrupt 是历史事件；先统一标成「已处理」，服务端仍有 pending
    // 时只把最后一张卡恢复为可操作，避免旧卡片在刷新后误点（尤其是多轮审批/澄清）。
    if (typeof data.pendingApproval === "boolean") {
      markInterruptsResolved(s.id);
      if (data.pendingApproval) markLatestInterruptPending(s.id);
    }
    saveLocal();
    if (state.currentId === s.id) {
      renderAll();
      updateContextBar();
      chatScroll.scrollTop = chatScroll.scrollHeight;
    }
    // 回放中的 interrupt 事件会把会话标成「待审批」——以服务端的真实状态纠正
    // （审批早已处理过时，重放的那次 interrupt 只是历史记录）
    if (typeof data.pendingApproval === "boolean") {
      s.pendingApproval = data.pendingApproval;
      renderSessions();
    }
  } catch { /* 服务端也没有记录（会话从未对话过 / 服务重启过）→ 保持现状 */ }
}
