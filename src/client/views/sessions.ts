/**
 * ============================================================
 * views/sessions.ts — 侧栏会话列表（按项目分组 + 搜索 + 单条操作）
 * ============================================================
 * 职责：会话列表的过滤、分组与渲染；单项的导出 / 删除按钮。
 * 设计立场：
 *  - 搜索是纯本地过滤（标题 + 本浏览器缓存的消息文本），零请求；
 *  - 分组顺序跟 projects 定义一致，未归属会话归「未归属」组；
 *  - 会话项骨架 innerHTML + 正文 textContent，标题可能来自用户输入。
 */

import { $ } from "../core/dom.js";
import { api, authFetch } from "../core/api.js";
import { saveLocal, state, transcript } from "../core/state.js";
import { profileMetaForSession } from "../modules/agent-profile.js";
import { h } from "../ui/h.js";
import { icon } from "../ui/icon.js";
import { uiAlert } from "../ui/dialog.js";
import { toast } from "../ui/toast.js";
import { selectSession, showWelcomeState } from "./navigation.js";
import type { ProjectEntry, Session } from "../modules/types.js";

const DEMO_BADGE_TEXT: Record<number, string> = {
  1: "示例 1 · 基础 ReAct", 2: "示例 2 · 对话记忆",
  3: "示例 3 · 人工审批", 4: "示例 4 · 多 Agent",
};

export function demoBadgeText(demo: number | null | undefined): string {
  return demo ? DEMO_BADGE_TEXT[demo] || `示例 ${demo}` : "示例";
}

/** 会话列表短标签：Agent profile 走元数据，demo / external 保留各自语义。 */
export function sessionTagText(session: Session): string {
  if (session.kind === "external") return "外部";
  if (session.kind === "demo") return `示例 ${session.demo}`;
  return profileMetaForSession(session)?.shortLabel ?? "未知";
}

/** 会话搜索：标题必查；本浏览器缓存的消息块（state.blocks）参与匹配，
 *  没缓存到的会话按标题兜底 —— 服务端无搜索接口，保持零开销本地过滤。 */
export function sessionMatchesSearch(s: Session, term: string): boolean {
  if (!term) return true;
  const q = term.toLowerCase();
  if ((s.title || "").toLowerCase().includes(q)) return true;
  const blocks = state.blocks?.[s.id];
  if (!blocks) return false;
  return blocks.some((b) => {
    if (b.t === "user") return b.text.toLowerCase().includes(q);
    if (b.t === "notice" || b.t === "error") return b.text.toLowerCase().includes(q);
    if (b.t === "assistant") {
      return b.parts.some((p) => p.p === "text" && p.text.toLowerCase().includes(q));
    }
    return false;
  });
}

function startOfDay(ts: number): number {
  const date = new Date(ts);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function sessionTimeLabel(ts: number, now = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(ts)) / 86_400_000);
  const time = new Date(ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  if (days <= 0) return time;
  if (days === 1) return `昨天 ${time}`;
  if (days < 7) return `${days} 天前`;
  return `${new Date(ts).getMonth() + 1}/${new Date(ts).getDate()}`;
}

