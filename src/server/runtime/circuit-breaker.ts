/**
 * ============================================================
 * runtime/circuit-breaker.ts — 外部依赖熔断器
 * ============================================================
 * closed → 连续失败达阈值 → open → 冷却后半开单探针 → 成功 closed / 失败 open。
 * 只保护可失败的外部调用；状态与错误均为内存态，不记录请求正文。
 */
import { incCounter, setGauge } from "../observability/metrics.js";

export type CircuitState = "closed" | "open" | "half-open";

export class CircuitOpenError extends Error {
  readonly retryAfterMs: number;
  constructor(id: string, retryAfterMs: number) {
    super(`外部依赖「${id}」暂时不可用，请在 ${Math.max(1, Math.ceil(retryAfterMs / 1000))} 秒后重试`);
    this.name = "CircuitOpenError";
    this.retryAfterMs = retryAfterMs;
  }
}

export interface CircuitSnapshot {
  id: string;
  state: CircuitState;
  failures: number;
  retryAfterMs: number;
  lastError: string | null;
}

export class CircuitBreaker {
  private state: CircuitState = "closed";
  private failures = 0;
  private openedAt = 0;
  private halfOpenProbe = false;
  private lastError: string | null = null;

  constructor(
    readonly id: string,
    private readonly failureThreshold = 3,
    private readonly cooldownMs = 30_000,
    private readonly now: () => number = Date.now,
  ) {
    this.publish();
  }

  private publish(): void {
    setGauge("agent_circuit_breaker_state", this.state === "closed" ? 0 : this.state === "half-open" ? 1 : 2, { dependency: this.id });
  }

  private open(): void {
    this.state = "open";
    this.openedAt = this.now();
    this.halfOpenProbe = false;
    this.publish();
  }

  private beforeCall(): void {
    if (this.state === "closed") return;
    if (this.state === "open") {
      const elapsed = this.now() - this.openedAt;
      if (elapsed < this.cooldownMs) throw new CircuitOpenError(this.id, this.cooldownMs - elapsed);
      this.state = "half-open";
      this.halfOpenProbe = false;
      this.publish();
    }
    if (this.halfOpenProbe) throw new CircuitOpenError(this.id, this.cooldownMs);
    this.halfOpenProbe = true;
  }

  private success(): void {
    this.failures = 0;
    this.lastError = null;
    this.halfOpenProbe = false;
    this.state = "closed";
    this.publish();
  }

  private failure(err: unknown): void {
    this.lastError = err instanceof Error ? err.message.slice(0, 240) : String(err).slice(0, 240);
    this.failures += 1;
    incCounter("agent_circuit_breaker_failures_total", { dependency: this.id });
    if (this.state === "half-open" || this.failures >= this.failureThreshold) this.open();
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    this.beforeCall();
    try {
      const result = await fn();
      this.success();
      return result;
    } catch (err) {
      this.failure(err);
      throw err;
    }
  }

  snapshot(): CircuitSnapshot {
    const retryAfterMs = this.state === "open"
      ? Math.max(0, this.cooldownMs - (this.now() - this.openedAt))
      : 0;
    return { id: this.id, state: this.state, failures: this.failures, retryAfterMs, lastError: this.lastError };
  }

  reset(): void {
    this.state = "closed";
    this.failures = 0;
    this.openedAt = 0;
    this.halfOpenProbe = false;
    this.lastError = null;
    this.publish();
  }
}
