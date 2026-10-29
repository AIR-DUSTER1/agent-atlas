/** observability.test.ts — Prometheus 文本、标签安全与低基数路径 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  incCounter, incGauge, metricPath, observeHistogram, renderMetrics, resetMetricsForTests, setGauge,
} from "../../src/server/observability/metrics.js";
import { installMemoryMetricsSink, uninstallMemoryMetricsSinkForTests } from "../../src/server/memory-observability.js";
import { memorySlot, resetMemorySlotForTests } from "../../src/memory/slot.js";
import { memoryScope } from "../../src/memory/scope.js";
import type { MemoryProvider } from "../../src/memory/provider.js";

test("Prometheus 输出包含 counter / gauge / histogram 与进程指标", () => {
  resetMetricsForTests();
  incCounter("agent_test_total", { quote: `a"b\nc`, ok: true }, 2);
  incGauge("agent_test_inflight", { kind: "agent" }, 1);
  setGauge("agent_test_value", 42);
  observeHistogram("agent_test_duration_milliseconds", 120, { route: "/x" });
  const text = renderMetrics();
  assert.match(text, /# TYPE agent_test_total counter/);
  assert.match(text, /agent_test_total\{ok="true",quote="a\\"b\\nc"\} 2/);
  assert.match(text, /agent_test_inflight\{kind="agent"\} 1/);
  assert.match(text, /agent_test_value 42/);
  assert.match(text, /agent_test_duration_milliseconds_bucket\{le="250",route="\/x"\} 1/);
  assert.match(text, /agent_test_duration_milliseconds_count\{route="\/x"\} 1/);
  assert.match(text, /agent_process_resident_memory_bytes \d+/);
  resetMetricsForTests();
});

test("动态资源 id 被模板化，避免指标高基数", () => {
  assert.equal(metricPath("/api/sessions/abc/transcript"), "/api/sessions/:id/transcript");
  assert.equal(metricPath("/api/config/providers/p-1/models/m-2"), "/api/config/providers/:id/models/m-2");
  assert.equal(metricPath("/api/sessions/123e4567-e89b-12d3-a456-426614174000"), "/api/sessions/:id");
});
test("记忆指标低基数且不包含记忆正文；保存失败与敏感拦截分开计数", async () => {
  resetMetricsForTests();
  installMemoryMetricsSink();
  const scope = memoryScope("general");
  let sensitive = false;
  const fake: MemoryProvider = {
    id: "http",
    capabilities: { read: true, write: true, delete: true, search: true, health: true },
    async health() { return { providerId: "http", status: "ok", latencyMs: 1 }; },
    async save(input) {
      if (sensitive) throw new Error("拒绝保存：内容疑似包含密钥");
      return {
        id: "m1", scope: input.scope, key: input.key, content: input.content, tags: [], source: input.source,
        status: "active", createdAt: 1, updatedAt: 1,
      };
    },
    async search(query) {
      return {
        records: [{
          id: "m1", scope: query.scope, key: "主题", content: "秘密正文不应进入指标", tags: [], source: "agent",
          status: "active", createdAt: 1, updatedAt: 1,
        }],
        total: 1,
        degraded: false,
        providerId: "http",
      };
    },
    async list() { return []; },
    async delete() { return true; },
  };
  memorySlot.register(fake, { replace: true, activate: true });
  await memorySlot.save({ scope, key: "主题", content: "正文", source: "agent" });
  await memorySlot.search({ scope, text: "主题", limit: 8 });
  await memorySlot.note({ scope, query: "主题" });
  sensitive = true;
  await assert.rejects(() => memorySlot.save({ scope, key: "密钥", content: "bad", source: "agent" }), /拒绝保存/);
  const text = renderMetrics();
  assert.match(text, /memory_save_total\{provider="http",result="ok"\} 1/);
  assert.match(text, /memory_recall_hit_total\{profile="general",provider="http"\} \d+/);
  assert.match(text, /memory_injected_total\{profile="general",provider="http"\} \d+/);
  assert.match(text, /memory_sensitive_blocked_total\{provider="http"\} 1/);
  assert.match(text, /memory_provider_latency_milliseconds_count/);
  assert.doesNotMatch(text, /秘密正文不应进入指标/);
  uninstallMemoryMetricsSinkForTests();
  resetMemorySlotForTests();
  resetMetricsForTests();
});
