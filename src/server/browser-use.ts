/**
 * browser-use.ts — Browser Use 会话管理
 * ============================================================
 * 每个聊天线程拥有独立的无头 Chrome/Edge BrowserContext；AI 通过结构化元素引用
 * 操作页面，前端读取最近一次 PNG 画面。进程不落用户数据目录，空闲 10 分钟回收。
 *
 * 安全边界：仅 http/https；默认拒绝私网；所有文档与子资源请求逐跳走 URL guard；
 * 浏览器上下文隔离、禁止下载与持久化，截图只保存在内存并通过认证 API 返回。
 */
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import type { Browser, BrowserContext, Locator, Page } from "playwright-core";
import { assertAllowedHttpUrl, assertAllowedWebSocketUrl } from "../url-guard.js";
import { writeAudit } from "./audit.js";
import { log } from "./logging.js";

const MAX_SESSIONS = 3;
const IDLE_TTL_MS = 10 * 60_000;
const SWEEP_INTERVAL_MS = 60_000;
const NAVIGATION_TIMEOUT_MS = 25_000;
const ACTION_TIMEOUT_MS = 12_000;
const SCREENSHOT_TIMEOUT_MS = 12_000;
const POST_ACTION_SETTLE_MS = 450;
const TEXT_LIMIT = 6_000;
const ELEMENT_LIMIT = 80;
const ELEMENT_VALUE_LIMIT = 160;
const VIEWPORT = { width: 1280, height: 800 } as const;

export interface BrowserUsePublicStatus {
  available: boolean;
  browserName: string;
  executableName: string;
  activeSessions: number;
  maxSessions: number;
  platform: NodeJS.Platform;
  error?: string;
}

export interface BrowserPageState {
  sessionId: string;
  active: true;
  busy: boolean;
  url: string;
  title: string;
  updatedAt: number;
  viewport: { width: number; height: number };
  error?: string;
}

export interface BrowserSnapshotElement {
  ref: string;
  tag: string;
  role: string;
  label: string;
  type: string;
  value: string;
  placeholder: string;
  href: string;
  disabled: boolean;
  checked?: boolean;
  options?: Array<{ value: string; label: string; selected: boolean }>;
}

export interface BrowserSnapshot {
  text: string;
  elements: BrowserSnapshotElement[];
  truncated: boolean;
}

export interface BrowserToolResult {
  sessionId: string;
  state: BrowserPageState;
  snapshot: BrowserSnapshot;
}

interface BrowserSession {
  id: string;
  context: BrowserContext;
  page: Page;
  allowLocalhost: boolean;
  screenshot: Buffer | null;
  state: BrowserPageState;
  lastAccessAt: number;
  queue: Promise<unknown>;
}

let sharedBrowser: Browser | null = null;
let launching: Promise<Browser> | null = null;
let sweepTimer: ReturnType<typeof setInterval> | null = null;
const sessions = new Map<string, BrowserSession>();
let executableCache: string | null | undefined;

function executableCandidates(): string[] {
  const explicit = process.env.BROWSER_USE_EXECUTABLE_PATH?.trim();
  const candidates = explicit ? [explicit] : [];
  if (process.platform === "win32") {
    for (const root of [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA]) {
      if (!root) continue;
      candidates.push(
        join(root, "Google", "Chrome", "Application", "chrome.exe"),
        join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
        join(root, "Chromium", "Application", "chrome.exe"),
      );
    }
  } else if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    );
  } else {
    candidates.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/microsoft-edge",
    );
  }
  return [...new Set(candidates)];
}

function findBrowserExecutable(): string | null {
  if (executableCache) return executableCache;
  const found = executableCandidates().find((candidate) => existsSync(candidate)) ?? null;
  // 只缓存成功结果：用户安装浏览器后无需重启服务即可重新检测到。
  if (found) executableCache = found;
  return found;
}

function browserDisplayName(executable: string): string {
  const name = basename(executable).toLowerCase();
  if (name.includes("msedge")) return "Microsoft Edge";
  if (name.includes("chrome")) return "Google Chrome";
  if (name.includes("chromium")) return "Chromium";
  return "Chromium";
}

