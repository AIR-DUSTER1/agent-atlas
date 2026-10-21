/**
 * ============================================================
 * health.ts — 存活 / 就绪探针（Phase 4）
 * ============================================================
 * /healthz 只证明事件循环还活着（liveness，不查磁盘/外部依赖，永不 503）；
 * /readyz 才回答「能干活吗」：配置目录与 session journal 目录可写、未在关闭中。
 * 两者都免认证、只返回版本/运行时/布尔检查，不暴露路径、供应商、Key。
 * 探针不能因为磁盘卡住而悬挂：文件检查带 READY_CHECK_TIMEOUT_MS 超时。
 */
import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { ServerResponse } from "node:http";
import { SETTINGS_FILE } from "./config-store.js";
import { journalPath } from "./session-store.js";
import { lifecycle } from "./lifecycle.js";

/** 本地 fs 检查上限：网络盘/杀毒软件卡住时，探针最多等这么久 */
const READY_CHECK_TIMEOUT_MS = 1_500;

const pkg = createRequire(import.meta.url)("../../package.json") as { version?: string };
const VERSION = pkg.version ?? "0.0.0";

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function uptimeSeconds(): number {
  return Math.round(process.uptime());
}

function withTimeout(task: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ready check timeout")), ms);
    task.then(
      () => { clearTimeout(timer); resolve(); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

/** 目录可写 = mkdir 成功 + W_OK 通过（只读挂载/权限不足都会失败） */
async function isDirWritable(dir: string): Promise<boolean> {
  try {
    await mkdir(dir, { recursive: true });
    await withTimeout(access(dir, constants.W_OK), READY_CHECK_TIMEOUT_MS);
    return true;
  } catch {
    return false;
  }
}

export async function handleHealthz(res: ServerResponse): Promise<void> {
  writeJson(res, 200, {
    ok: true,
    version: VERSION,
    uptimeSeconds: uptimeSeconds(),
  });
}

export async function handleReadyz(res: ServerResponse): Promise<void> {
  const shuttingDown = lifecycle.isShuttingDown();
  const checks = {
    configStore: await isDirWritable(dirname(SETTINGS_FILE)),
    sessionStore: await isDirWritable(dirname(journalPath())),
  };
  const ok = !shuttingDown && checks.configStore && checks.sessionStore;
  writeJson(res, ok ? 200 : 503, {
    ok,
    version: VERSION,
    uptimeSeconds: uptimeSeconds(),
    shuttingDown,
    checks,
  });
}
