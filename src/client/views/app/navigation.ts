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

import { $, chatScroll, inputEl, messagesEl, sendBtn, setSidebarOpen, welcomeEl } from "../../core/dom.js";
import { api } from "../../core/api.js";
import { saveLocal, state, transcript } from "../../core/state.js";
import { uiAlert } from "../../ui/dialog.js";
import { isContinuationRecord, lastAssistantBlock } from "../../modules/chat-flow.js";
import { PERMISSION_MODES, type PermissionMode } from "../../modules/permission-modes.js";
import { renderAll } from "../../render/messages.js";
import { applyUsage, handleEvent } from "../../stream/events.js";
import { finalize, setStatus, syncComposerState } from "../../stream/turn.js";
import { markInterruptsResolved, markLatestInterruptPending, renderSessions } from "./sessions.js";
import { closeComposerMenu } from "../../composer/menu.js";
import { updateContextBar } from "../chat/composer-bar.js";
import { renderWorkflowPlan } from "../chat/workflow-plan.js";
import type { AgentEvent, ChatBlock, PermissionModeId, Session } from "../../modules/types.js";

/** 权限模式常量与类型从纯数据模块转发（保持既有 import 路径）。 */
export { PERMISSION_MODES, type PermissionMode } from "../../modules/permission-modes.js";

export type WelcomeMode = "default" | "agent-picker";

/** 顶部与欢迎页文案统一经 store 发布（core state 非响应式，靠 window 通知）。 */
function publishTopbar(action: "welcome" | "session" | "plugin" | "perm", payload?: unknown): void {
  void import("../../stores/topbar.js")
    .then(({ useTopbarStore, publishTopbar: publish }) => {
      const store = useTopbarStore();
      if (action === "welcome") store.applyWelcome(payload as WelcomeMode);
      else if (action === "session") store.applySession(payload as Session);
      else if (action === "plugin") store.refreshPluginCopy();
      else store.applyPermission(payload as Session | undefined);
      publish();
    })
    .catch(() => {});
  void import("./topbar-vue.js")
    .then((m) => m.mountShellHeadsVue())
    .catch(() => {});
}

/** 插件启停后刷新 Agent 选择页副标题；其他欢迎态不受影响。 */
export function refreshWelcomePluginCopy(): void {
  publishTopbar("plugin");
}

/** 无项目时把欢迎页提升为明确的 Agent 选择页；普通欢迎态仍保留示例起步。 */
export function showWelcomeState(mode: WelcomeMode = "default"): void {
  closeComposerMenu();
  publishTopbar("welcome", mode);
  const pickingAgent = mode === "agent-picker";
  $("example-chips")?.classList.toggle("hidden", pickingAgent);
  welcomeEl.classList.remove("hidden");
  $("empty-session")?.classList.add("hidden");
  // #messages 由 Vue 管理：清空必须走 store，不能直接动 DOM（会摘掉挂载根）
  void messagesEl;
  void import("../../stores/messages.js").then(({ useMessagesStore }) => useMessagesStore().clear()).catch(() => {});
  $("context-bar")?.classList.add("hidden");
  $("workflow-panel")?.classList.add("hidden");
  inputEl.disabled = true;
  sendBtn.disabled = true;
  sendBtn.classList.remove("hidden");
  $("stop-btn")?.classList.add("hidden");
  inputEl.placeholder = pickingAgent ? "请选择 Agent 开始新会话…" : "先选择一个 Agent 或示例新建会话…";
  setStatus("idle");
}

export function showChatState(session: Session): void {
  welcomeEl.classList.add("hidden");
  $("empty-session")?.classList.toggle("hidden", transcript(session.id).length > 0);
  // 标题 / 面包屑 / 示例徽标经 store 交给 Vue 顶栏组件（含目录匹配逻辑）
  publishTopbar("session", session);
  // 历史会话（服务重启后仅存于本地）只读：发送必然 404，直接禁用输入
  const stale = Boolean(session.stale);
  inputEl.disabled = stale;
  sendBtn.disabled = stale;
  inputEl.placeholder = stale
    ? "这是历史会话（服务已重启），仅供查看 —— 点击「＋ 新建对话」继续"
    : "给 Agent 发送消息…（Enter 发送 / Shift+Enter 换行）";
  renderPermChip(session);
  // 会话切换和新建后都要重算容量条与流程窗体；否则会残留上一会话状态。
  updateContextBar();
  renderWorkflowPlan();
  // 输入区按“当前会话自己的”流状态恢复：后台会话可继续生成，但不会锁住这里。
  syncComposerState(session.id);
}

/** 权限 chip 只对有 Agent 执行力的会话显示（demo / external / 历史失效会话隐藏） */
export function renderPermChip(session?: Session): void {
  // 可用性判定与文案由 store 统一派生（历史 bug：这里硬编码 agent||estate，
  // 加求职 Agent 时漏改，导致求职会话根本没有权限入口）。
  publishTopbar("perm", session);
  const chip = $("cm-perm");
  const menu = $("cm-perm-menu");
  // 菜单开着时同步刷新勾选（菜单内容仍由本模块渲染，见 renderPermMenu）
  if (chip && menu && !menu.classList.contains("hidden")) renderPermMenu(menu);
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
  closeComposerMenu();
  state.currentId = sid;
  setSidebarOpen(false); // 窄屏抽屉：选中即收起
  const s = state.sessions.find((x) => x.id === sid);
  renderSessions();
  renderAll();
  if (s) showChatState(s);
  updateContextBar();
  chatScroll.scrollTop = chatScroll.scrollHeight;
  document.dispatchEvent(new CustomEvent("agentatlas:session-selected", { detail: { sessionId: sid } }));
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
        storage?: {
          originalEvents?: number;
          storedEvents?: number;
          droppedEvents?: number;
          eventLimit?: number;
          mergedTokenChunks?: number;
          mergedReasoningChunks?: number;
          reasoningCharsDropped?: number;
          dedupedUsageEvents?: number;
        };
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
        for (const ev of rec.events || []) handleEvent(ev as never, ablock, s.id);
        finalize(ablock, s.id);
        if ((rec.storage?.droppedEvents ?? 0) > 0) {
          const original = rec.storage?.originalEvents ?? 0;
          const kept = rec.storage?.storedEvents ?? rec.events?.length ?? 0;
          const notice: ChatBlock = {
            t: "notice",
            title: "历史记录已截断",
            text: `该轮原始 ${original} 条事件，仅保留最近 ${kept} 条（上限 ${rec.storage?.eventLimit ?? 3000}）。` +
              `可查看 turnId 附近的日志与统计；本次截断不会影响新对话。`,
          };
          arr.push(notice);
        }
      }
    } else {
      // 本地已有正文时不再重复重建 DOM，但仍从 journal 恢复本轮 usage；
      // 这样换浏览器/清缓存/切会话后容量条不会随机消失或回退。
      delete state.usage[s.id];
      for (const rec of data.records || []) {
        if (!isContinuationRecord(rec)) delete state.usage[s.id];
        for (const ev of rec.events || []) {
          const type = (ev as { type?: string }).type;
          if (type === "usage") applyUsage(ev as never, undefined, s.id);
          // 旧浏览器缓存里可能还没有流程状态；即使正文已存在也补最新流程。
          if (type === "workflow_plan") {
            state.workflowPlans[s.id] = (ev as Extract<AgentEvent, { type: "workflow_plan" }>).plan;
          }
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
      renderWorkflowPlan();
      chatScroll.scrollTop = chatScroll.scrollHeight;
    }
  } catch { /* 服务端也没有记录（会话从未对话过 / 服务重启过）→ 保持现状 */ }
}
