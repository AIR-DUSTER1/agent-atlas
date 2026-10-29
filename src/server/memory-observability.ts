/**
 * server/memory-observability.ts — 把 Memory Slot 事件映射为低基数指标
 * ============================================================
 * 只记录 provider、profile、成功/失败、耗时与条数；绝不写记忆正文、URL、
 * Authorization 或外部响应。server 依赖 memory 的 sink 注入，反向依赖不存在。
 */
import { configureMemoryMetricsSink, type MemoryMetricsSink } from "../memory/slot.js";
import { incCounter, observeHistogram, setGauge } from "./observability/metrics.js";

const sink: MemoryMetricsSink = {
  save(providerId, ok, latencyMs, sensitiveBlocked) {
    incCounter("memory_save_total", { provider: providerId, result: ok ? "ok" : "failed" });
    if (!ok) incCounter("memory_save_failed_total", { provider: providerId });
    if (sensitiveBlocked) incCounter("memory_sensitive_blocked_total", { provider: providerId });
    observeHistogram("memory_provider_latency_milliseconds", latencyMs, { provider: providerId, operation: "save" });
  },
  recall(providerId, profileId, hit, count, degraded, latencyMs) {
    incCounter("memory_recall_total", { provider: providerId, profile: profileId, degraded });
    if (hit) incCounter("memory_recall_hit_total", { provider: providerId, profile: profileId });
    incCounter("memory_recall_results_total", { provider: providerId }, count);
    if (degraded) incCounter("memory_provider_degraded_total", { provider: providerId });
    observeHistogram("memory_provider_latency_milliseconds", latencyMs, { provider: providerId, operation: "search" });
  },
  injected(providerId, profileId, count) {
    incCounter("memory_injected_total", { provider: providerId, profile: profileId }, count);
  },
  health(providerId, status, latencyMs) {
    setGauge("memory_provider_health", status === "ok" ? 1 : status === "degraded" ? 0.5 : 0, {
      provider: providerId,
    });
    observeHistogram("memory_provider_latency_milliseconds", latencyMs, { provider: providerId, operation: "health" });
  },
};

let installed = false;

export function installMemoryMetricsSink(): void {
  if (installed) return;
  installed = true;
  configureMemoryMetricsSink(sink);
}

export function uninstallMemoryMetricsSinkForTests(): void {
  installed = false;
  configureMemoryMetricsSink(null);
}
