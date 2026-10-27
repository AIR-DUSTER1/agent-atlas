/**
 * ============================================================
 * observability/metrics.ts — 零依赖 Prometheus 指标注册表
 * ============================================================
 * 只保存固定名称的 counter / gauge / histogram，标签值截断并转义，禁止把
 * prompt、URL 查询串、工具结果或密钥写进指标。HTTP path 统一模板化以控基数。
 */
import { monitorEventLoopDelay } from "node:perf_hooks";

type Labels = Record<string, string | number | boolean | undefined>;
interface Sample { name: string; labels: Labels; value: number }
interface HistogramState { name: string; labels: Labels; buckets: number[]; counts: number[]; sum: number; count: number }

const counters = new Map<string, Sample>();
const gauges = new Map<string, Sample>();
const histograms = new Map<string, HistogramState>();
const HISTOGRAM_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000];

function metricName(name: string): string {
  const normalized = name.replace(/[^a-zA-Z0-9_:]/g, "_");
  return /^[a-zA-Z_:]/.test(normalized) ? normalized : `agent_${normalized}`;
}

function labelValue(value: string | number | boolean | undefined): string {
  return String(value ?? "").slice(0, 120).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function labelKey(labels: Labels): string {
  return Object.entries(labels)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${labelValue(value)}`)
    .join(",");
}

function pointKey(name: string, labels: Labels): string {
  return `${name}\u0000${labelKey(labels)}`;
}

function fmtLabels(labels: Labels): string {
  const entries = Object.entries(labels)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length) return "";
  return `{${entries.map(([key, value]) => `${key}="${labelValue(value)}"`).join(",")}}`;
}

export function incCounter(name: string, labels: Labels = {}, amount = 1): void {
  const metric = metricName(name);
  const key = pointKey(metric, labels);
  const current = counters.get(key);
  if (current) current.value += amount;
  else counters.set(key, { name: metric, labels: { ...labels }, value: amount });
}

export function incGauge(name: string, labels: Labels = {}, amount = 1): void {
  const metric = metricName(name);
  const key = pointKey(metric, labels);
  const current = gauges.get(key);
  if (current) current.value += amount;
  else gauges.set(key, { name: metric, labels: { ...labels }, value: amount });
}

export function setGauge(name: string, value: number, labels: Labels = {}): void {
  const metric = metricName(name);
  gauges.set(pointKey(metric, labels), { name: metric, labels: { ...labels }, value });
}

export function observeHistogram(name: string, value: number, labels: Labels = {}): void {
  const metric = metricName(name);
  const key = pointKey(metric, labels);
  let state = histograms.get(key);
  if (!state) {
    state = {
      name: metric, labels: { ...labels }, buckets: HISTOGRAM_BUCKETS_MS,
      counts: HISTOGRAM_BUCKETS_MS.map(() => 0), sum: 0, count: 0,
    };
    histograms.set(key, state);
  }
  const safe = Math.max(0, Number.isFinite(value) ? value : 0);
  state.sum += safe;
  state.count += 1;
  for (let i = 0; i < state.buckets.length; i += 1) if (safe <= state.buckets[i]) state.counts[i] += 1;
}

let loopDelay: ReturnType<typeof monitorEventLoopDelay> | null = null;
let loopTimer: NodeJS.Timeout | null = null;

/** 由服务入口调用；单测直接 render 时不启动后台计时器。 */
export function startProcessMetrics(): void {
  if (loopDelay) return;
  loopDelay = monitorEventLoopDelay({ resolution: 20 });
  loopDelay.enable();
  loopTimer = setInterval(() => {
    setGauge("agent_event_loop_lag_milliseconds", Number.isFinite(loopDelay?.mean) ? (loopDelay!.mean / 1e6) : 0);
    loopDelay?.reset();
  }, 10_000);
  loopTimer.unref();
}

export function stopProcessMetricsForTests(): void {
  if (loopTimer) clearInterval(loopTimer);
  loopTimer = null;
  loopDelay?.disable();
  loopDelay = null;
}

/** Prometheus 文本输出；同名指标只声明一次 TYPE。 */
export function renderMetrics(): string {
  const lines: string[] = [];
  const memory = process.memoryUsage();
  lines.push("# TYPE agent_process_uptime_seconds gauge");
  lines.push(`agent_process_uptime_seconds ${process.uptime().toFixed(3)}`);
  lines.push("# TYPE agent_process_resident_memory_bytes gauge");
  lines.push(`agent_process_resident_memory_bytes ${memory.rss}`);
  lines.push("# TYPE agent_process_heap_used_bytes gauge");
  lines.push(`agent_process_heap_used_bytes ${memory.heapUsed}`);

  const emittedTypes = new Set<string>();
  for (const sample of counters.values()) {
    if (!emittedTypes.has(`c:${sample.name}`)) {
      lines.push(`# TYPE ${sample.name} counter`);
      emittedTypes.add(`c:${sample.name}`);
    }
    lines.push(`${sample.name}${fmtLabels(sample.labels)} ${sample.value}`);
  }
  for (const sample of gauges.values()) {
    if (!emittedTypes.has(`g:${sample.name}`)) {
      lines.push(`# TYPE ${sample.name} gauge`);
      emittedTypes.add(`g:${sample.name}`);
    }
    lines.push(`${sample.name}${fmtLabels(sample.labels)} ${Number.isFinite(sample.value) ? sample.value : 0}`);
  }
  for (const hist of histograms.values()) {
    if (!emittedTypes.has(`h:${hist.name}`)) {
      lines.push(`# TYPE ${hist.name} histogram`);
      emittedTypes.add(`h:${hist.name}`);
    }
    for (let i = 0; i < hist.buckets.length; i += 1) {
      lines.push(`${hist.name}_bucket${fmtLabels({ ...hist.labels, le: hist.buckets[i] })} ${hist.counts[i]}`);
    }
    lines.push(`${hist.name}_bucket${fmtLabels({ ...hist.labels, le: "+Inf" })} ${hist.count}`);
    lines.push(`${hist.name}_sum${fmtLabels(hist.labels)} ${hist.sum}`);
    lines.push(`${hist.name}_count${fmtLabels(hist.labels)} ${hist.count}`);
  }
  return lines.join("\n") + "\n";
}

/** 把动态资源 id 替换为模板，避免 HTTP path 成为高基数标签。 */
export function metricPath(pathname: string): string {
  return pathname
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,36}/gi, ":id")
    .replace(/\/api\/sessions\/[^/]+/g, "/api/sessions/:id")
    .replace(/\/api\/config\/providers\/[^/]+/g, "/api/config/providers/:id")
    .replace(/\/api\/memories\/[^/]+/g, "/api/memories/:id");
}

export function resetMetricsForTests(): void {
  counters.clear();
  gauges.clear();
  histograms.clear();
  stopProcessMetricsForTests();
}
