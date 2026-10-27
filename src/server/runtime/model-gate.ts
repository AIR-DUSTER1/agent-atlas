/**
 * runtime/model-gate.ts — 供应商级模型并发闸
 * ============================================================
 * 整个对话轮持有一个槽位（一轮可能发起多次模型调用），按当前供应商隔离；
 * 队列满/等待超时直接给出可恢复中文错误，不自动额外消耗模型配额。
 */
import { ResourceGauge } from "./resource-gauge.js";

const gauges = new Map<string, ResourceGauge>();

function capacity(): number {
  const value = Number(process.env.MODEL_CONCURRENCY_PER_PROVIDER);
  return Number.isInteger(value) && value >= 1 && value <= 50 ? value : 5;
}

function gaugeFor(providerId: string): ResourceGauge {
  let gauge = gauges.get(providerId);
  if (!gauge) {
    gauge = new ResourceGauge(`model:${providerId}`, capacity(), 20, 10_000);
    gauges.set(providerId, gauge);
  }
  return gauge;
}

export function runWithModelSlot<T>(providerId: string | null, fn: () => Promise<T>): Promise<T> {
  return gaugeFor(providerId || "default").run(fn);
}

export function modelGateSnapshots(): Array<ReturnType<ResourceGauge["snapshot"]>> {
  return [...gauges.values()].map((gauge) => gauge.snapshot());
}