export function getBrowserUsePublicStatus(): BrowserUsePublicStatus {
  const executable = findBrowserExecutable();
  return {
    available: Boolean(executable),
    browserName: executable ? browserDisplayName(executable) : "",
    executableName: executable ? basename(executable) : "",
    activeSessions: sessions.size,
    maxSessions: MAX_SESSIONS,
    platform: process.platform,
    ...(executable ? {} : {
      error: "未找到 Chrome / Edge / Chromium。请安装浏览器，或设置 BROWSER_USE_EXECUTABLE_PATH。",
    }),
  };
}

/** 会话 id 来自聊天 thread_id；严格限制字符集，既防路径注入也便于前端路由编码。 */
export function normalizeBrowserSessionId(raw: unknown): string {
  if (typeof raw !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(raw)) {
    throw new Error("Browser Use 会话 id 非法：只能包含字母、数字、下划线和连字符");
  }
  return raw;
}

async function getBrowser(): Promise<Browser> {
  if (sharedBrowser?.isConnected()) return sharedBrowser;
  if (launching) return launching;
  const executablePath = findBrowserExecutable();
  if (!executablePath) throw new Error(getBrowserUsePublicStatus().error || "未找到可用浏览器");
  launching = (async () => {
    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch({
      executablePath,
      headless: true,
      args: ["--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check"],
    });
    browser.on("disconnected", () => {
      if (sharedBrowser === browser) sharedBrowser = null;
      for (const item of sessions.values()) item.state.error = "浏览器进程已退出，请重新打开页面";
    });
    sharedBrowser = browser;
    return browser;
  })();
  try {
    return await launching;
  } finally {
    launching = null;
  }
}

function latestPage(session: BrowserSession): Page {
  const pages = session.context.pages().filter((page) => !page.isClosed());
  if (pages.length > 0) session.page = pages[pages.length - 1]!;
  return session.page;
}

function setupPage(session: BrowserSession, page: Page): void {
  page.setDefaultTimeout(ACTION_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
  page.on("dialog", (dialog) => { void dialog.dismiss().catch(() => {}); });
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) {
      session.state.url = page.url();
      session.lastAccessAt = Date.now();
    }
  });
}

