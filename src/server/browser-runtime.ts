/**
 * browser-runtime.ts — Chrome/Chromium 可执行文件与容器启动参数
 * ============================================================
 * Browser Use 和求职采集共用同一套探测规则，避免桌面端与容器端各自维护路径。
 * 容器模式只在镜像内显式开启：使用隔离容器补足 Chrome sandbox，禁用 GPU 并
 * 将共享内存压力转移到 /tmp；普通桌面端仍保留系统浏览器沙箱。
 */
import { existsSync } from "node:fs";
import { basename, join } from "node:path";

const BASE_BROWSER_ARGS = [
  "--disable-dev-shm-usage",
  "--no-first-run",
  "--no-default-browser-check",
] as const;

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
      "/usr/local/bin/chromium",
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      // Debian chromium-shell 是 Content Shell，不支持 Playwright 的隔离 BrowserContext，禁止自动探测。
      "/usr/bin/chromium-headless-shell",
      "/usr/bin/microsoft-edge",
    );
  }
  return [...new Set(candidates)];
}

export function findBrowserExecutable(): string | null {
  if (executableCache) return executableCache;
  const found = executableCandidates().find((candidate) => existsSync(candidate)) ?? null;
  // 只缓存成功结果：用户安装浏览器后无需重启服务即可重新检测到。
  if (found) executableCache = found;
  return found;
}

export function browserDisplayName(executable: string): string {
  const name = basename(executable).toLowerCase();
  if (name.includes("headless-shell")) return "Chrome Headless Shell";
  if (name.includes("msedge") || name.includes("microsoft-edge")) return "Microsoft Edge";
  if (name.includes("chrome")) return "Google Chrome";
  if (name.includes("chromium")) return "Chromium";
  return "Chromium";
}

/** 容器模式由 Dockerfile/compose 显式设置，不能由桌面端自动推断后关闭沙箱。 */
export function browserLaunchArgs(extra: readonly string[] = []): string[] {
  const args = [...BASE_BROWSER_ARGS, ...extra];
  if (process.env.BROWSER_USE_CONTAINER === "1") {
    args.push("--disable-gpu", "--no-sandbox");
  }
  return [...new Set(args)];
}

export function resetBrowserRuntimeForTests(): void {
  executableCache = undefined;
}
