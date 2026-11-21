/**
 * ============================================================
 * views/sessions.ts — 侧栏会话树：数据与副作用（M4 批次 4.5 起）
 * ============================================================
 * 树渲染已迁往 Vue（session-tree-vue.vue + stores/sessions.ts）；本文件保留
 * 全部「行为」职责：
 *  1. 列表拉取（stale 项目与本地标题不被覆盖）；
 *  2. 会话切换 / 导出（Blob 下载，Electron 友好）/ 删除（先 abort 在途生成）；
 *  3. 分组折叠状态写 core state + localStorage；
 *  4. 历史回放里的 interrupt 态修正（markInterruptsResolved /
 *     markLatestInterruptPending）。
 * 渲染数据经 window 通知推给 Vue（core/state 不是响应式的，且 bundle 与
 * 1:1 副本是两个模块实例，各有独立 pinia）。
 */
import { api, authFetch } from "../core/api.js";
import { saveLocal, state, transcript } from "../core/state.js";
import { uiAlert } from "../ui/dialog.js";
import { toast } from "../ui/toast.js";
import { selectSession, showWelcomeState } from "./navigation.js";
import type { Session } from "../modules/types.js";

// 纯函数与常量从无 pinia 依赖的 modules/session-tree.ts 转发，
// 保持既有 import 路径可用（本模块在 1:1 静态图上，不能静态 import store）。
export { ORPHAN_GROUP_KEY, demoBadgeText, sessionTagText, sessionMatchesSearch } from "../modules/session-tree.js";

/** 本地发布：唤醒已挂载的 Vue 会话树重算（bundle 与 1:1 副本靠 window 通信）。 */
function publishSessions(): void {
  for (const listener of window.__agentatlasSessionListeners ?? []) listener();
}

export function isProjectCollapsed(key: string): boolean {
  return state.projCollapsed.includes(key);
}

/** 折叠状态切换：只记 id 列表，渲染时据此还原，避免持有 DOM 引用。 */
export function toggleProjectCollapsed(key: string): void {
  state.projCollapsed = isProjectCollapsed(key)
    ? state.projCollapsed.filter((id) => id !== key)
    : [...state.projCollapsed, key];
  saveLocal();
  renderSessions();
}

/** 触发 Vue 会话树重渲染（core state 变更后调用）。 */
export function renderSessions(): void {
  void import("../apps/session-tree-vue.js")
    .then((m) => m.mountSessionTreeVue())
    .catch(() => {});
  publishSessions();
}

function exportFileName(session: Session): string {
  const safe = (session.title || "会话").replace(/[\\/:*?"<>|\r\n]+/g, "-").trim().slice(0, 80) || "会话";
  return `${safe}.md`;
}

/** 导出走 Blob 下载，避免 window.open 在 Electron 里打开空白新窗口。 */
async function exportSession(session: Session): Promise<void> {
  const res = await authFetch(`/api/sessions/${session.id}/export`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(data.error || `导出失败（HTTP ${res.status}）`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = exportFileName(session);
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2_000);
  toast("会话已导出为 Markdown", "success");
}

/** 删除会话：先中止本会话在途生成，再请求服务端删除，避免 journal 回填与删除竞态。 */
async function removeSession(session: Session): Promise<void> {
  state.streams[session.id]?.ctrl.abort();
  delete state.streams[session.id];
  delete state.compacting[session.id];
  if (!session.stale) {
    try { await api(`/api/sessions/${session.id}`, { method: "DELETE" }); } catch { /* 本地仍可清理 */ }
  }
  state.sessions = state.sessions.filter((item) => item.id !== session.id);
  delete state.blocks[session.id];
  saveLocal();
  if (state.currentId === session.id) {
    state.currentId = null;
    renderSessions();
    showWelcomeState();
  } else {
    renderSessions();
  }
}

/** 注册组件命令面：Vue 只发意图，切换/导出/删除/折叠都在这里。 */
export function bindSessionCommands(): void {
  window.__agentatlasSessionCommands = {
    select: (id) => { selectSession(id); },
    exportSession: (id) => {
      const session = state.sessions.find((item) => item.id === id);
      if (!session) return;
      void exportSession(session).catch((err) => uiAlert(`导出失败：${(err as Error).message}`, "导出会话"));
    },
    removeSession: (id) => {
      const session = state.sessions.find((item) => item.id === id);
      if (session) void removeSession(session);
    },
    toggleGroup: (key) => { toggleProjectCollapsed(key); },
  };
  renderSessions();
}

/** 拉取服务端会话列表并重渲染；本地 stale 项目与本地标题不被覆盖 */
export async function loadSessionList(): Promise<void> {
  const serverSessions = await api<Session[]>("/api/sessions");
  const keepStale = state.sessions.filter((s) => s.stale);
  const keptTitles = new Map(state.sessions.map((s) => [s.id, s.title]));
  state.sessions = [
    ...serverSessions.map((s) => ({ ...s, stale: false, title: keptTitles.get(s.id) || s.title })),
    ...keepStale,
  ];
  renderSessions();
}

/** 历史回放中的 interrupt 只代表运行时中断：审批/澄清恢复 pending 时再次可操作 */
export function markInterruptsResolved(sid: string): void {
  for (const block of transcript(sid)) {
    if (block.t !== "assistant" || !Array.isArray(block.parts)) continue;
    for (const part of block.parts) {
      if (part.p === "approval" && part.status === "pending") part.status = "resolved";
      if (part.p === "clarification" && part.status === "pending") part.status = "answered";
    }
  }
}

/** 若存在新的 pending 时，只把历史里最后一个 interrupt 标记成可操作，其余保持历史态 */
export function markLatestInterruptPending(sid: string): void {
  let latest: { status: string } | null = null;
  for (const block of transcript(sid)) {
    if (block.t !== "assistant" || !Array.isArray(block.parts)) continue;
    for (const part of block.parts) {
      if (part.p === "approval" || part.p === "clarification") latest = part;
    }
  }
  if (latest) latest.status = "pending";
}
