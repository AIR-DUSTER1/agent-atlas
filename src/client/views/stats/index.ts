/**
 * views/stats/index.ts — 使用统计页面编排
 * ============================================================
 * 一次请求同时获取 7/30 天；切换区间只重绘 KPI、图表与表格。请求设硬超时，
 * 图表模块失败不会影响页面其余内容，刷新序号防止旧响应覆盖新状态。
 */
import { api } from "../../core/api.js";
import { h } from "../../ui/h.js";
import { fmtTokens } from "../../modules/format.js";
import { renderCharts, destroyStatsCharts } from "./charts.js";
import { renderKpis } from "./kpi.js";
import { renderTables } from "./tables.js";
import type { StatsRange, StatsResult } from "../../modules/types.js";

const RANGE_ORDER = ["7d", "30d"];
const REQUEST_TIMEOUT_MS = 8_000;
let activeRangeId = "7d";
let requestSeq = 0;

function rangeById(data: StatsResult | null, id: string): StatsRange | null {
  return data?.ranges.find((range) => range.id === id) ?? null;
}

function rangeTokens(range: StatsRange): number {
  return (range.totals.inputTokens ?? 0) + (range.totals.outputTokens ?? 0);
}

function renderOverview(data: StatsResult): void {
  const container = document.getElementById("stats-window-overview");
  if (!container) return;
  const ranges = [...data.ranges].sort((left, right) => RANGE_ORDER.indexOf(left.id) - RANGE_ORDER.indexOf(right.id));
  container.replaceChildren();
  for (const range of ranges) {
    const active = range.id === activeRangeId;
    container.appendChild(h("button", {
      type: "button",
      class: "stats-window-card" + (active ? " active" : ""),
      dataset: { statsRange: range.id },
      "aria-pressed": String(active),
      onclick: () => {
        if (activeRangeId === range.id) return;
        activeRangeId = range.id;
        renderOverview(data);
        renderSelected(data);
      },
    },
    h("span", { class: "sw-top" },
      h("span", { class: "sw-label" }, range.label),
      h("span", { class: "sw-arrow" }, "查看明细 →"),
    ),
    h("strong", { class: "sw-turns" }, `${range.totals.turns} 轮`),
    h("span", { class: "sw-tokens" }, `${fmtTokens(rangeTokens(range))} tokens`),
    h("span", { class: "sw-sub" },
      `${range.totals.sessions} 个会话 · ${range.totals.modelCalls ?? 0} 次模型调用 · ${range.startDate.slice(5)} ~ ${range.endDate.slice(5)}`),
    ));
  }
}

function renderSelected(data: StatsResult): void {
  const range = rangeById(data, activeRangeId);
  if (!range) {
    renderError("没有可展示的统计区间");
    return;
  }
  const title = document.getElementById("stats-selected-title");
  const meta = document.getElementById("stats-range-meta");
  if (title) title.textContent = `${range.label}明细`;
  if (meta) {
    meta.textContent = `${range.startDate} 至 ${range.endDate} · ${range.totals.modelCalls ?? 0} 次模型调用 · 按服务器本地自然日统计（含今天）`;
  }
  renderKpis(document.getElementById("stats-kpis"), range);
  renderTables(document.getElementById("stats-tables"), range);
  void renderCharts(range);
}

function renderStats(data: StatsResult): void {
  if (!data.ranges.length) {
    renderError("统计接口未返回时间区间");
    return;
  }
  if (!data.ranges.some((range) => range.id === activeRangeId)) activeRangeId = data.ranges[0]?.id ?? "7d";
  renderOverview(data);
  renderSelected(data);
  const updated = document.getElementById("stats-updated");
  if (updated) {
    updated.textContent = Number.isFinite(data.generatedAt)
      ? `更新于 ${new Date(data.generatedAt).toLocaleString()}`
      : "已更新";
  }
}

function renderError(message: string): void {
  destroyStatsCharts();
  for (const id of ["stats-window-overview", "stats-kpis", "stats-tables"]) {
    document.getElementById(id)?.replaceChildren();
  }
  const title = document.getElementById("stats-selected-title");
  if (title) title.textContent = "使用统计";
  for (const id of ["stats-range-meta", "stats-updated"]) {
    const el = document.getElementById(id);
    if (el) el.textContent = "";
  }
  const charts = document.getElementById("stats-charts");
  if (charts) {
    charts.replaceChildren(h("section", { class: "stats-card stats-degraded", role: "alert" },
      h("h3", null, "统计暂不可用"),
      h("p", null, message),
      h("button", {
        type: "button",
        class: "ghost-btn small",
        onclick: () => refreshStats(),
      }, "重试"),
    ));
  }
}

export function refreshStats(): void {
  const seq = ++requestSeq;
  const button = document.getElementById("stats-refresh");
  button?.setAttribute("aria-busy", "true");
  if (button instanceof HTMLButtonElement) button.disabled = true;
  const updated = document.getElementById("stats-updated");
  if (updated) updated.textContent = "正在加载…";
  void api<StatsResult>("/api/stats", { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    .then((data) => {
      if (seq !== requestSeq) return;
      renderStats(data);
    })
    .catch((err) => {
      if (seq !== requestSeq) return;
      renderError(`加载失败：${(err as Error).message}`);
    })
    .finally(() => {
      if (seq !== requestSeq) return;
      button?.setAttribute("aria-busy", "false");
      if (button instanceof HTMLButtonElement) button.disabled = false;
    });
}
