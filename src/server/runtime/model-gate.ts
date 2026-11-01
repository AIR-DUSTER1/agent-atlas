/**
 * runtime/model-gate.ts — 供应商级模型并发闸
 * ============================================================
 * 整个对话轮持有一个槽位（一轮可能发起多次模型调用），按当前供应商隔离；
 * 队列满/等待超时返回可重试的错误（ResourceBusyError → HTTP 429），
 * 不自动额外消耗模型配额。
 *
 * 为什么容量与排队时间要可配：多个会话/评测并发跑同一供应商时，
 * 常见做法是「排队等一下」而不是立刻失败。默认值面向单机自托管，
 * 压测或批量评测可以用 MODEL_CONCURRENCY_PER_PROVIDER /
 * MODEL_QUEUE_WAIT_MS 把闸门放宽。
 */
import { ResourceGauge } from "./resource-gauge.js";

const DEFAULT_CAPACITY = 5;
const DEFAULT_QUEUE_WAIT_MS = 10_000;

const gauges = new Map<string, ResourceGauge>();

/** 每个供应商同时进行的模型轮数（1–50） */
function capacity(): number {
  const value = Number(process.env.MODEL_CONCURRENCY_PER_PROVIDER);
  return Number.isInteger(value) && value >= 1 && value <= 50 ? value : DEFAULT_CAPACITY;
}

/**
 * 排队等槽位的最长时长（1s–5min）。为 0 表示不排队、繁忙即失败 ——
 * 排队本身有代价（客户端要等），所以上限设得保守。
 */
function queueWaitMs(): number {
  const raw = process.env.MODEL_QUEUE_WAIT_MS;
  if (raw === undefined || raw === "") return DEFAULT_QUEUE_WAIT_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 300_000) return DEFAULT_QUEUE_WAIT_MS;
  return value === 0 ? 1 : value;
}

/** 排队上限是容量的 4 倍（至少 2）：再多说明该扩容而不是继续排队 */
function maxQueueFor(cap: number): number {
  return Math.max(2, cap * 4);
}

function gaugeFor(providerId: string): ResourceGauge {
  let gauge = gauges.get(providerId);
  if (!gauge) {
    const cap = capacity();
    gauge = new ResourceGauge(`model:${providerId}`, cap, maxQueueFor(cap), queueWaitMs());
    gauges.set(providerId, gauge);
  }
  return gauge;
}

export function runWithModelSlot<T>(providerId: string | null, fn: () => Promise<T>): Promise<T> {
  return gaugeFor(providerId || "default").run(fn);
}

/**
 * 只占用供应商槽位（返回释放函数）。
 * 聊天路由用这个：必须在登记对话记录之前拿到槽位，否则并发拒绝会在
 * journal 里留下半条轮次记录；同时又能把槽位一直持有到整轮流结束。
 */
export function acquireModelSlot(providerId: string | null): Promise<() => void> {
  return gaugeFor(providerId || "default").acquireSlot();
}

export function modelGateSnapshots(): Array<ReturnType<ResourceGauge["snapshot"]>> {
  return [...gauges.values()].map((gauge) => gauge.snapshot());
}

/** 测试专用：丢弃已缓存的闸门，让环境变量改动在下一次取用时生效 */
export function resetModelGates(): void {
  gauges.clear();
}