/** 审计里只保留 origin + path，查询串和 fragment 可能携带登录票据。 */
function safeUrlForAudit(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`.slice(0, 300);
  } catch {
    return raw.slice(0, 300);
  }
}

async function installNetworkGuard(session: BrowserSession, context: BrowserContext): Promise<void> {
  await context.route("**/*", async (route) => {
    const requestUrl = route.request().url();
    if (requestUrl.startsWith("data:") || requestUrl.startsWith("blob:")) {
      if (route.request().isNavigationRequest()) {
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
      return;
    }
    if (!/^https?:/i.test(requestUrl)) {
      if (route.request().isNavigationRequest()) {
        writeAudit("browser.requestBlocked", { sessionId: session.id, reason: "protocol", url: safeUrlForAudit(requestUrl) });
      }
      await route.abort("blockedbyclient");
      return;
    }
    try {
      assertAllowedHttpUrl(requestUrl, session.allowLocalhost);
      await route.continue();
    } catch {
      if (route.request().isNavigationRequest()) {
        writeAudit("browser.requestBlocked", { sessionId: session.id, reason: "private-or-invalid", url: safeUrlForAudit(requestUrl) });
      }
      await route.abort("blockedbyclient");
    }
  });
  // fetch 路由不覆盖 WebSocket；否则页面可通过 ws:// 访问内网或云元数据。
  await context.routeWebSocket(/.*/, (socket) => {
    try {
      assertAllowedWebSocketUrl(socket.url(), session.allowLocalhost);
      socket.connectToServer();
    } catch {
      void socket.close({ code: 1008, reason: "Blocked by Browser Use network guard" });
    }
  });
}

function enqueue<T>(session: BrowserSession, action: () => Promise<T>): Promise<T> {
  // 在入队时立刻续命，避免旧请求排队期间被空闲回收器误关。
  session.lastAccessAt = Date.now();
  const run = session.queue.then(async () => {
    session.lastAccessAt = Date.now();
    session.state.busy = true;
    session.state.error = undefined;
    try {
      return await action();
    } catch (err) {
      session.state.error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      session.state.busy = false;
      session.lastAccessAt = Date.now();
      session.state.updatedAt = Date.now();
    }
  });
  session.queue = run.then(() => undefined, () => undefined);
  return run;
}

async function captureState(session: BrowserSession): Promise<void> {
  const page = latestPage(session);
  await page.waitForLoadState("domcontentloaded", { timeout: 4_000 }).catch(() => {});
  session.state.url = page.url();
  session.state.title = await page.title().catch(() => "");
  session.screenshot = await page.screenshot({
    type: "png",
    animations: "disabled",
    timeout: SCREENSHOT_TIMEOUT_MS,
  });
  session.state.updatedAt = Date.now();
}

async function readSnapshot(page: Page): Promise<BrowserSnapshot> {
  const rawText = await page.evaluate((limit) => (document.body?.innerText || "").slice(0, limit + 1), TEXT_LIMIT)
    .catch(() => "");
  const text = rawText.replace(/[\t ]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  const elements = await page.evaluate(({ limit, valueLimit }) => {
    const nodes: HTMLElement[] = [];
    for (const node of document.querySelectorAll<HTMLElement>(
      "a,button,input,textarea,select,[role='button'],[role='link'],[role='checkbox'],[role='radio'],[contenteditable='true']",
    )) {
      if (nodes.length >= limit) break;
      nodes.push(node);
    }
    return nodes.map((el, index) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const visible = rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      if (!visible) return null;
      const ref = `e${index + 1}`;
      el.setAttribute("data-agentatlas-ref", ref);
      const input = el as HTMLInputElement;
      const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, valueLimit);
      const rawValue = "value" in input ? String(input.value || "") : "";
      const safeValue = input.type === "password" || input.type === "file"
        ? (rawValue ? "••••" : "")
        : rawValue.slice(0, valueLimit);
      return {
        ref,
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute("role") || "",
        label: el.getAttribute("aria-label") || text,
        type: el.getAttribute("type") || "",
        value: safeValue,
        placeholder: el.getAttribute("placeholder") || "",
        href: el instanceof HTMLAnchorElement ? (() => {
          try {
            const target = new URL(el.href);
            target.search = "";
            target.hash = "";
            return target.href.slice(0, 300);
          } catch {
            return "";
          }
        })() : "",
        disabled: Boolean((el as HTMLButtonElement).disabled),
        ...(el instanceof HTMLInputElement && ["checkbox", "radio"].includes(el.type) ? { checked: el.checked } : {}),
        ...(el instanceof HTMLSelectElement ? {
          options: Array.from(el.options).slice(0, 30).map((option) => ({
            value: option.value.slice(0, valueLimit),
            label: option.text.replace(/\s+/g, " ").trim().slice(0, valueLimit),
            selected: option.selected,
          })),
        } : {}),
      };
    }).filter(Boolean);
  }, { limit: ELEMENT_LIMIT, valueLimit: ELEMENT_VALUE_LIMIT }).catch(() => []);
  const normalizedText = text.slice(0, TEXT_LIMIT);
  return {
    text: normalizedText,
    elements: elements.slice(0, ELEMENT_LIMIT) as BrowserSnapshotElement[],
    truncated: rawText.length > TEXT_LIMIT,
  };
}

async function captureAndSnapshot(session: BrowserSession): Promise<BrowserToolResult> {
  await captureState(session);
  const snapshot = await readSnapshot(latestPage(session));
  return { sessionId: session.id, state: { ...session.state }, snapshot };
}

export async function openBrowser(
  rawSessionId: unknown,
  rawUrl: string,
  allowLocalhost = false,
): Promise<BrowserToolResult> {
  const sessionId = normalizeBrowserSessionId(rawSessionId);
  const url = assertAllowedHttpUrl(rawUrl, allowLocalhost);
  let session = sessions.get(sessionId);
  if (!session) {
    if (sessions.size >= MAX_SESSIONS) {
      throw new Error(`Browser Use 同时最多 ${MAX_SESSIONS} 个会话，请先关闭其他会话的浏览器`);
    }
    const browser = await getBrowser();
    let context: BrowserContext | null = null;
    let page: Page;
    try {
      context = await browser.newContext({
        viewport: VIEWPORT,
        locale: "zh-CN",
        acceptDownloads: false,
        serviceWorkers: "block",
      });
      page = await context.newPage();
    } catch (err) {
      if (context) await context.close().catch(() => {});
      if (sessions.size === 0) await closeSharedBrowser();
      throw err;
    }
    session = {
      id: sessionId,
      context,
      page,
      allowLocalhost,
      screenshot: null,
      lastAccessAt: Date.now(),
      queue: Promise.resolve(),
      state: {
        sessionId,
        active: true,
        busy: false,
        url: "about:blank",
        title: "",
        updatedAt: Date.now(),
        viewport: { ...VIEWPORT },
      },
    };
    sessions.set(sessionId, session);
    setupPage(session, page);
    await installNetworkGuard(session, context);
    context.on("page", (next) => {
      if (next === page || next.isClosed()) return;
      session!.page = next;
      setupPage(session!, next);
    });
    startSweeper();
  }
  session.allowLocalhost ||= allowLocalhost;
  return enqueue(session, async () => {
    await latestPage(session!).goto(url.href, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
    await new Promise((resolve) => setTimeout(resolve, POST_ACTION_SETTLE_MS));
    const result = await captureAndSnapshot(session!);
    writeAudit("browser.opened", { sessionId, url: safeUrlForAudit(url.href) });
    return result;
  });
}

function requireSession(rawSessionId: unknown): BrowserSession {
  const sessionId = normalizeBrowserSessionId(rawSessionId);
  const session = sessions.get(sessionId);
  if (!session) throw new Error("Browser Use 尚未打开：请先调用 browser_open");
  return session;
}

export async function snapshotBrowser(rawSessionId: unknown): Promise<BrowserToolResult> {
  const session = requireSession(rawSessionId);
  return enqueue(session, () => captureAndSnapshot(session));
}

export async function navigateBrowser(
  rawSessionId: unknown,
  action: "back" | "forward",
): Promise<BrowserToolResult> {
  const session = requireSession(rawSessionId);
  return enqueue(session, async () => {
    const page = latestPage(session);
    if (action === "back") {
      if (!await page.goBack({ waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS })) {
        throw new Error("当前浏览器没有可后退的历史页面");
      }
    } else if (action === "forward") {
      if (!await page.goForward({ waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS })) {
        throw new Error("当前浏览器没有可前进的历史页面");
      }
    }
    await new Promise((resolve) => setTimeout(resolve, POST_ACTION_SETTLE_MS));
    return captureAndSnapshot(session);
  });
}

function elementLocator(session: BrowserSession, ref: string): Locator {
  if (!/^e\d+$/.test(ref)) throw new Error("元素引用格式非法：请先 browser_snapshot，再使用返回的 e1/e2… 引用");
  const locator = latestPage(session).locator(`[data-agentatlas-ref="${ref}"]`);
  return locator;
}

export async function actOnBrowser(
  rawSessionId: unknown,
  action: "click" | "type" | "press" | "select",
  input: { ref?: string; text?: string; key?: string; value?: string; submit?: boolean },
): Promise<BrowserToolResult> {
  const session = requireSession(rawSessionId);
  return enqueue(session, async () => {
    const page = latestPage(session);
    if (action === "press") {
      const key = String(input.key || "").trim();
      if (!/^(?:[A-Za-z0-9]|Arrow(?:Up|Down|Left|Right)|Enter|Escape|Tab|Backspace|Delete|Home|End|PageUp|PageDown|Space)(?:\+(?:[A-Za-z0-9]|Shift|Control|Alt|Meta))*$/.test(key)) {
        throw new Error("key 格式非法：示例 Enter、Tab、Control+L");
      }
      await page.keyboard.press(key);
    } else {
      const ref = String(input.ref || "").trim();
      const locator = elementLocator(session, ref);
      if (await locator.count() !== 1) throw new Error(`元素引用 ${ref || "（空）"} 已失效，请先 browser_snapshot`);
      if (!(await locator.isVisible().catch(() => false))) throw new Error(`元素 ${ref} 当前不可见，请重新 browser_snapshot`);
      if (action === "click") {
        await locator.click({ timeout: ACTION_TIMEOUT_MS });
      } else if (action === "type") {
        await locator.fill(String(input.text || ""), { timeout: ACTION_TIMEOUT_MS });
        if (input.submit) await locator.press("Enter", { timeout: ACTION_TIMEOUT_MS });
      } else {
        await locator.selectOption(String(input.value || ""), { timeout: ACTION_TIMEOUT_MS });
      }
    }
    await new Promise((resolve) => setTimeout(resolve, POST_ACTION_SETTLE_MS));
    return captureAndSnapshot(session);
  });
}

export async function scrollBrowser(
  rawSessionId: unknown,
  direction: "up" | "down",
  amount = 600,
): Promise<BrowserToolResult> {
  const session = requireSession(rawSessionId);
  const delta = Math.max(100, Math.min(2_000, Math.round(amount))) * (direction === "up" ? -1 : 1);
  return enqueue(session, async () => {
    await latestPage(session).mouse.wheel(0, delta);
    await new Promise((resolve) => setTimeout(resolve, POST_ACTION_SETTLE_MS));
    return captureAndSnapshot(session);
  });
}

export function getBrowserPageState(rawSessionId: unknown): BrowserPageState | null {
  const sessionId = normalizeBrowserSessionId(rawSessionId);
  const session = sessions.get(sessionId);
  return session ? { ...session.state } : null;
}

export function getBrowserScreenshot(rawSessionId: unknown): Buffer | null {
  const session = sessions.get(normalizeBrowserSessionId(rawSessionId));
  return session?.screenshot ?? null;
}

export async function closeBrowserSession(rawSessionId: unknown): Promise<boolean> {
  const sessionId = normalizeBrowserSessionId(rawSessionId);
  const session = sessions.get(sessionId);
  if (!session) return false;
  sessions.delete(sessionId);
  await session.context.close().catch(() => {});
  writeAudit("browser.closed", { sessionId });
  if (sessions.size === 0) {
    await closeSharedBrowser();
    if (sweepTimer) clearInterval(sweepTimer);
    sweepTimer = null;
  }
  return true;
}

async function closeSharedBrowser(): Promise<void> {
  const browser = sharedBrowser;
  sharedBrowser = null;
  if (!browser) return;
  await browser.close().catch(() => {});
}

export async function closeAllBrowserSessions(): Promise<void> {
  const entries = [...sessions.entries()];
  sessions.clear();
  await Promise.allSettled(entries.map(([, session]) => session.context.close().catch(() => {})));
  await closeSharedBrowser();
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}

function startSweeper(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    const cutoff = Date.now() - IDLE_TTL_MS;
    for (const [id, session] of sessions) {
      if (!session.state.busy && session.lastAccessAt < cutoff) {
        sessions.delete(id);
        void session.context.close().catch(() => {});
        writeAudit("browser.idleClosed", { sessionId: id });
      }
    }
    if (sessions.size === 0) {
      if (sharedBrowser) void closeSharedBrowser();
      if (sweepTimer) clearInterval(sweepTimer);
      sweepTimer = null;
    }
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref();
}

// 导出内部清理状态供单测隔离使用；生产路径只用 closeAllBrowserSessions。
export async function resetBrowserUseForTests(): Promise<void> {
  await closeAllBrowserSessions();
  executableCache = undefined;
}
