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

/**
 * 资源繁忙造成的「可重试」拒绝。
 *
 * 为什么单独一个类型：并发满不是客户端请求有错，路由层若把它当 400 返回，
 * 调用方会当成确定性失败直接放弃（实测外部评测并发 3 时正是这样丢样本）。
 * 现在路由层据此回 429 + Retry-After，语义正确、可被通用重试逻辑接管。
 */
export class ResourceBusyError extends Error {
  readonly retryAfterSeconds: number;
  constructor(message: string, retryAfterSeconds: number) {
    super(message);
    this.name = "ResourceBusyError";
    this.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterSeconds));
  }
}

/** 跨模块类型守卫：路由层据此决定 429 而不是 400 */
export function isResourceBusyError(err: unknown): err is ResourceBusyError {
  return err instanceof ResourceBusyError
    || (typeof err === "object" && err !== null && (err as { name?: unknown }).name === "ResourceBusyError");
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
      return Promise.reject(new ResourceBusyError(
        `资源「${this.id}」繁忙：队列已满（${this.maxQueue}），请稍后重试`,
        this.queueTimeoutMs / 1000,
      ));
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
          reject(new ResourceBusyError(
            `资源「${this.id}」繁忙：等待超过 ${Math.ceil(this.queueTimeoutMs / 1000)} 秒，请稍后重试`,
            this.queueTimeoutMs / 1000,
          ));
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

  /**
   * 只取槽位、不包裹执行体：给「槽位要覆盖整轮、但执行体由调用方分多处 await」
   * 的场景用（聊天路由要在登记对话记录之前拿到槽位，拒绝时零痕迹）。
   * 返回释放函数，必须用 try/finally 调用。
   */
  async acquireSlot(): Promise<() => void> {
    await this.acquire();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release();
    };
  }

  snapshot(): { id: string; active: number; queued: number; capacity: number; maxQueue: number } {
    return { id: this.id, active: this.active, queued: this.queue.length, capacity: this.capacity, maxQueue: this.maxQueue };
  }
}
