/**
 * runtime/retry.ts — 显式幂等调用的指数退避
 * ============================================================
 * 仅调用方明确标记为幂等的操作可用；模型生成默认不自动重试，避免隐式消耗配额。
 */
export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  signal?: AbortSignal;
  shouldRetry?: (err: unknown) => boolean;
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

export async function retryWithBackoff<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const retries = Math.max(0, Math.min(5, options.retries ?? 2));
  const base = Math.max(50, options.baseDelayMs ?? 250);
  const max = Math.max(base, options.maxDelayMs ?? 4_000);
  const jitter = Math.max(0, Math.min(1, options.jitterRatio ?? 0.2));
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt >= retries || (options.shouldRetry && !options.shouldRetry(err))) throw err;
      const backoff = Math.min(max, base * 2 ** attempt);
      const randomized = backoff * (1 - jitter / 2 + Math.random() * jitter);
      await sleep(randomized, options.signal);
    }
  }
  throw lastError;
}

/** 只对 408 / 429 / 5xx 判定为可重试 HTTP 状态。 */
export function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}
