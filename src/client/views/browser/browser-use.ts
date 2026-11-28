/**
 * views/browser-use.ts — Browser Use 右侧实时画面：轮询与状态机（M4 批次 4.4 起）
 * ============================================================
 * 面板渲染已迁往 Vue（browser-dock-vue.vue + stores/browser-dock.ts）；本文件
 * 保留全部「行为」职责：
 *  1. 1.2s 轮询认证 API（画面内容不落 localStorage）；
 *  2. 会话隔离判定（当前会话一变就收起，返回原会话再恢复）；
 *  3. 关闭按钮的服务端会话清理；
 *  4. 工具卡上的「重新打开」提示（由通用工具卡增强注册表调用）。
 * 渲染数据经 window 快照通道推给 Vue（bundle 与 1:1 副本是两个模块实例，
 * 各有独立 pinia；e2e 从 1:1 副本驱动时只有 window 两边都可见）。
 */
import { api } from "../../core/api.js";
import { $ } from "../../core/dom.js";
import { state } from "../../core/state.js";
import type { BrowserDockSnapshot } from "../../stores/browser/browser-dock.js";
import type { BrowserPageState, ToolPart } from "../../modules/types.js";

const POLL_INTERVAL_MS = 1_200;

let pollTimer: ReturnType<typeof setInterval> | null = null;
let dockSessionId: string | null = null;
let lastUpdatedAt = 0;
let pollInFlight = false;
/** 上一次发布的快照：同会话的字段增量合并，字段未变就不推送。 */
let lastSnapshot: BrowserDockSnapshot | null = null;

// ---------------------------------------------------------------------------
// 求职采集实时画面（job 源）：采集/登录浏览器是无头的，右侧画面是用户唯一
// 能「看着采集」的窗口。job 模式与 Browser Use 会话模式互斥 —— 已在看
// Browser Use 时不抢占；采集结束时连续两次探到无活动才收起（防轮询间隙闪退）。
// ---------------------------------------------------------------------------
interface JobLiveView {
  phase: "login" | "collecting";
  platform: string;
  collected: number;
  message: string;
  url: string;
  startedAt: number;
}
let jobMode = false;
let jobIdlePolls = 0;
let jobBoundSession: string | null = null;

function publish(partial: Partial<BrowserDockSnapshot> & { visible: boolean }): void {
  const base: BrowserDockSnapshot = {
    sessionId: dockSessionId ?? "",
    visible: partial.visible,
    title: "等待网页",
    url: "about:blank",
    stateText: "未连接",
    stateTone: "",
    meta: "会话隔离 · 空闲 10 分钟自动关闭",
    screenshotSrc: "",
    emptyVisible: true,
    emptyTitle: "等待 Agent 打开网页",
    emptyDetail: "浏览器画面会在这里实时更新",
  };
  const carried = lastSnapshot && lastSnapshot.sessionId === (dockSessionId ?? "") ? lastSnapshot : null;
  const next: BrowserDockSnapshot = { ...base, ...(carried ?? {}), ...partial, sessionId: dockSessionId ?? "" };
  const changed = JSON.stringify(next) !== JSON.stringify(lastSnapshot);
  lastSnapshot = next;
  if (!changed) return;
  // 直接写 window：本模块在 1:1 过渡树上（e2e 从副本驱动），
  // 动态 import stores/browser-dock.js 会因裸包名 pinia 解析失败。
  // Vue 组件在 bundle 侧订阅同一份快照，window 是两边唯一共同通道。
  window.__agentatlasBrowserDock = next;
  for (const listener of window.__agentatlasBrowserDockListeners ?? []) listener();
}

function showDockShell(): void {
  $("main")?.classList.add("browser-open");
  publish({ visible: true });
}

function hideDockShell(): void {
  $("main")?.classList.remove("browser-open");
  stopPolling();
  publish({ visible: false, stateText: "未连接", stateTone: "" });
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
  const shotChanged = page.updatedAt !== lastUpdatedAt;
  if (shotChanged) lastUpdatedAt = page.updatedAt;
  publish({
    visible: true,
    title: page.title || page.url || "未命名页面",
    url: page.url || "about:blank",
    meta: `更新于 ${new Date(page.updatedAt).toLocaleTimeString()} · 会话隔离`,
    stateText: page.error ? "页面异常" : page.busy ? "AI 操作中" : "实时连接",
    stateTone: page.error ? "" : page.busy ? "busy" : "live",
    emptyVisible: Boolean(page.error),
    ...(shotChanged
      ? { screenshotSrc: `/api/browser/sessions/${encodeURIComponent(page.sessionId)}/screenshot?v=${page.updatedAt}` }
      : {}),
    ...(page.error
      ? { emptyTitle: page.error, emptyDetail: "请让 Agent 重新打开或刷新页面" }
      : {}),
  });
}

