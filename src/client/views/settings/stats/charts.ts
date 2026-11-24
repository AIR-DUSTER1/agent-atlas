/**
 * views/stats/charts.ts — Chart.js 六图引擎与降级判定
 * ============================================================
 * 职责：把区间数据编译成 6 份 Chart 配置，在 Vue 渲染好的卡片骨架上创建
 * 实例，并管理 ResizeObserver / PNG 导出 / 主题切换重建。
 * 设计立场：
 *  - 卡片骨架（标题、副标题、canvas、空态、导出按钮）由 Vue 组件声明式渲染；
 *    本模块只做 Canvas 必需的命令式部分，不再自建 DOM；
 *  - 图表库仍动态 import，失败时通过 onFallback 交回组件渲染数据表降级；
 *  - 每张图独立容器与 observer，销毁时逐个 disconnect（防止 resize 泄漏）。
 */
import { fmtTokens } from "../../../modules/format.js";
import type { ChartConfiguration } from "chart.js";
import type { StatsRange } from "../../../modules/types.js";

type ChartOptions = NonNullable<ChartConfiguration["options"]>;

type ChartModule = typeof import("chart.js/auto");
type ChartInstance = InstanceType<ChartModule["Chart"]>;

/** 一张图的声明：key 与组件模板里的 data-chart-key 对齐。 */
export interface ChartSpec {
  key: string;
  title: string;
  subtitle: string;
  config: ChartConfiguration;
}

let charts: ChartInstance[] = [];
let observers: ResizeObserver[] = [];
let currentRange: StatsRange | null = null;
let themeBound = false;
let renderGeneration = 0;
/** 当前根容器：主题切换重建时复用。 */
let currentRoot: HTMLElement | null = null;
let currentFallback: ((reason: string) => void) | null = null;

