/**
 * model-retry.ts — 模型调用重试与前端可观测事件
 * ============================================================
 * 职责：对单次模型 invoke 做幂等失败重试，并把每次失败/最终结果放入
 * sessionId 队列，供 SSE 层在模型还在退避等待时先行推给前端。
 * 设计立场：400/401 这类确定性错误不重试；408/429/5xx、超时与网络故障
 * 默认最多重试 10 次。用户主动取消绝不重试。
 */

import { config } from "./config.js";

export type ModelRetryPhase = "retry" | "success" | "failed";

export interface ModelRetryRecord {
  /** 刚完成的请求序号，从 1 开始。 */
  attempt: number;
  /** 已消耗的重试次数；最终失败时等于最大重试次数。 */
  retries: number;
  /** 本次调用允许的总请求次数（首次 + 重试次数）。 */
  totalAttempts: number;
  phase: ModelRetryPhase;
  reason: string;
  at: number;
}

const MAX_RETRY_REASON_CHARS = 500;
const MAX_RETRY_RECORDS = 100;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 8_000;

const retryQueues = new Map<string, ModelRetryRecord[]>();

function publish(sessionId: string | undefined, record: ModelRetryRecord): void {
  if (!sessionId) return;
  const queue = retryQueues.get(sessionId) ?? [];
  queue.push(record);
  // 长任务可能有多次模型调用；这里只承载可观测性，不允许队列本身变成泄漏点。
  if (queue.length > MAX_RETRY_RECORDS) queue.splice(0, queue.length - MAX_RETRY_RECORDS);
  retryQueues.set(sessionId, queue);
}

export function drainModelRetryRecords(sessionId: string | undefined): ModelRetryRecord[] {
  if (!sessionId) return [];
  const queue = retryQueues.get(sessionId);
  if (!queue?.length) return [];
  retryQueues.set(sessionId, []);
  return queue;
}

export function clearModelRetryRecords(sessionId: string | undefined): void {
  if (sessionId) retryQueues.delete(sessionId);
}

function errorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/\s+/g, " ").trim().slice(0, MAX_RETRY_REASON_CHARS) || "未知模型请求错误";
}

function httpStatus(message: string): number {
  return Number(/(?:HTTP\s*)?\b(408|429|5\d{2})\b/i.exec(message)?.[1] ?? 0);
}

function shouldRetry(err: unknown, parentSignal?: AbortSignal): boolean {
  if (parentSignal?.aborted) return false;
  const message = errorMessage(err);
  // 父信号未取消时的 AbortError 多来自每次请求自己的 timeout 子信号，应当重试；
  // 用户/服务关闭会先触发 parentSignal.aborted，不能隐式重试。
  if (/abort/i.test(message)) return true;
  const status = httpStatus(message);
  if (status) return status === 408 || status === 429 || status >= 500;
  return /timeout|timed out|network|fetch failed|econn|socket|connection/i.test(message);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("操作已取消"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("操作已取消"));
    }, { once: true });
  });
}

export interface ModelRetryInvokeOptions {
  sessionId?: string;
  parentSignal?: AbortSignal;
}

/**
 * 包装一次模型调用。fn 收到父级取消信号，由调用方在每一次尝试里重新生成
 * 请求超时信号，避免第一次 90 秒超时后后续尝试全部立刻失败。
 */
export async function invokeWithModelRetry<T>(
  fn: (parentSignal?: AbortSignal) => Promise<T>,
  options: ModelRetryInvokeOptions = {}
): Promise<T> {
  const retries = config.modelRequestRetries;
  const totalAttempts = retries + 1;
  let lastError: unknown;

  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    try {
      const result = await fn(options.parentSignal);
      if (attempt > 1) {
        publish(options.sessionId, {
          attempt,
          retries: attempt - 1,
          totalAttempts,
          phase: "success",
          reason: "重试后的模型请求已成功",
          at: Date.now(),
        });
      }
      return result;
    } catch (err) {
      lastError = err;
      const canRetry = attempt < totalAttempts && shouldRetry(err, options.parentSignal);
      if (canRetry) {
        publish(options.sessionId, {
          attempt,
          retries: attempt,
          totalAttempts,
          phase: "retry",
          reason: errorMessage(err),
          at: Date.now(),
        });
        const delay = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
        await sleep(delay, options.parentSignal);
        continue;
      }
      publish(options.sessionId, {
        attempt,
        retries: attempt - 1,
        totalAttempts,
        phase: "failed",
        reason: errorMessage(err),
        at: Date.now(),
      });
      throw err;
    }
  }
  throw lastError;
}
