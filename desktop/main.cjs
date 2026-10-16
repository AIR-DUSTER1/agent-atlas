/**
 * ============================================================
 * desktop/main.cjs — Electron 桌面端主进程
 * ============================================================
 * 策略：桌面端 = 原生窗口 + 托管已有的 Web 服务。
 *   1. 以子进程启动现有 HTTP 服务（npx tsx src/server/index.ts，
 *      用独立端口避免与开发者终端里的 npm run web 抢 3000）；
 *   2. 轮询等端口就绪后创建 BrowserWindow 加载 http://127.0.0.1:<port>；
 *   3. 退出时结束整个子进程树（Windows 上 npx→node→tsx 树要 taskkill /T）。
 *
 * 好处：前端 / 服务端逻辑零改动；npm run web 照旧可用（同一配置文件）。
 *
 * 运行：npm run desktop  （首次需 npm i 之后 npx electron 会按 devDependency 安装）
 * 参数：环境变量 DESKTOP_PORT 覆盖默认端口；DESKTOP_DEVTOOLS=1 打开 DevTools。
 */
const { app, BrowserWindow, dialog } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const http = require("node:http");

const APP_ROOT = path.join(__dirname, "..");
const PORT = Number(process.env.DESKTOP_PORT || 3123);
const URL_BASE = `http://127.0.0.1:${PORT}`;
const READY_TIMEOUT_MS = 90_000;

let serverChild = null;
let win = null;
let quitting = false;

// ---------------------------------------------------------------------------
// 服务子进程：启动现有 node 服务（tsx 无需预编译）
// ---------------------------------------------------------------------------
function startServer() {
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  const shell = process.platform === "win32"; // Node 安全策略：.cmd 必须 shell 启动
  serverChild = spawn(npx, ["tsx", "src/server/index.ts"], {
    cwd: APP_ROOT,
    shell,
    windowsHide: true,
    env: { ...process.env, PORT: String(PORT), ELECTRON: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const relay = (stream, tag) => {
    let buf = "";
    stream.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      // 服务启动横幅等行直接转发到终端，便于排查端口占用 / 配置错误
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx + 1);
        buf = buf.slice(idx + 1);
        process.stdout.write(`  [${tag}] ${line}`);
      }
    });
  };
  relay(serverChild.stdout, "server");
  relay(serverChild.stderr, "server:err");
  serverChild.on("close", (code) => {
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
  return serverChild;
}

/** 轮询端口直到服务可连接（超时抛错） */
function waitReady(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const probe = () => {
      const req = http.get(URL_BASE + "/api/config", { timeout: 2500 }, (res) => {
        res.resume(); // 只要能建立 HTTP 响应就算就绪
        resolve(true);
      });
      req.on("error", scheduleNext);
      req.on("timeout", () => { req.destroy(); scheduleNext(); });
    };
    const scheduleNext = () => {
      if (Date.now() > deadline) {
        reject(new Error(`在 ${Math.round(timeoutMs / 1000)}s 内未能连上 ${URL_BASE}（服务启动超时）`));
        return;
      }
      setTimeout(probe, 600);
    };
    probe();
  });
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------
function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 850,
    minWidth: 960,
    minHeight: 620,
    title: "LangGraph Agent · 桌面版",
    backgroundColor: "#101216",
    autoHideMenuBar: true,
    show: false, // ready-to-show 再显示，避免白屏闪烁
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadURL(URL_BASE);
  win.once("ready-to-show", () => win.show());
  win.on("closed", () => { win = null; });
  // 外部链接（例如 Markdown 渲染出的 <a target=_blank>）交给系统浏览器，
  // 不在应用窗口里打开，保持聊天界面唯一焦点
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(URL_BASE)) return { action: "allow" };
    require("electron").shell.openExternal(url);
    return { action: "deny" };
  });
  if (process.env.DESKTOP_DEVTOOLS === "1") win.webContents.openDevTools({ mode: "bottom" });
}

/** 稳妥终止服务子进程树（npx→tsx 树在 Windows 上必须 taskkill /T） */
function stopServer() {
  if (!serverChild) return;
  const pid = serverChild.pid;
  serverChild = null;
  if (process.platform === "win32" && pid) {
    try { spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }); } catch { /* 尽力而为 */ }
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

  app.whenReady().then(async () => {
    process.stdout.write("  [desktop] 正在启动服务子进程…\n");
    startServer();
    try {
      await waitReady(READY_TIMEOUT_MS);
    } catch (err) {
      stopServer();
      dialog.showErrorBox("桌面端启动失败", String(err?.message ?? err) +
        `\n\n也可以继续用浏览器访问 npm run web 的方式使用工作台。`);
      app.quit();
      return;
    }
    createWindow();
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
