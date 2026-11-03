/**
 * server/memory-maintenance.ts — 长期记忆生命周期后台维护
 * ============================================================
 * TTL 的最终判断仍在读取时执行；这里的低频任务负责在无人打开设置页时也推进
 * stale / archived 并落盘。失败只记指标，不阻塞聊天与健康探针。
 */
import { refreshLocalLifecycle } from "../memory/providers/local-store.js";
import { incCounter } from "./observability/metrics.js";

const MAINTENANCE_INTERVAL_MS = 6 * 60 * 60 * 1000;
let timer: ReturnType<typeof setInterval> | undefined;

async function runOnce(): Promise<void> {
  try {
    await refreshLocalLifecycle();
  } catch {
    incCounter("memory_lifecycle_maintenance_failed_total", {});
  }
}

export function startMemoryMaintenance(): void {
  if (timer) return;
  void runOnce();
  timer = setInterval(() => { void runOnce(); }, MAINTENANCE_INTERVAL_MS);
  timer.unref?.();
}

export function stopMemoryMaintenance(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = undefined;
}