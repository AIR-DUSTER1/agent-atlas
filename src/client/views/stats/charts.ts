/**
 * views/stats/charts.ts — Chart.js 六图与降级
 * ============================================================
 * 图表库由动态 import 加载，加载失败只替换统计区为数据表，不影响设置页与会话。
 * 每张图有独立容器、ResizeObserver、PNG 导出；主题切换时销毁并按语义 token 重建。
 */
import { fmtTokens } from "../../modules/format.js";
import { h } from "../../ui/h.js";
import type { ChartConfiguration } from "../../vendor/chart.js";
import type { StatsRange } from "../../modules/types.js";

type ChartOptions = NonNullable<ChartConfiguration["options"]>;

type ChartModule = typeof import("../../vendor/chart.js");
type ChartInstance = InstanceType<ChartModule["Chart"]>;

interface ChartCard {
  key: string;
  title: string;
  subtitle: string;
  card: HTMLElement;
  canvas: HTMLCanvasElement;
  exportButton: HTMLButtonElement;
  empty: HTMLElement;
}

let charts: ChartInstance[] = [];
let observers: ResizeObserver[] = [];
let currentRange: StatsRange | null = null;
let themeBound = false;
let renderGeneration = 0;

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

function chartCard(title: string, subtitle: string): ChartCard {
  const canvas = h("canvas", { role: "img", "aria-label": title });
  const empty = h("p", { class: "stats-chart-empty hidden" }, "当前区间暂无数据。");
  const exportButton = h("button", { type: "button", class: "ghost-btn small", disabled: true }, "存为 PNG");
  const card = h("section", { class: "stats-card stats-chart-card" },
    h("div", { class: "stats-card-head" },
      h("div", null, h("h3", null, title), h("p", { class: "key-state" }, subtitle)),
      exportButton,
    ),
    h("div", { class: "stats-chart-canvas-wrap" }, canvas, empty),
  );
  return { key: title, title, subtitle, card, canvas, exportButton, empty };
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

function buildConfigs(range: StatsRange, colorMap: Record<string, string>): Array<{ key: string; hasData: boolean; config: ChartConfiguration }> {
  const days = range.byDay ?? [];
  const models = range.byModelShare ?? range.byModel ?? [];
  const tools = range.toolCalls ?? [];
  const hours = range.byHour ?? [];
  const labels = days.map((day) => day.date.slice(5));
  const cacheRates = dailyCacheRate(range);
  return [
    {
      key: "daily",
      hasData: days.some((day) => day.turns > 0 || day.inputTokens > 0 || day.outputTokens > 0),
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
      hasData: models.length > 0,
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
      hasData: models.length > 0,
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
      hasData: hours.some((hour) => hour.turns > 0 || hour.tokens > 0),
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
      hasData: days.some((day) => day.inputTokens > 0),
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
      hasData: tools.length > 0,
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

function fallback(range: StatsRange, reason: string): void {
  const container = document.getElementById("stats-charts");
  if (!container) return;
  const days = range.byDay ?? [];
  const models = range.byModel ?? [];
  const dailyBody = h("tbody");
  for (const day of days.filter((item) => item.turns > 0)) {
    dailyBody.appendChild(h("tr", null,
      h("td", null, day.date),
      h("td", { class: "num" }, String(day.turns)),
      h("td", { class: "num" }, fmtTokens(day.inputTokens)),
      h("td", { class: "num" }, fmtTokens(day.outputTokens)),
    ));
  }
  const modelBody = h("tbody");
  for (const model of models) {
    modelBody.appendChild(h("tr", null,
      h("td", null, model.model),
      h("td", { class: "num" }, String(model.calls)),
      h("td", { class: "num" }, fmtTokens(model.inputTokens + model.outputTokens)),
    ));
  }
  container.replaceChildren(
    h("section", { class: "stats-card stats-degraded", role: "status" },
      h("h3", null, "图表暂不可用"),
      h("p", null, `已切换为数据表：${reason}`),
    ),
    h("div", { class: "stats-grid" },
      h("section", { class: "stats-card" }, h("h3", null, "每日用量"), h("table", { class: "stats-table" },
        h("thead", null, h("tr", null, h("th", null, "日期"), h("th", { class: "num" }, "轮次"), h("th", { class: "num" }, "输入"), h("th", { class: "num" }, "输出"))), dailyBody)),
      h("section", { class: "stats-card" }, h("h3", null, "模型用量"), h("table", { class: "stats-table" },
        h("thead", null, h("tr", null, h("th", null, "模型"), h("th", { class: "num" }, "调用"), h("th", { class: "num" }, "Tokens"))), modelBody)),
    ),
  );
}

function exportChart(card: ChartCard, chart: ChartInstance): void {
  const link = document.createElement("a");
  link.href = chart.toBase64Image("image/png", 2);
  link.download = `agent-stats-${card.key}-${new Date().toISOString().slice(0, 10)}.png`;
  link.click();
}

export function destroyStatsCharts(): void {
  renderGeneration += 1;
  for (const observer of observers) observer.disconnect();
  observers = [];
  for (const chart of charts) chart.destroy();
  charts = [];
}

export async function renderCharts(range: StatsRange): Promise<void> {
  destroyStatsCharts();
  const generation = renderGeneration;
  currentRange = range;
  if (!themeBound) {
    themeBound = true;
    window.addEventListener("themechange", () => { if (currentRange) void renderCharts(currentRange); });
  }
  const container = document.getElementById("stats-charts");
  if (!container) return;
  container.replaceChildren();
  const cards = [
    chartCard("每日 Token 趋势", "输入 / 输出堆叠柱 + 缓存命中率"),
    chartCard("模型用量占比", "按输入 + 输出 token"),
    chartCard("模型对比", "按实际模型调用次数"),
    chartCard("活动时段分布", "服务器本地 24 小时"),
    chartCard("缓存命中率趋势", "按自然日"),
    chartCard("工具调用 Top", "流式分片去重后计数"),
  ];
  for (const card of cards) container.appendChild(card.card);

  let mod: ChartModule;
  try {
    mod = await import("../../vendor/chart.js");
  } catch {
    fallback(range, "图表依赖加载失败（网络中断或构建产物缺失）");
    return;
  }

  if (generation !== renderGeneration) return;
  const colorMap = colors();
  const configs = buildConfigs(range, colorMap);
  for (let index = 0; index < cards.length; index += 1) {
    const card = cards[index];
    const item = configs[index];
    if (!card || !item) continue;
    if (item.key === "model-share") {
      const total = (range.byModelShare ?? []).reduce((sum, model) => sum + model.inputTokens + model.outputTokens, 0);
      card.card.querySelector(".stats-chart-canvas-wrap")?.appendChild(
        h("div", { class: "stats-donut-center" },
          h("strong", null, fmtTokens(total)),
          h("span", null, "Tokens"),
        ),
      );
    }
    if (!item.hasData) {
      card.empty.classList.remove("hidden");
      card.canvas.classList.add("hidden");
      continue;
    }
    const chart = new mod.Chart(card.canvas, item.config);
    charts.push(chart);
    card.exportButton.disabled = false;
    card.exportButton.addEventListener("click", () => exportChart(card, chart));
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => chart.resize());
      observer.observe(card.card);
      observers.push(observer);
    }
  }
}
