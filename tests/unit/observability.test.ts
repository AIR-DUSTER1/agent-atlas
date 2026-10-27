/** observability.test.ts — Prometheus 文本、标签安全与低基数路径 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  incCounter, incGauge, metricPath, observeHistogram, renderMetrics, resetMetricsForTests, setGauge,
} from "../../src/server/observability/metrics.js";

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