function sessionDayGroup(ts: number, now = Date.now()): "今天" | "昨天" | "更早" {
  const days = Math.round((startOfDay(now) - startOfDay(ts)) / 86_400_000);
  return days <= 0 ? "今天" : days === 1 ? "昨天" : "更早";
}
export function renderSessions(): void {
  const list = $("session-list");
  if (!list) return;
  list.replaceChildren();
  const term = ($("session-search") as HTMLInputElement | null)?.value?.trim() ?? "";

  const filtered = state.sessions.filter(
    (session) => (state.projectView === "all" || session.projectId === state.projectView) && sessionMatchesSearch(session, term),
  );
  const groups: Array<{ project: ProjectEntry | null; sessions: Session[] }> = [];
  const byId = new Map<string, { project: ProjectEntry | null; sessions: Session[] }>();
  for (const project of state.projects) {
    const group = { project: project as ProjectEntry | null, sessions: [] as Session[] };
    groups.push(group);
    byId.set(project.id, group);
  }
  const other = { project: null as ProjectEntry | null, sessions: [] as Session[] };
  for (const session of filtered) (byId.get(session.projectId) || other).sessions.push(session);
  if (other.sessions.length) groups.push(other);

  for (const group of groups) {
    if (!group.sessions.length) continue;
    const head = h("div", { class: "proj-group-head" + (group.project?.type === "cloud" ? " cloud" : "") },
      h("span", { class: "g-icon" }, icon(group.project?.type === "cloud" ? "Globe" : "Folder", { size: 14 })),
      h("span", { class: "g-name" }, group.project?.name ?? "未归属"),
      h("span", { class: "p-type-tag" }, group.project ? (group.project.type === "cloud" ? "云端" : "本地") : "已移除"),
    );
    list.appendChild(head);
    const sorted = [...group.sessions].sort((left, right) => right.createdAt - left.createdAt);
    let day = "";
    for (const session of sorted) {
      const nextDay = sessionDayGroup(session.createdAt);
      if (nextDay !== day) {
        day = nextDay;
        list.appendChild(h("div", { class: "session-time-head" }, day));
      }
      list.appendChild(renderSessionItem(session));
    }
  }
  if (!list.children.length) {
    list.appendChild(h("div", { class: "fs-empty" }, term
      ? "没有命中搜索的会话"
      : state.projectView === "all" ? "还没有会话，点上方「＋ 新建对话」" : "该项目下还没有会话"));
  }
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
function renderSessionItem(session: Session): HTMLElement {
  const meta = h("div", { class: "s-meta" },
    h("span", { class: "s-demo" }, sessionTagText(session)),
    h("span", null, sessionTimeLabel(session.createdAt)),
    session.pendingApproval ? h("span", { class: "s-pending" }, icon("Clock", { size: 12 }), "待审批") : null,
  );

  const exportButton = h("button", {
    type: "button",
    class: "s-action s-export",
    title: "导出为 Markdown",
    "aria-label": "导出当前会话为 Markdown",
    onclick: (event: MouseEvent) => {
      event.stopPropagation();
      void exportSession(session).catch((err) => uiAlert(`导出失败：${(err as Error).message}`, "导出会话"));
    },
  }, icon("Download", { size: 13 }));

  const deleteButton = h("button", {
    type: "button",
    class: "s-action s-del",
    title: "删除会话",
    "aria-label": "删除当前会话",
    onclick: async (event: MouseEvent) => {
      event.stopPropagation();
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
    },
  }, icon("X", { size: 13 }));

  return h("div", {
    class: "session-item" + (session.id === state.currentId ? " active" : "") + (session.stale ? " stale" : ""),
    title: session.stale ? "服务已重启，该会话仅可查看历史记录" : "",
    role: "button",
    tabindex: "0",
    onclick: () => selectSession(session.id),
    onkeydown: (event: KeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectSession(session.id);
      }
    },
  },
  h("div", { class: "s-title" }, session.title),
  meta,
  h("div", { class: "s-actions" }, exportButton, deleteButton),
  );
}
/** 重拉服务端会话列表（批量清理后用）：保留 stale 条目与本地标题覆盖 */
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

/** 历史回放中的 interrupt 只代表「当时暂停过」，服务端无 pending 时不再可操作 */
export function markInterruptsResolved(sid: string): void {
  for (const block of transcript(sid)) {
    if (block.t !== "assistant" || !Array.isArray(block.parts)) continue;
    for (const part of block.parts) {
      if (part.p === "approval" && part.status === "pending") part.status = "resolved";
      if (part.p === "clarification" && part.status === "pending") part.status = "answered";
    }
  }
}

/** 服务端仍有 pending 时，只有历史里最后一张 interrupt 卡可操作；更早的必须收起。 */
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