function applyJobView(view: JobLiveView): void {
  const label = view.phase === "login" ? "平台登录" : "岗位采集";
  const title = view.platform && view.platform !== "预检" ? `${label} · ${view.platform}` : label;
  publish({
    visible: true,
    title,
    url: view.url || "about:blank",
    meta: `已采集 ${view.collected} 条 · ${new Date(view.startedAt).toLocaleTimeString()} 开始`,
    stateText: view.message,
    stateTone: "busy",
    // 每轮都换 v 强制刷新（截图端点无 updatedAt 概念，画面就是要逐帧看）。
    screenshotSrc: `/api/job/browser/screenshot?v=${Date.now()}`,
    emptyVisible: false,
  });
}

async function refreshJobView(): Promise<void> {
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    const data = await api<{ view: JobLiveView | null }>("/api/job/browser/view");
    if (!data.view) {
      // 连续两轮无活动才收起：采集两个阶段之间（预检 → 正式采集）短暂空窗不闪退。
      if (++jobIdlePolls >= 2) { jobMode = false; hideDockShell(); }
      return;
    }
    jobIdlePolls = 0;
    showDockShell();
    applyJobView(data.view);
  } catch {
    if (++jobIdlePolls >= 3) { jobMode = false; hideDockShell(); }
  } finally {
    pollInFlight = false;
  }
}

async function refreshBrowserDock(): Promise<void> {
  if (jobMode) return refreshJobView();
  if (!dockSessionId || pollInFlight) return;
  if (state.currentId !== dockSessionId) { hideDockShell(); return; }
  pollInFlight = true;
  try {
    const page = await api<BrowserPageState>(`/api/browser/sessions/${encodeURIComponent(dockSessionId)}`);
    if (state.currentId !== dockSessionId) { hideDockShell(); return; }
    showDockShell();
    applyPageState(page);
  } catch (err) {
    publish({
      visible: true,
      stateText: "已关闭",
      stateTone: "",
      meta: err instanceof Error ? err.message : String(err),
      screenshotSrc: "",
    });
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
  jobMode = false; // Browser Use 会话优先：采集画面让位，不能两个源打架
  dockSessionId = sessionId;
  lastUpdatedAt = 0;
  publish({
    visible: true,
    title: "正在连接浏览器",
    url: "about:blank",
    stateText: "连接中",
    stateTone: "busy",
    screenshotSrc: "",
    emptyVisible: true,
    emptyTitle: "等待 Agent 打开网页",
    emptyDetail: "浏览器画面会在这里实时更新",
  });
  if (state.currentId !== sessionId) { hideDockShell(); return; }
  $("main")?.classList.add("browser-open");
  void refreshBrowserDock();
  startPolling();
}

/**
 * 求职采集 / 平台登录有活动：打开或保活 job 源画面。
 * 调用方：chat 流的 job_progress 事件、设置页登录按钮。
 * 已在看 Browser Use 时不抢占（那个会话结束时画面自然空出来）。
 */
export function notifyJobLiveProgress(): void {
  if (dockSessionId) return;
  if (jobMode) { jobIdlePolls = 0; return; }
  openJobBrowserDock();
}

/** 打开 job 源画面并开始轮询；绑定发起时的会话（切走即收起）。 */
export function openJobBrowserDock(): void {
  jobMode = true;
  jobIdlePolls = 0;
  jobBoundSession = state.currentId;
  publish({
    visible: true,
    title: "岗位采集",
    url: "about:blank",
    stateText: "连接采集画面",
    stateTone: "busy",
    screenshotSrc: "",
    emptyVisible: true,
    emptyTitle: "等待采集画面",
    emptyDetail: "采集浏览器启动后（登录预检 → 逐平台采集）画面会在这里实时更新",
  });
  $("main")?.classList.add("browser-open");
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

/** 关闭命令入口：Vue 的关闭按钮只触发命令，服务端清理仍在这里。 */
function closeDockSession(): void {
  const sessionId = dockSessionId;
  const wasJob = jobMode;
  jobMode = false;
  dockSessionId = null;
  hideDockShell();
  // job 源没有服务端会话要清理：采集还在后台继续，画面只是观察窗口。
  if (wasJob || !sessionId) return;
  void api(`/api/browser/sessions/${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  }).catch(() => {});
}

export function bindBrowserDock(): void {
  window.__agentatlasBrowserDockCommands = { close: closeDockSession };
  // 面板挂载一次（幂等）：启动即挂上空态，首次 openBrowserDock 直接可见。
  void import("./browser-dock-vue.js")
    .then((m) => m.mountBrowserDockVue())
    .catch(() => {});

  document.addEventListener("agentatlas:session-selected", (event) => {
    const sessionId = (event as CustomEvent<{ sessionId?: unknown }>).detail?.sessionId;
    if (jobMode) {
      // job 画面绑定发起采集的会话：切到别的会话就收起（回原会话且采集仍在跑时，
      // 下一条 job_progress 或手动操作会再打开）。
      if (sessionId !== jobBoundSession) { jobMode = false; hideDockShell(); }
      return;
    }
    if (typeof sessionId !== "string" || sessionId !== dockSessionId) { hideDockShell(); return; }
    showDockShell();
    void refreshBrowserDock();
    startPolling();
  });
}
