/**
 * ============================================================
 * desktop/main.ts — Electron 桌面端主进程（TypeScript）
 * ============================================================
 * 策略：桌面端 = 原生窗口 + 托管已有的 Web 服务。
 *   1. 端口被孤儿进程占用时自动顺延，再启动现有 HTTP 服务；
 *   2. 服务就绪探测必须命中本次子进程，子进程提前退出立即失败；
 *   3. BrowserWindow 页面加载遇到短暂断连时退避重试，避免停在错误页；
 *   4. 退出时结束整个子进程树（Windows 上 Electron-as-Node→tsx 子树要 taskkill /T）。
 *
 * 构建：`npm run build:desktop` 把源码编译到 desktop/build/
 * （主进程 .js（ESM）、preload 必须 .cjs —— sandbox 下 preload 只支持 CJS）。
 * 运行：`npm run desktop`（会先跑 predesktop 构建）。
 * 参数：DESKTOP_PORT 覆盖首选端口；DESKTOP_DEVTOOLS=1 打开 DevTools。
 */
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findAvailableDesktopPort, loadUrlWithRetry, waitForServer } from "./startup.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
/** 编译产物在 desktop/build/，仓库根要再上一层 */
const APP_ROOT = path.join(MODULE_DIR, "..", "..");
const PREFERRED_PORT = process.env.DESKTOP_PORT?.trim() ? Number(process.env.DESKTOP_PORT) : 3123;
const READY_TIMEOUT_MS = 90_000;

// 隐藏系统标题栏后，Windows 原生窗口控制键（最小化/最大化/关闭）由 titleBarOverlay
// 绘制，颜色必须与应用深浅主题一致 —— 常量与 styles/tokens.css 的 --topbar-bg / --text-2 对齐
const OVERLAY_HEIGHT = 52; // 与 #topbar 高度一致，控制键垂直居中
const OVERLAY_DARK = { color: "#1b1c1f", symbolColor: "#b9b9c0" } as const;
const OVERLAY_LIGHT = { color: "#f7f8fa", symbolColor: "#575e6c" } as const;

let serverPort = PREFERRED_PORT;
let urlBase = `http://127.0.0.1:${PREFERRED_PORT}`;
let serverChild: ChildProcess | null = null;
let serverStartupError: Error | null = null;
let win: BrowserWindow | null = null;
let quitting = false;

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

// 子进程 relay 的行缓冲
function relay(stream: NodeJS.ReadableStream, tag: string): void {
  let buf = "";
  stream.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    // 服务启动横幅等行直接转发到终端，便于排查端口占用 / 配置错误
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx + 1);
      buf = buf.slice(idx + 1);
      process.stdout.write(`  [${tag}] ${line}`);
    }
  });
}

// ---------------------------------------------------------------------------
// 服务子进程：启动现有 node 服务（tsx 无需预编译）
// ---------------------------------------------------------------------------
function startServer(): ChildProcess {
  // 直接用 Electron 自带 Node 运行 tsx，避免 npx→cmd→tsx→node 多层进程树；
  // 少一层壳就少一类孤儿，也让 Ctrl+C / 崩溃后的端口回收更快。
  const tsxCli = path.join(APP_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  serverStartupError = null;
  const child = spawn(process.execPath, [tsxCli, "src/server/index.ts"], {
    cwd: APP_ROOT,
    windowsHide: true,
    // HOST 强制收缩到 loopback：桌面端窗口永远只连本机服务，
    // 即使用户外部环境变量设了 HOST=0.0.0.0 也不会把接口暴露到局域网
    env: {
      ...process.env,
      PORT: String(serverPort),
      HOST: "127.0.0.1",
      ELECTRON: "1",
      ELECTRON_RUN_AS_NODE: "1",
      // 主进程若被系统直接终止，Web 服务通过该 PID 自检并优雅退出
      ELECTRON_PARENT_PID: String(process.pid),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (child.stdout) relay(child.stdout, "server");
  if (child.stderr) relay(child.stderr, "server:err");

  child.once("error", (err) => {
    if (serverChild !== child || quitting) return;
    serverStartupError = new Error(`Web 服务子进程无法启动：${err.message}`);
  });
  child.once("close", (code, signal) => {
    if (serverChild === child) serverChild = null;
    if (quitting || serverChild !== null) return;

    const reason = code === null ? `信号 ${signal ?? "未知"}` : `退出码 ${code}`;
    const message =
      `Web 服务进程意外退出（${reason}）。\n` +
      `当前桌面端口：${serverPort}。\n` +
      "常见原因：.env/tsconfig 缺失、tsx 未安装或服务启动校验失败。\n" +
      "可查看终端中的 [server:err] 日志，或设置 DESKTOP_PORT 后重试。";
    if (win && !win.isDestroyed()) {
      quitWithError("桌面端服务已退出", message);
      return;
    }
    serverStartupError = new Error(message);
  });

  serverChild = child;
  return child;
}

/** 稳妥终止服务子进程树（npx→tsx 树在 Windows 上必须 taskkill /T） */
function stopServer(): void {
  const child = serverChild;
  if (!child) return;
  const pid = child.pid;
  serverChild = null;
  if (process.platform === "win32" && pid) {
    // 必须同步等 taskkill 完成：spawn 是异步的，Electron 先退出会留下
    // npx→tsx→node 孤儿继续占着端口（真实测试时踩到过）。
    try {
      execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
        timeout: 5_000,
      });
    } catch { /* 已退出 / 权限不足：尽力而为 */ }
  } else if (pid) {
    try { process.kill(pid, "SIGTERM"); } catch { /* 已退出 */ }
  }
}

/** 统一错误退出入口，避免子进程 close 与页面加载失败同时弹两次窗。 */
function quitWithError(title: string, message: string): void {
  if (quitting) return;
  quitting = true;
  stopServer();
  try {
    dialog.showErrorBox(title, `${message}\n\n也可以继续用浏览器运行 npm run web 使用 agentatlas。`);
  } catch { /* Electron 正在退出时忽略对话框异常 */ }
  if (win && !win.isDestroyed()) win.destroy();
  app.quit();
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------
async function createWindow(): Promise<void> {
  const current = new BrowserWindow({
    width: 1280,
    height: 850,
    minWidth: 960,
    minHeight: 620,
    title: "agentatlas · 桌面版",
    backgroundColor: "#101216",
    autoHideMenuBar: true,
    show: false, // 页面成功加载后再显示，避免白屏和错误页闪现
    // Windows：隐藏白底系统标题栏，改用与应用配色一致的 overlay 控制键；
    // 顶栏（#topbar）在 CSS 里标记为拖拽区。非 Windows 保留系统标题栏。
    ...(process.platform === "win32"
      ? { titleBarStyle: "hidden" as const, titleBarOverlay: { ...OVERLAY_DARK, height: OVERLAY_HEIGHT } }
      : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(MODULE_DIR, "preload.cjs"),
    },
  });
  win = current;
  current.on("closed", () => {
    if (win === current) win = null;
  });
  // 外部链接（例如 Markdown 渲染出的 <a target=_blank>）交给系统浏览器，
  // 不在应用窗口里打开，保持聊天界面唯一焦点
  current.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(urlBase)) return { action: "allow" };
    void shell.openExternal(url);
    return { action: "deny" };
  });
  if (process.env.DESKTOP_DEVTOOLS === "1") current.webContents.openDevTools({ mode: "bottom" });

  await loadUrlWithRetry(current, urlBase, {
    onRetry: (failedAttempt, totalAttempts, error) => {
      process.stdout.write(
        `  [desktop] 页面加载失败（${failedAttempt}/${totalAttempts}）：${error.message}\n`,
      );
    },
  });
  if (!quitting && !current.isDestroyed()) current.show();
}

