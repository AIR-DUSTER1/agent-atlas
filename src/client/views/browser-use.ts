/**
 * views/browser-use.ts — Browser Use 右侧实时画面与工具卡
 * ============================================================
 * 工具结果到达后自动打开当前会话的右侧浏览器；画面只轮询认证 API，不把页面内容
 * 写入 localStorage。切换会话时隐藏其他会话的浏览器，返回原会话再恢复。
 */
import { api } from "../core/api.js";
import { $ } from "../core/dom.js";
import { state } from "../core/state.js";
import type { BrowserPageState, ToolPart } from "../modules/types.js";

const POLL_INTERVAL_MS = 1_200;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let dockSessionId: string | null = null;
let lastUpdatedAt = 0;
let pollInFlight = false;

function setText(id: string, text: string): void {
  const el = $(id);
  if (el) el.textContent = text;
}

function setState(text: string, cls = ""): void {
  const el = $("browser-dock-state");
  if (!el) return;
  el.textContent = text;
  el.className = "browser-dock-state" + (cls ? ` ${cls}` : "");
}

function showDockShell(): void {
  $("browser-dock")?.classList.remove("hidden");
  $("main")?.classList.add("browser-open");
}

function hideDockShell(): void {
  $("browser-dock")?.classList.add("hidden");
  $("main")?.classList.remove("browser-open");
  stopPolling();
}

function stopPolling(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

function startPolling(): void {
  stopPolling();
  pollTimer = setInterval(() => { void refreshBrowserDock(); }, POLL_INTERVAL_MS);
}

function applyPageState(page: BrowserPageState): void {
  setText("browser-dock-title", page.title || page.url || "未命名页面");
  setText("browser-dock-url", page.url || "about:blank");
  setText("browser-dock-meta", `更新于 ${new Date(page.updatedAt).toLocaleTimeString()} · 会话隔离`);
  setState(page.error ? "页面异常" : page.busy ? "AI 操作中" : "实时连接", page.error ? "" : page.busy ? "busy" : "live");
  const screen = $("browser-dock-screen") as HTMLImageElement | null;
  const empty = $("browser-dock-empty");
  if (screen && page.updatedAt !== lastUpdatedAt) {
    lastUpdatedAt = page.updatedAt;
    screen.src = `/api/browser/sessions/${encodeURIComponent(page.sessionId)}/screenshot?v=${page.updatedAt}`;
  }
  if (empty && page.error) {
    screen?.classList.remove("ready");
    empty.style.visibility = "visible";
    const strong = empty.querySelector("strong");
    const detail = empty.querySelector("span");
    if (strong) strong.textContent = page.error;
    if (detail) detail.textContent = "请让 Agent 重新打开或刷新页面";
  }
}

async function refreshBrowserDock(): Promise<void> {
  if (!dockSessionId || pollInFlight) return;
  if (state.currentId !== dockSessionId) { hideDockShell(); return; }
  pollInFlight = true;
  try {
    const page = await api<BrowserPageState>(`/api/browser/sessions/${encodeURIComponent(dockSessionId)}`);
    if (state.currentId !== dockSessionId) { hideDockShell(); return; }
    showDockShell();
    applyPageState(page);
  } catch (err) {
    setState("已关闭", "");
    setText("browser-dock-meta", err instanceof Error ? err.message : String(err));
    const screen = $("browser-dock-screen") as HTMLImageElement | null;
    screen?.classList.remove("ready");
    // 历史消息回放会再次渲染旧工具卡；对应浏览器若已不在服务端，面板应自动收起，
    // 不能因为一条旧记录长期占住右侧空间。
    hideDockShell();
  } finally {
    pollInFlight = false;
  }
}

/** 工具调用了 Browser Use：绑定当前会话并打开右侧画面。 */
export function openBrowserDock(sessionId: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return;
  dockSessionId = sessionId;
  lastUpdatedAt = 0;
  setText("browser-dock-title", "正在连接浏览器");
  setText("browser-dock-url", "about:blank");
  setState("连接中", "busy");
  const screen = $("browser-dock-screen") as HTMLImageElement | null;
  screen?.classList.remove("ready");
  const empty = $("browser-dock-empty");
  const strong = empty?.querySelector("strong");
  const detail = empty?.querySelector("span");
  if (strong) strong.textContent = "等待 Agent 打开网页";
  if (detail) detail.textContent = "浏览器画面会在这里实时更新";
  if (empty) empty.style.visibility = "visible";
  if (state.currentId !== sessionId) { hideDockShell(); return; }
  showDockShell();
  void refreshBrowserDock();
  startPolling();
}

/** 在工具卡里补一条轻量状态，原始 JSON 仍按通用工具卡规则保留。 */
export function renderBrowserInToolCard(part: ToolPart, card: HTMLElement): void {
  if (!part.name?.startsWith("browser_") || !part.result) return;
  interface BrowserToolPayload {
    sessionId?: unknown;
    browserUse?: { sessionId?: unknown; title?: unknown; url?: unknown };
  }
  let data: BrowserToolPayload;
  try { data = JSON.parse(part.result.content) as BrowserToolPayload; } catch { return; }
  const sessionId = typeof data.browserUse?.sessionId === "string"
    ? data.browserUse.sessionId
    : typeof data.sessionId === "string" ? data.sessionId : "";
  if (!sessionId) return;
  openBrowserDock(sessionId);
  const body = card.querySelector(".tool-body");
  if (!body || body.querySelector(".browser-use-card-note")) return;
  const note = document.createElement("button");
  note.type = "button";
  note.className = "browser-use-card-note";
  note.title = "重新打开右侧浏览器画面";
  note.addEventListener("click", () => openBrowserDock(sessionId));
  const strong = document.createElement("strong");
  strong.textContent = "右侧 Browser Use 已打开";
  const detail = document.createElement("span");
  const title = typeof data.browserUse?.title === "string" ? data.browserUse.title : "";
  const url = typeof data.browserUse?.url === "string" ? data.browserUse.url : "";
  detail.textContent = ` · ${title || url || "等待页面画面"}`;
  note.append(strong, detail);
  body.appendChild(note);
}

export function bindBrowserDock(): void {
  $("browser-dock-close")?.addEventListener("click", () => {
    const sessionId = dockSessionId;
    dockSessionId = null;
    hideDockShell();
    if (sessionId) void api(`/api/browser/sessions/${encodeURIComponent(sessionId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }).catch(() => {});
  });

  const screen = $("browser-dock-screen") as HTMLImageElement | null;
  screen?.addEventListener("load", () => {
    screen.classList.add("ready");
    const empty = $("browser-dock-empty");
    if (empty) empty.style.visibility = "hidden";
  });
  screen?.addEventListener("error", () => {
    screen.classList.remove("ready");
    const empty = $("browser-dock-empty");
    if (empty) empty.style.visibility = "visible";
  });

  document.addEventListener("agentatlas:session-selected", (event) => {
    const sessionId = (event as CustomEvent<{ sessionId?: unknown }>).detail?.sessionId;
    if (typeof sessionId !== "string" || sessionId !== dockSessionId) { hideDockShell(); return; }
    showDockShell();
    void refreshBrowserDock();
    startPolling();
  });
}