function css(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function rgba(color: string, alpha: number): string {
  const hex = color.match(/^#([0-9a-f]{6})$/i)?.[1];
  if (!hex) return color;
  const value = Number.parseInt(hex, 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}

function colors(): Record<string, string> {
  return {
    text: css("--content-1", "#e6e6ea"),
    muted: css("--content-3", "#6e6e78"),
    grid: css("--border-subtle", "#26272c"),
    accent: css("--accent", "#5b8cff"),
    accent2: css("--accent-2", "#8b5cf6"),
    green: css("--green", "#3fb96f"),
    amber: css("--amber", "#e2a13c"),
    red: css("--red", "#e5604f"),
  };
}

function commonScales(colorMap: Record<string, string>, stacked = false): ChartOptions["scales"] {
  return {
    x: {
      stacked,
      ticks: { color: colorMap.muted, maxRotation: 0, autoSkipPadding: 14 },
      grid: { color: colorMap.grid },
    },
    y: {
      stacked,
      beginAtZero: true,
      ticks: { color: colorMap.muted, callback: (value: string | number) => fmtTokens(Number(value) || 0) },
      grid: { color: colorMap.grid },
    },
  };
}

function commonOptions(colorMap: Record<string, string>, scales: ChartOptions["scales"], indexAxis?: "x" | "y"): ChartOptions {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { labels: { color: colorMap.text, boxWidth: 10, boxHeight: 10, usePointStyle: true } },
      tooltip: {
        backgroundColor: colorMap.grid,
        titleColor: colorMap.text,
        bodyColor: colorMap.text,
        borderColor: colorMap.muted,
        borderWidth: 1,
      },
    },
    indexAxis,
    scales,
  };
}

function dailyCacheRate(range: StatsRange): number[] {
  return (range.byDay ?? []).map((day) => day.inputTokens > 0 ? (day.cacheReadTokens / day.inputTokens) * 100 : 0);
}

/**
 * 每张图有没有可画的数据。组件据此决定渲染 canvas 还是空态一行文案，
 * 这里是「哪几张图能画」的唯一判断来源。
 */
export function chartDataFlags(range: StatsRange): Record<string, boolean> {
  const days = range.byDay ?? [];
  const models = range.byModelShare ?? range.byModel ?? [];
  const tools = range.toolCalls ?? [];
  const hours = range.byHour ?? [];
  return {
    daily: days.some((day) => day.turns > 0 || day.inputTokens > 0 || day.outputTokens > 0),
    "model-share": models.length > 0,
    "model-compare": models.length > 0,
    hour: hours.some((hour) => hour.turns > 0 || hour.tokens > 0),
    cache: days.some((day) => day.inputTokens > 0),
    tools: tools.length > 0,
  };
}

/** 六图的静态元信息（标题与顺序），组件据此渲染骨架。 */
export const CHART_SPECS: ReadonlyArray<{ key: string; title: string; subtitle: string }> = [
  { key: "daily", title: "每日 Token 趋势", subtitle: "输入 / 输出堆叠柱 + 缓存命中率" },
  { key: "model-share", title: "模型用量占比", subtitle: "按输入 + 输出 token" },
  { key: "model-compare", title: "模型对比", subtitle: "按实际模型调用次数" },
  { key: "hour", title: "活动时段分布", subtitle: "服务器本地 24 小时" },
  { key: "cache", title: "缓存命中率趋势", subtitle: "按自然日" },
  { key: "tools", title: "工具调用 Top", subtitle: "流式分片去重后计数" },
];

function buildConfigs(range: StatsRange, colorMap: Record<string, string>): ChartSpec[] {
  const days = range.byDay ?? [];
  const models = range.byModelShare ?? range.byModel ?? [];
  const tools = range.toolCalls ?? [];
  const hours = range.byHour ?? [];
  const labels = days.map((day) => day.date.slice(5));
  const cacheRates = dailyCacheRate(range);
  return [
    {
      key: "daily",
      title: "每日 Token 趋势",
      subtitle: "输入 / 输出堆叠柱 + 缓存命中率",
      config: {
        type: "bar",
        data: {
          labels,
          datasets: [
            { label: "输入 Tokens", data: days.map((day) => day.inputTokens), backgroundColor: rgba(colorMap.accent, .72), stack: "tokens", borderRadius: 4 },
            { label: "输出 Tokens", data: days.map((day) => day.outputTokens), backgroundColor: rgba(colorMap.green, .72), stack: "tokens", borderRadius: 4 },
            { type: "line", label: "缓存命中率", data: cacheRates, borderColor: colorMap.amber, backgroundColor: colorMap.amber, yAxisID: "y1", tension: .28, pointRadius: 2 },
          ],
        },
        options: commonOptions(colorMap, {
          ...commonScales(colorMap, true),
          y1: {
            position: "right",
            beginAtZero: true,
            suggestedMax: 100,
            ticks: { color: colorMap.muted, callback: (value: string | number) => `${value}%` },
            grid: { drawOnChartArea: false },
          },
        }),
      },
    },
    {
      key: "model-share",
      title: "模型用量占比",
      subtitle: "按输入 + 输出 token",
      config: {
        type: "doughnut",
        data: {
          labels: models.map((model) => model.model),
          datasets: [{
            data: models.map((model) => model.inputTokens + model.outputTokens),
            backgroundColor: models.map((_, index) => rgba([colorMap.accent, colorMap.green, colorMap.amber, colorMap.accent2, colorMap.red][index % 5] ?? colorMap.accent, .78)),
            borderColor: colorMap.grid,
            borderWidth: 2,
          }],
        },
        options: commonOptions(colorMap, {}),
      },
    },
    {
      key: "model-compare",
      title: "模型对比",
      subtitle: "按实际模型调用次数",
      config: {
        type: "bar",
        data: {
          labels: models.map((model) => model.model),
          datasets: [{
            label: "模型调用",
            data: models.map((model) => model.calls),
            backgroundColor: rgba(colorMap.accent2, .72),
            borderRadius: 4,
          }],
        },
        options: commonOptions(colorMap, {
          x: { beginAtZero: true, ticks: { color: colorMap.muted, precision: 0 }, grid: { color: colorMap.grid } },
          y: { ticks: { color: colorMap.text }, grid: { display: false } },
        }, "y"),
      },
    },
    {
      key: "hour",
      title: "活动时段分布",
      subtitle: "服务器本地 24 小时",
      config: {
        type: "bar",
        data: {
          labels: hours.map((hour) => `${String(hour.hour).padStart(2, "0")}:00`),
          datasets: [{
            label: "活动轮次",
            data: hours.map((hour) => hour.turns),
            backgroundColor: rgba(colorMap.green, .72),
            borderRadius: 4,
          }],
        },
        options: commonOptions(colorMap, commonScales(colorMap)),
      },
    },
    {
      key: "cache",
      title: "缓存命中率趋势",
      subtitle: "按自然日",
      config: {
        type: "line",
        data: {
          labels,
          datasets: [{
            label: "缓存命中率",
            data: cacheRates,
            borderColor: colorMap.amber,
            backgroundColor: rgba(colorMap.amber, .18),
            fill: true,
            tension: .3,
            pointRadius: 2,
          }],
        },
        options: commonOptions(colorMap, {
          x: { ticks: { color: colorMap.muted }, grid: { color: colorMap.grid } },
          y: {
            beginAtZero: true,
            suggestedMax: 100,
            ticks: { color: colorMap.muted, callback: (value: string | number) => `${value}%` },
            grid: { color: colorMap.grid },
          },
        }),
      },
    },
    {
      key: "tools",
      title: "工具调用 Top",
      subtitle: "流式分片去重后计数",
      config: {
        type: "bar",
        data: {
          labels: tools.map((tool) => tool.name),
          datasets: [{
            label: "调用次数",
            data: tools.map((tool) => tool.count),
            backgroundColor: rgba(colorMap.red, .66),
            borderRadius: 4,
          }],
        },
        options: commonOptions(colorMap, {
          x: { beginAtZero: true, ticks: { color: colorMap.muted, precision: 0 }, grid: { color: colorMap.grid } },
          y: { ticks: { color: colorMap.text }, grid: { display: false } },
        }, "y"),
      },
    },
  ];
}

function exportChart(key: string, chart: ChartInstance): void {
  const link = document.createElement("a");
  link.href = chart.toBase64Image("image/png", 2);
  link.download = `agent-stats-${key}-${new Date().toISOString().slice(0, 10)}.png`;
  link.click();
}

export function destroyStatsCharts(): void {
  renderGeneration += 1;
  for (const observer of observers) observer.disconnect();
  observers = [];
  for (const chart of charts) chart.destroy();
  charts = [];
}

/**
 * 在 Vue 渲染好的卡片骨架上创建图表。
 * @param root 图表区根节点（含 [data-chart-key] 卡片）
 * @param onFallback 图表库加载失败时回调，由组件切成数据表降级
 */
export async function renderCharts(
  range: StatsRange,
  root: HTMLElement | null,
  onFallback?: (reason: string) => void,
): Promise<void> {
  destroyStatsCharts();
  const generation = renderGeneration;
  currentRange = range;
  currentRoot = root;
  currentFallback = onFallback ?? null;
  if (!themeBound) {
    themeBound = true;
    window.addEventListener("themechange", () => {
      if (currentRange) void renderCharts(currentRange, currentRoot, currentFallback ?? undefined);
    });
  }
  if (!root) return;

  let mod: ChartModule;
  try {
    mod = await import("chart.js/auto");
  } catch {
    onFallback?.("图表依赖加载失败（网络中断或构建产物缺失）");
    return;
  }
  if (generation !== renderGeneration || !root.isConnected) return;

  const colorMap = colors();
  const specs = buildConfigs(range, colorMap);
  for (const spec of specs) {
    const card = root.querySelector<HTMLElement>(`[data-chart-key="${spec.key}"]`);
    if (!card) continue;
    // 无数据的卡片由组件渲染成一行空态文案，压根没有 canvas —— 直接跳过。
    // 骨架里不再需要「隐藏 canvas + 显示浮层空态」这套运行时切换。
    const canvas = card.querySelector<HTMLCanvasElement>("canvas");
    const exportButton = card.querySelector<HTMLButtonElement>(".stats-chart-export");
    if (!canvas) continue;
    const chart = new mod.Chart(canvas, spec.config);
    charts.push(chart);
    if (exportButton) {
      exportButton.disabled = false;
      exportButton.addEventListener("click", () => exportChart(spec.key, chart));
    }
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => chart.resize());
      observer.observe(card);
      observers.push(observer);
    }
  }
}
