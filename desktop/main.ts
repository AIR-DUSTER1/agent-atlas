/**
 * ============================================================
 * desktop/main.ts — Electron 桌面端主进程（TypeScript）
 * ============================================================
 * 策略：桌面端 = 原生窗口 + 托管已有的 Web 服务。
 *   1. 以子进程启动现有 HTTP 服务（npx tsx src/server/index.ts，独立端口
 *      避免与开发者终端里的 npm run web 抢 3000）；
 *   2. 轮询等端口就绪后创建 BrowserWindow 加载 http://127.0.0.1:<port>；
 *   3. 退出时结束整个子进程树（Windows 上 npx→node→tsx 树要 taskkill /T）。
 *
 * 构建：`npm run build:desktop` 把本文件与 preload 编译到 desktop/build/
 * （主进程 .js（ESM）、preload 必须 .cjs —— sandbox 下 preload 只支持 CJS）。
 * 运行：`npm run desktop`（会先跑 predesktop 构建）。
 * 参数：DESKTOP_PORT 覆盖默认端口；DESKTOP_DEVTOOLS=1 打开 DevTools。
 */
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
/** 编译产物在 desktop/build/，仓库根要再上一层 */
const APP_ROOT = path.join(MODULE_DIR, "..", "..");
const PORT = Number(process.env.DESKTOP_PORT || 3123);
const URL_BASE = `http://127.0.0.1:${PORT}`;
const READY_TIMEOUT_MS = 90_000;

// 隐藏系统标题栏后，Windows 原生窗口控制键（最小化/最大化/关闭）由 titleBarOverlay
// 绘制，颜色必须与应用深浅主题一致 —— 常量与 styles/tokens.css 的 --topbar-bg / --text-2 对齐
const OVERLAY_HEIGHT = 52; // 与 #topbar 高度一致，控制键垂直居中
const OVERLAY_DARK = { color: "#1b1c1f", symbolColor: "#b9b9c0" } as const;
const OVERLAY_LIGHT = { color: "#f7f8fa", symbolColor: "#575e6c" } as const;

let serverChild: ChildProcess | null = null;
let win: BrowserWindow | null = null;
let quitting = false;

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
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  const useShell = process.platform === "win32"; // Node 安全策略：.cmd 必须 shell 启动
  const child = spawn(npx, ["tsx", "src/server/index.ts"], {
    cwd: APP_ROOT,
    shell: useShell,
    windowsHide: true,
    // HOST 强制收缩到 loopback：桌面端窗口永远只连本机服务，
    // 即使用户外部环境变量设了 HOST=0.0.0.0 也不会把接口暴露到局域网
    env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", ELECTRON: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (child.stdout) relay(child.stdout, "server");
  if (child.stderr) relay(child.stderr, "server:err");
  child.on("close", (code) => {
    serverChild = null;
    if (!quitting && win) {
      win.close();
      dialog.showErrorBox(
        "桌面端服务已退出",
        `Web 服务进程意外退出（退出码 ${code ?? "未知"}）。\n常见原因：端口 ${PORT} 被占用、.env/tsconfig 缺失、tsx 未安装。\n可尝试设置 DESKTOP_PORT 环境变量换端口后重试。`
      );
      app.quit();
    }
  });
  serverChild = child;
  return child;
}

/** 轮询端口直到服务可连接（超时抛错） */
function waitReady(timeoutMs: number): Promise<true> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const scheduleNext = (): void => {
      if (Date.now() > deadline) {
        reject(new Error(`在 ${Math.round(timeoutMs / 1000)}s 内未能连上 ${URL_BASE}（服务启动超时）`));
        return;
      }
      setTimeout(probe, 600);
    };
    const probe = (): void => {
      const req = http.get(URL_BASE + "/api/config", { timeout: 2500 }, (res) => {
        res.resume(); // 只要能建立 HTTP 响应就算就绪
        resolve(true);
      });
      req.on("error", scheduleNext);
      req.on("timeout", () => { req.destroy(); scheduleNext(); });
    };
    probe();
  });
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------
function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 850,
    minWidth: 960,
    minHeight: 620,
    title: "agent-tools · 桌面版",
    backgroundColor: "#101216",
    autoHideMenuBar: true,
    show: false, // ready-to-show 再显示，避免白屏闪烁
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
  void win.loadURL(URL_BASE);
  win.once("ready-to-show", () => win?.show());
  win.on("closed", () => { win = null; });
  // 外部链接（例如 Markdown 渲染出的 <a target=_blank>）交给系统浏览器，
  // 不在应用窗口里打开，保持聊天界面唯一焦点
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(URL_BASE)) return { action: "allow" };
    void shell.openExternal(url);
    return { action: "deny" };
  });
  if (process.env.DESKTOP_DEVTOOLS === "1") win.webContents.openDevTools({ mode: "bottom" });
}

/** 稳妥终止服务子进程树（npx→tsx 树在 Windows 上必须 taskkill /T） */
function stopServer(): void {
  const child = serverChild;
  if (!child) return;
  const pid = child.pid;
  serverChild = null;
  if (process.platform === "win32" && pid) {
    // 必须同步等 taskkill 完成：spawn 是异步的，Electron 先退出会留下
    // npx→tsx→node 孤儿继续占着 3123（真实测试时踩到过）。
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

  void app.whenReady().then(async () => {
    process.stdout.write("  [desktop] 正在启动服务子进程…\n");
    startServer();
    try {
      await waitReady(READY_TIMEOUT_MS);
    } catch (err) {
      stopServer();
      dialog.showErrorBox(
        "桌面端启动失败",
        String((err as Error)?.message ?? err) + "\n\n也可以继续用浏览器访问 npm run web 的方式使用 agent-tools。"
      );
      app.quit();
      return;
    }
    createWindow();
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
        return { canceled: true, error: err instanceof Error ? err.message : String(err) };
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
    app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });

  app.on("window-all-closed", () => {
    quitting = true;
    stopServer();
    app.quit();
  });

  app.on("before-quit", () => {
    quitting = true;
    stopServer();
  });

  process.on("exit", stopServer);
}
