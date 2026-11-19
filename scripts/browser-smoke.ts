/**
 * ============================================================
 * browser-smoke.ts — 生产镜像内置浏览器验收
 * ============================================================
 * 使用与运行时完全相同的可执行文件和启动参数，验证多 BrowserContext 隔离、
 * 持久化上下文、真实渲染与截图。只访问内存页面，不读取用户数据或外网。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { browserLaunchArgs, findBrowserExecutable } from "../src/server/browser-runtime.js";

async function main(): Promise<void> {
  const executablePath = findBrowserExecutable();
  if (!executablePath) {
    throw new Error("未找到浏览器：请检查 BROWSER_USE_EXECUTABLE_PATH 或镜像浏览器层");
  }
  const launchOptions = {
    executablePath,
    headless: true,
    args: browserLaunchArgs(),
  } as const;
  const browser = await chromium.launch(launchOptions);
  let profileDir = "";
  try {
    const contextA = await browser.newContext({ viewport: { width: 960, height: 540 } });
    const contextB = await browser.newContext({ viewport: { width: 960, height: 540 } });
    await contextA.addCookies([{ name: "smoke", value: "a", url: "https://agentatlas.invalid/" }]);
    const isolatedCookies = await contextB.cookies("https://agentatlas.invalid/");
    if (isolatedCookies.length !== 0) throw new Error("BrowserContext Cookie 未隔离");

    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    await pageA.setContent(
      "<!doctype html><html><head><title>agentatlas-browser-smoke</title></head>" +
      "<body style=\"font-family:sans-serif\"><h1 id=\"result\">浏览器可用</h1></body></html>",
    );
    await pageB.setContent("<!doctype html><title>context-b</title><p id=\"result\">B</p>");
    const title = await pageA.title();
    const text = await pageA.locator("#result").textContent();
    const screenshot = await pageA.screenshot({ type: "png" });
    if (title !== "agentatlas-browser-smoke" || text !== "浏览器可用" || screenshot.length < 1_000) {
      throw new Error(`浏览器渲染结果异常：title=${title} text=${text} png=${screenshot.length}B`);
    }
    await contextA.close();
    await contextB.close();

    profileDir = await mkdtemp(join(tmpdir(), "agentatlas-browser-profile-"));
    const persistent = await chromium.launchPersistentContext(profileDir, {
      ...launchOptions,
      locale: "zh-CN",
      viewport: { width: 960, height: 540 },
    });
    try {
      const page = persistent.pages()[0] ?? await persistent.newPage();
      await page.setContent("<!doctype html><title>persistent-smoke</title><p id=\"result\">持久化上下文</p>");
      const persistentText = await page.locator("#result").textContent();
      const persistentScreenshot = await page.screenshot({ type: "png" });
      if (persistentText !== "持久化上下文" || persistentScreenshot.length < 1_000) {
        throw new Error(`持久化浏览器上下文异常：text=${persistentText} png=${persistentScreenshot.length}B`);
      }
    } finally {
      await persistent.close().catch(() => {});
    }

    console.log(JSON.stringify({
      ok: true,
      executablePath,
      browserVersion: browser.version(),
      browserContexts: 2,
      persistentContext: true,
      screenshotBytes: screenshot.length,
    }));
  } finally {
    await browser.close().catch(() => {});
    if (profileDir) await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  console.error(`浏览器 smoke 失败：${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
