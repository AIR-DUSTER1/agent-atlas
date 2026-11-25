/**
 * runtime/cooldown-gate.ts — 外部依赖共享冷却窗
 * ============================================================
 * 职责：把一次限流/熔断结果扩散成所有同源调用都能看到的冷却截止时间。
 * 设计立场：
 *  - 订阅号不是只针对某个参数或某张卡片，而是保护整个外部账号；
 *  - 冷却期内直接短路，不再启动子进程，避免“每个候选都重试三次”放大风控；
 *  - 时钟可注入，单元测试不依赖真实等待。
 */
export interface CooldownSnapshot {
  active: boolean;
  remainingMs: number;
  reason: string | null;
  until: number;
}

export class CooldownGate {
  private until = 0;
  private reason: string | null = null;

  constructor(
    readonly id: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** 激活或延长冷却；已有更长冷却时不会被缩短。 */
  activate(ms: number, reason = "temporary_unavailable"): void {
    const duration = Math.max(0, Math.ceil(ms));
    if (duration <= 0) return;
    const nextUntil = this.now() + duration;
    if (nextUntil <= this.until) return;
    this.until = nextUntil;
    this.reason = reason;
  }

  remainingMs(): number {
    const remaining = Math.max(0, this.until - this.now());
    if (remaining === 0) {
      this.until = 0;
      this.reason = null;
    }
    return remaining;
  }

  reset(): void {
    this.until = 0;
    this.reason = null;
  }

  snapshot(): CooldownSnapshot {
    const remainingMs = this.remainingMs();
    return {
      active: remainingMs > 0,
      remainingMs,
      reason: this.reason,
      until: this.until,
    };
  }
}
