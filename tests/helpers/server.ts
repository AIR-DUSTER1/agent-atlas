/**
 * tests/helpers/server.ts — 集成/安全测试的临时服务端托管
 * ============================================================
 * 直接 spawn node + tsx loader（不走 npx/cmd 壳，减少孤儿进程），
 * 端口用系统分配的临时端口；journal 指向临时目录（见 session-store 的
 * SESSIONS_FILE 测试钩子），不污染真实 .setting/ 数据。
 * 强制 API_KEY="" 进入 mock 模式：测试绝不消耗真实模型配额。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface RunningServer {
  base: string;
  proc: ChildProcess;
  journalPath: string;
  output: () => string;
  stop: () => Promise<void>;
}

/** 取一个系统分配的临时端口（listen 0 → 读端口 → 关闭，竞态窗口极小） */
export function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolvePort(port) : reject(new Error("无法分配测试端口"))));
    });
  });
}

/** 一次性 GET（agent:false 不复用连接）——就绪探测专用 */
function probeStatus(url: string): Promise<number> {
  return new Promise((resolveStatus, reject) => {
    const req = request(url, { method: "GET", agent: false }, (res) => {
      res.resume();
      res.on("end", () => resolveStatus(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end();
  });
}

async function waitReady(base: string, proc: ChildProcess, output: () => string): Promise<void> {
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) break;
    try {
      // 开认证时 /api/sessions 回 401 也算「已就绪」。
      // 用 agent:false 的一次性请求探测：避免 undici 把 keep-alive 连接留在池里，
      // 首个测试请求复用后撞上 server.keepAliveTimeout（5s）造成假慢。
      const status = await probeStatus(`${base}/api/sessions`);
      if (status === 200 || status === 401) return;
    } catch { /* 服务还没监听 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("服务启动失败：\n" + output().slice(-3000));
}

export async function startServer(extraEnv: Record<string, string> = {}): Promise<RunningServer> {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), "lg-agent-test-"));
  const journalPath = join(dir, "sessions.ndjson");
  const configPath = join(dir, ".web-config.json");
  const proc = spawn(process.execPath, ["--import", "tsx", join(REPO_ROOT, "src/server/index.ts")], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      API_KEY: "",              // mock 模式：不碰真实模型
      AUTH_TOKEN: "",
      BEIKE_DISABLE_AUTO_INSTALL: "1",
      SESSIONS_FILE: journalPath,
      CHECKPOINT_FILE: join(dir, "checkpoints.ndjson"), // 隔离真实检查点日志（restore 会读它做续聊判定）
      MEMORIES_FILE: join(dir, "memories.json"), // 隔离真实长期记忆（启动 loadMemories / 记忆 API 都碰它）
      WEB_CONFIG_FILE: configPath, // 隔离真实 .web-config.json（其中可能有供应商 Key）
      AUDIT_FILE: join(dir, "audit.ndjson"), // 隔离真实审计日志（认证失败等事件）
      LOG_LEVEL: "error",          // 集成测试不刷请求日志；启动失败仍有 console 输出
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let buf = "";
  proc.stdout?.on("data", (d) => (buf += String(d)));
  proc.stderr?.on("data", (d) => (buf += String(d)));

  const base = `http://127.0.0.1:${port}`;
  const output = () => buf;
  try {
    await waitReady(base, proc, output);
  } catch (err) {
    await stopProcess(proc);
    throw err;
  }

  return {
    base,
    proc,
    journalPath,
    output,
    stop: async () => {
      await stopProcess(proc);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Windows 上必须杀进程树（node 本身即根，/T 兜底 loader 子进程） */
export function stopProcess(proc: ChildProcess): Promise<void> {
  const pid = proc.pid;
  if (!pid || proc.exitCode !== null) return Promise.resolve();
  return new Promise((resolveStop) => {
    const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    killer.once("exit", () => resolveStop());
    killer.once("error", () => {
      try { proc.kill(); } catch { /* 已退出 */ }
      resolveStop();
    });
  });
}