function launchWindow(): void {
  void createWindow().catch((err) => {
    quitWithError("桌面端界面加载失败", errorMessage(err));
  });
}

function registerIpcHandlers(): void {
  // 项目目录选择必须由 Electron 主进程调用原生 dialog；浏览器无法取得绝对路径。
  ipcMain.handle("desktop:pick-directory", async (): Promise<{ canceled: boolean; path?: string; error?: string }> => {
    const options = {
      title: "选择要添加的本地项目文件夹",
      buttonLabel: "添加文件夹",
      defaultPath: app.getPath("home"),
      properties: ["openDirectory", "createDirectory"] as Array<"openDirectory" | "createDirectory">,
    };
    try {
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options);
      const selected = result.filePaths[0];
      return result.canceled || !selected ? { canceled: true } : { canceled: false, path: selected };
    } catch (err) {
      return { canceled: true, error: errorMessage(err) };
    }
  });
  // 前端换肤时同步 overlay 控制键颜色（preload 暴露 window.desktop.setOverlayTheme）
  ipcMain.handle("desktop:overlay-theme", (_event, dark: unknown): boolean => {
    if (process.platform !== "win32" || !win || typeof win.setTitleBarOverlay !== "function") return false;
    try {
      win.setTitleBarOverlay({ ...(dark ? OVERLAY_DARK : OVERLAY_LIGHT), height: OVERLAY_HEIGHT });
      return true;
    } catch { return false; } // 旧版本 Electron / 平台不支持 → 忽略
  });
}

async function bootstrap(): Promise<void> {
  process.stdout.write("  [desktop] 正在检查本机端口…\n");
  serverPort = await findAvailableDesktopPort(PREFERRED_PORT);
  urlBase = `http://127.0.0.1:${serverPort}`;
  if (serverPort !== PREFERRED_PORT) {
    process.stdout.write(`  [desktop] 端口 ${PREFERRED_PORT} 被占用，自动改用 ${serverPort}\n`);
  }

  process.stdout.write("  [desktop] 正在启动服务子进程…\n");
  startServer();
  await waitForServer(urlBase, {
    timeoutMs: READY_TIMEOUT_MS,
    startupError: () => serverStartupError,
  });
  if (serverStartupError) throw serverStartupError;

  registerIpcHandlers();
  launchWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) launchWindow();
  });
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  void app.whenReady()
    .then(bootstrap)
    .catch((err) => quitWithError("桌面端启动失败", errorMessage(err)));

  app.on("window-all-closed", () => {
    quitting = true;
    stopServer();
    app.quit();
  });

  app.on("before-quit", () => {
    quitting = true;
    stopServer();
  });

  // 终端 Ctrl+C 会在 Electron 生命周期事件之前结束主进程；必须显式接管信号，
  // 否则 Electron-as-Node／tsx 子树会残留并继续占用桌面端口（真实冷启动复现）。
  const handleTerminationSignal = (): void => {
    if (quitting) return;
    quitting = true;
    stopServer();
    app.exit(0);
  };
  process.on("SIGINT", handleTerminationSignal);
  process.on("SIGTERM", handleTerminationSignal);
  process.on("exit", stopServer);
}
