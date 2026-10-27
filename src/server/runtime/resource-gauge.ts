/**
 * runtime/resource-gauge.ts — 有界等待队列
 * ============================================================
 * 外部资源并发满后允许短队列等待；超过队列上限或等待超时返回中文错误。
 * 所有路径都保证 active 计数归还，任务完成自动唤醒 FIFO 下一项。
 */
import { incCounter, setGauge } from "../observability/metrics.js";

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class ResourceGauge {
  private active = 0;
  private queue: Waiter[] = [];

  constructor(
    readonly id: string,
    private readonly capacity: number,
    private readonly maxQueue = Math.max(1, capacity * 4),
    private readonly queueTimeoutMs = 5_000,
  ) {
    this.publish();
  }

  private publish(): void {
    setGauge("agent_resource_active", this.active, { resource: this.id });
    setGauge("agent_resource_queued", this.queue.length, { resource: this.id });
  }

  private acquire(): Promise<void> {
    if (this.active < this.capacity) {
      this.active += 1;
      this.publish();
      return Promise.resolve();
    }
    if (this.queue.length >= this.maxQueue) {
      incCounter("agent_resource_rejected_total", { resource: this.id, reason: "queue_full" });
      return Promise.reject(new Error(`资源「${this.id}」繁忙：队列已满（${this.maxQueue}），请稍后重试`));
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.queue.indexOf(waiter);
          if (index >= 0) this.queue.splice(index, 1);
          this.publish();
          incCounter("agent_resource_rejected_total", { resource: this.id, reason: "queue_timeout" });
          reject(new Error(`资源「${this.id}」繁忙：等待超过 ${Math.ceil(this.queueTimeoutMs / 1000)} 秒，请稍后重试`));
        }, this.queueTimeoutMs),
      };
      waiter.timer.unref();
      this.queue.push(waiter);
      this.publish();
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      clearTimeout(next.timer);
      next.resolve();
      this.publish();
      return;
    }
    this.active = Math.max(0, this.active - 1);
    this.publish();
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  snapshot(): { id: string; active: number; queued: number; capacity: number; maxQueue: number } {
    return { id: this.id, active: this.active, queued: this.queue.length, capacity: this.capacity, maxQueue: this.maxQueue };
  }
}
