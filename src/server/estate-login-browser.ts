/**
 * estate-login-browser.ts — 贝壳受控登录窗口
 * ============================================================
 * 官方 /auth/callback 当前直接 404，普通系统浏览器无法完成 postMessage 回调。
 * 这里启动一个可见的 Playwright 浏览器，仅在内存中拦截该导航并回传一次性 state；
 * 原始 building.ke.com 页面继续用浏览器自身 Cookie 换 Bearer Key，随后窗口自动关闭。
 */
import { findBrowserExecutable } from "./browser-use.js";

const BEIKE_LOGIN_URL = "https://building.ke.com/?action=get-key&source=beike_skill";
const BEIKE_CALLBACK_ROUTE = /^https:\/\/building\.ke\.com\/auth\/callback(?:\?.*)?$/;
const BEIKE_LOGIN_WAIT_MS = 180_000;
const BEIKE_LOGIN_NAV_TIMEOUT_MS = 30_000;
const BEIKE_CALLBACK_RELAY_HTML = `<!doctype html>
<meta charset="utf-8">
<title>贝壳登录</title>
<body style="font:14px system-ui;padding:24px">
正在返回贝壳登录页…
<script>
(() => {
  const params = new URLSearchParams(location.search);
  const state = params.get("state");
  const ticket = params.get("ticket");
  const target = location.origin;
  if (state && window.opener && !window.opener.closed) {
    window.opener.postMessage({ type: "alps-state", state }, target);
    setTimeout(() => window.close(), 100);
    return;
  }
  if (ticket && window.opener && !window.opener.closed) {
    window.opener.postMessage({ type: "cas-ticket", ticket }, target);
    setTimeout(() => window.close(), 100);
    return;
  }
  document.body.textContent = "登录回调缺少状态或原登录页已关闭，请回到 agentatlas 重新登录。";
})();
</script>`;

export interface ManagedBeikeLoginResult {
  ok: boolean;
  opened: boolean;
  message: string;
}

export interface ManagedBeikeLoginOptions {
  /** 仅用于自动化冒烟；产品入口必须保持 false，让用户能看到二维码。 */
  headless?: boolean;
  timeoutMs?: number;
}

/** 回调中转页只读取 URL 中的一次性票据，不写日志、不持久化。 */
export function beikeCallbackRelayHtml(): string {
  return BEIKE_CALLBACK_RELAY_HTML;
}

/** 轮询官方原页：成功取 localStorage Key；失败尽早返回页面可见错误，避免死等超时。 */
async function waitForBearerKey(page: import("playwright-core").Page, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (page.isClosed()) throw new Error("贝壳登录窗口已关闭");
    const state = await page.evaluate(() => ({
      key: (() => {
        try { return window.localStorage.getItem("bk_bearer_key") || ""; } catch { return ""; }
      })(),
      text: (document.body?.innerText || "").slice(-4_000),
    })).catch(() => ({ key: "", text: "" }));
    if (state.key.trim()) return state.key.trim();
    const visibleError = state.text.match(/(?:登录失败|凭证获取失败|登录态换取失败|二维码不存在或已过期|登录已过期)[^\n]{0,160}/);
    if (visibleError) throw new Error(visibleError[0].trim());
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("BEIKE_LOGIN_TIMEOUT");
}

/**
 * 可见浏览器内完成扫码登录：拦截坏掉的官方回调路径，让官方原页面自己完成
 * complete + web_silent_register，再从同源 localStorage 取出 Key 交给保存函数。
 */
export async function loginBeikeInManagedBrowser(
  saveKey: (key: string) => Promise<{ ok: boolean; message: string }>,
  options: ManagedBeikeLoginOptions = {}
): Promise<ManagedBeikeLoginResult> {
  const executablePath = findBrowserExecutable();
  if (!executablePath) {
    return {
      ok: false,
      opened: false,
      message: "未找到 Chrome / Edge / Chromium。请安装浏览器，或设置 BROWSER_USE_EXECUTABLE_PATH。",
    };
  }

  let browser: import("playwright-core").Browser | null = null;
  let opened = false;
  try {
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch({
      executablePath,
      headless: options.headless === true,
      args: ["--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check"],
    });
    opened = true;
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      locale: "zh-CN",
    });
    await context.route(BEIKE_CALLBACK_ROUTE, (route) => route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: BEIKE_CALLBACK_RELAY_HTML,
    }));
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    await page.goto(BEIKE_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: BEIKE_LOGIN_NAV_TIMEOUT_MS });
    await page.bringToFront();

    const scanButton = page.getByRole("button", { name: /前往扫码登录/ });
    if (!(await scanButton.isVisible().catch(() => false))) {
      const getKeyButton = page.getByRole("button", { name: /获取 Bearer Key/ }).first();
      if (await getKeyButton.isVisible().catch(() => false)) await getKeyButton.click();
    }
    await scanButton.waitFor({ state: "visible", timeout: 15_000 });
    const popupPromise = context.waitForEvent("page", { timeout: 15_000 }).catch(() => null);
    await scanButton.click();
    const popup = await popupPromise;
    if (popup) await popup.bringToFront().catch(() => {});

    const key = await waitForBearerKey(page, options.timeoutMs ?? BEIKE_LOGIN_WAIT_MS);
    const saved = await saveKey(key);
    return { ok: saved.ok, opened: true, message: saved.message };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const message = raw === "BEIKE_LOGIN_TIMEOUT"
      ? "等待扫码超时（最多 3 分钟），请重新点击「打开官方登录页」"
      : `贝壳受控登录未完成：${raw}`;
    return { ok: false, opened, message };
  } finally {
    await browser?.close().catch(() => {});
  }
}
