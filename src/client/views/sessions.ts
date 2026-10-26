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
import { api } from "../core/api.js";
import { saveLocal, state, transcript } from "../core/state.js";
import { profileMetaForSession } from "../modules/agent-profile.js";
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

export function renderSessions(): void {
  const list = $("session-list");
  if (!list) return;
  list.innerHTML = "";
  const term = ($("session-search") as HTMLInputElement | null)?.value?.trim() ?? "";

  // 按项目过滤 + 分组（保持 projects 定义顺序；无匹配项目的会话归入「其他」）
  const filtered = state.sessions.filter(
    (s) => (state.projectView === "all" || s.projectId === state.projectView) && sessionMatchesSearch(s, term)
  );
  const groups: Array<{ project: ProjectEntry | null; sessions: Session[] }> = [];
  const byId = new Map<string, { project: ProjectEntry | null; sessions: Session[] }>();
  for (const p of state.projects) {
    const g = { project: p as ProjectEntry | null, sessions: [] as Session[] };
    groups.push(g);
    byId.set(p.id, g);
  }
  const other = { project: null as ProjectEntry | null, sessions: [] as Session[] };
  for (const s of filtered) {
    (byId.get(s.projectId) || other).sessions.push(s);
  }
  if (other.sessions.length) groups.push(other);

  for (const g of groups) {
    if (!g.sessions.length) continue;
    const head = document.createElement("div");
    head.className = "proj-group-head" + (g.project?.type === "cloud" ? " cloud" : "");
    head.innerHTML = `<span class="g-icon">${g.project ? (g.project.type === "cloud" ? "☁️" : "📁") : "📁"}</span><span class="g-name"></span><span class="p-type-tag">${g.project ? (g.project.type === "cloud" ? "云端" : "本地") : "已移除"}</span>`;
    const nameEl = head.querySelector(".g-name");
    if (nameEl) nameEl.textContent = g.project?.name ?? "未归属";
    list.appendChild(head);
    for (const s of g.sessions) list.appendChild(renderSessionItem(s));
  }
  if (!list.children.length) {
    const empty = document.createElement("div");
    empty.className = "fs-empty";
    empty.textContent = term
      ? "没有命中搜索的会话"
      : state.projectView === "all" ? "还没有会话，点上方「＋ 新建对话」" : "该项目下还没有会话";
    list.appendChild(empty);
  }
}

function renderSessionItem(s: Session): HTMLElement {
  const item = document.createElement("div");
  item.className = "session-item" + (s.id === state.currentId ? " active" : "") + (s.stale ? " stale" : "");
  item.title = s.stale ? "服务已重启，该会话仅可查看历史记录" : "";

  const title = document.createElement("div");
  title.className = "s-title";
  title.textContent = s.title;
  item.appendChild(title);

  const meta = document.createElement("div");
  meta.className = "s-meta";
  const tag = document.createElement("span");
  tag.className = "s-demo";
  tag.textContent = sessionTagText(s);
  meta.appendChild(tag);
  const time = document.createElement("span");
  time.textContent = new Date(s.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  meta.appendChild(time);
  if (s.pendingApproval) {
    const pend = document.createElement("span");
    pend.textContent = "⏸ 待审批";
    pend.style.color = "var(--amber)";
    meta.appendChild(pend);
  }
  item.appendChild(meta);

  const actions = document.createElement("div");
  actions.className = "s-actions";

  const exportBtn = document.createElement("button");
  exportBtn.className = "s-action s-export";
  exportBtn.textContent = "⬇";
  exportBtn.title = "导出为 Markdown";
  exportBtn.setAttribute("aria-label", "导出当前会话为 Markdown");
  exportBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    // 附件下载走浏览器原生（新开同源 URL 触发 Content-Disposition，不打断当前页）
    window.open(`/api/sessions/${s.id}/export`, "_blank");
  });
  actions.appendChild(exportBtn);

  const del = document.createElement("button");
  del.className = "s-action s-del";
  del.textContent = "✕";
  del.title = "删除会话";
  del.setAttribute("aria-label", "删除当前会话");
  del.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!s.stale) { try { await api(`/api/sessions/${s.id}`, { method: "DELETE" }); } catch { /* 忽略 */ } }
    state.sessions = state.sessions.filter((x) => x.id !== s.id);
    delete state.blocks[s.id];
    saveLocal();
    if (state.currentId === s.id) {
      state.currentId = null;
      renderSessions();
      showWelcomeState();
    } else {
      renderSessions();
    }
  });
  actions.appendChild(del);
  item.appendChild(actions);

  item.addEventListener("click", () => selectSession(s.id));
  return item;
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
