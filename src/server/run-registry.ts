/**
 * ============================================================
 * run-registry.ts — 会话运行态登记表（后台生成 / 显式停止）
 * ============================================================
 * 为什么需要这一层：生成状态原本只活在前端内存（state.streams），页面一刷新就
 * 同时丢掉两样东西 ——
 *   1. 侧栏「生成中」标记消失（看起来像没人在跑）；
 *   2. 更严重：浏览器断开连接时服务端会 abort 掉整轮生成，刷新等于「取消回答」。
 *
 * 契约：
 *  - 断连（刷新 / 关标签 / 网络抖动）只 detach，不 abort —— 生成继续，结果照旧落
 *    journal，刷新回来仍能查到；
 *  - 真正终止只有两条路：用户在界面上显式停止（stop），或服务端优雅退出；
 *  - detach 后无人观察的运行有兜底上限：超过 DETACHED_ABORT_MS 自动中止，避免
 *    用户关掉页面后模型配额被无限消耗。
 */
import { log } from "./logging.js";

/** detach 后无人观察的运行上限：超过即中止，防止僵尸生成烧配额。 */
export const DETACHED_ABORT_MS = 10 * 60_000;

interface RunHandle {
  sessionId: string;
  controller: AbortController;
  /** 是否还有客户端在看这条流；detach 后为 false。 */
  attached: boolean;
  startedAt: number;
  /** detach 兜底计时器（attach 回来时清掉）。 */
  detachTimer?: ReturnType<typeof setTimeout>;
}

const runs = new Map<string, RunHandle>();

/** 登记一轮生成。同会话已有运行时返回 null（由调用方的会话槽位闸门先拦）。 */
export function beginRun(sessionId: string, controller: AbortController): void {
  runs.set(sessionId, {
    sessionId,
    controller,
    attached: true,
    startedAt: Date.now(),
  });
}

/** 运行结束（正常完成 / 出错 / 被停止）时清理。只清自己那一条，避免误删后来的运行。 */
export function endRun(sessionId: string, controller: AbortController): void {
  const run = runs.get(sessionId);
  if (!run || run.controller !== controller) return;
  if (run.detachTimer) clearTimeout(run.detachTimer);
  runs.delete(sessionId);
}

/** 该会话是否仍在服务端生成中。 */
export function isSessionRunning(sessionId: string): boolean {
  return runs.has(sessionId);
}

/** 正在生成的会话 id 列表（供排障与列表接口使用）。 */
export function runningSessionIds(): string[] {
  return [...runs.keys()];
}

/**
 * 客户端断开：保持生成，只标记无人观察并挂上兜底计时器。
 * 返回 true 表示确实 detach 了一个还在跑的运行。
 */
export function detachRun(sessionId: string, controller: AbortController): boolean {
  const run = runs.get(sessionId);
  if (!run || run.controller !== controller || !run.attached) return false;
  run.attached = false;
  if (run.detachTimer) clearTimeout(run.detachTimer);
  run.detachTimer = setTimeout(() => {
    const current = runs.get(sessionId);
    if (!current || current.controller !== controller || current.attached) return;
    log("warn", "agent_run_detached_aborted", {
      sessionId,
      detachedMs: Date.now() - current.startedAt,
      limitMs: DETACHED_ABORT_MS,
    });
    controller.abort();
  }, DETACHED_ABORT_MS);
  run.detachTimer.unref?.();
  return true;
}

/**
 * 显式停止：只中止这个会话名下确实在跑的那一条。
 * 返回 false 表示没有可停止的运行（前端据此回 404，而不是假装已停止）。
 */
export function stopRun(sessionId: string): boolean {
  const run = runs.get(sessionId);
  if (!run) return false;
  run.controller.abort();
  return true;
}

/** 测试用：清空登记表，避免用例之间互相影响。 */
export function resetRunsForTest(): void {
  for (const run of runs.values()) if (run.detachTimer) clearTimeout(run.detachTimer);
  runs.clear();
}
