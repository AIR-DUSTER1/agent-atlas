/**
 * ============================================================
 * views/settings-stats.ts — 设置页「使用统计」分区（原生 SVG 图表）
 * ============================================================
 * 职责：区间卡片（近 7 / 30 天）、汇总格子、堆叠柱状图、按模型条形、
 * 活跃会话榜。
 * 设计立场：
 *  - 图表全部手写 SVG（前端红线：不引 npm 包）；viewBox 自适应宽度；
 *  - 区间切换只重绘右侧明细，不重新请求（数据一次拉全）；
 *  - 空区间给引导文案而不是空图表，避免让人以为坏了。
 */

import { $ } from "../core/dom.js";
import { api } from "../core/api.js";
import { fmtTokens } from "../modules/format.js";
import type {
  StatsDay, StatsModelRow, StatsRange, StatsResult, StatsSessionRow,
} from "../modules/types.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const STATS_RANGE_ORDER = ["7d", "30d"];
let activeStatsRange = "7d";

function statsRangeById(data: StatsResult | null, id: string): StatsRange | null {
  return (data?.ranges || []).find((range) => range.id === id) ?? null;
}

function statsTokens(range: StatsRange | null): number {
  return (range?.totals?.inputTokens || 0) + (range?.totals?.outputTokens || 0);
}

function statsEmptyText(text: string): HTMLElement {
  const empty = document.createElement("p");
  empty.className = "memories-empty";
  empty.textContent = text;
  return empty;
}

function renderStatsOverview(data: StatsResult): void {
  const container = $("stats-window-overview");
  if (!container) return;
  container.innerHTML = "";
  const ranges = [...(data.ranges || [])].sort(
    (a, b) => STATS_RANGE_ORDER.indexOf(a.id) - STATS_RANGE_ORDER.indexOf(b.id)
  );
  for (const range of ranges) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "stats-window-card" + (range.id === activeStatsRange ? " active" : "");
    button.dataset.statsRange = range.id;
    button.setAttribute("aria-pressed", String(range.id === activeStatsRange));
    button.innerHTML = `
      <span class="sw-top"><span class="sw-label"></span><span class="sw-arrow">查看明细 →</span></span>
      <strong class="sw-turns"></strong>
      <span class="sw-tokens"></span>
      <span class="sw-sub"></span>`;
    const label = button.querySelector(".sw-label");
    if (label) label.textContent = range.label;
    const turns = button.querySelector(".sw-turns");
    if (turns) turns.textContent = `${range.totals.turns} 轮`;
    const tokens = button.querySelector(".sw-tokens");
    if (tokens) tokens.textContent = `${fmtTokens(statsTokens(range))} tokens`;
    const sub = button.querySelector(".sw-sub");
    if (sub) {
      sub.textContent =
        `${range.totals.sessions} 个会话 · ${range.totals.modelCalls ?? 0} 次模型调用 · ${range.startDate.slice(5)} ~ ${range.endDate.slice(5)}`;
    }
    button.addEventListener("click", () => {
      if (activeStatsRange === range.id) return;
      activeStatsRange = range.id;
      renderStatsOverview(data);
      renderStatsRange(statsRangeById(data, activeStatsRange));
    });
    container.appendChild(button);
  }
}

function svgElement(name: string, attrs: Record<string, string | number> = {}): SVGElement {
  const el = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  return el;
}

/** 原生 SVG 堆叠柱图：输入在下、输出在上，不引入任何前端依赖。 */
function renderStatsChart(range: StatsRange): void {
  const container = $("stats-chart");
  if (!container) return;
  container.innerHTML = "";
  const rows: StatsDay[] = range.byDay || [];
  const width = 860;
  const height = 250;
  const pad = { left: 54, right: 14, top: 16, bottom: 32 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const plotBottom = pad.top + plotHeight;
  const tokenMax = Math.max(...rows.map((day) => day.inputTokens + day.outputTokens), 1);
  const svg = svgElement("svg", {
    viewBox: `0 0 ${width} ${height}`,
    class: "stats-chart-svg",
    role: "img",
    "aria-label": `${range.label}每日输入与输出 token 柱状图`,
  });

  for (let index = 0; index <= 4; index += 1) {
    const ratio = index / 4;
    const y = pad.top + plotHeight * (1 - ratio);
    svg.appendChild(svgElement("line", {
      x1: pad.left, y1: y, x2: width - pad.right, y2: y, class: "stats-grid-line",
    }));
    const label = svgElement("text", {
      x: pad.left - 8, y: y + 3, class: "stats-axis-label", "text-anchor": "end",
    });
    label.textContent = fmtTokens(Math.round(tokenMax * ratio));
    svg.appendChild(label);
  }

  const gap = plotWidth / Math.max(rows.length, 1);
  const barWidth = Math.max(3, Math.min(28, gap * 0.62));
  rows.forEach((day, index) => {
    const inputHeight = (day.inputTokens / tokenMax) * plotHeight;
    const outputHeight = (day.outputTokens / tokenMax) * plotHeight;
    const totalHeight = inputHeight + outputHeight;
    const x = pad.left + index * gap + (gap - barWidth) / 2;
    const group = svgElement("g", { class: "stats-bar-group" });
    const title = svgElement("title");
    title.textContent = `${day.date}：输入 ${fmtTokens(day.inputTokens)} · 输出 ${fmtTokens(day.outputTokens)} · 缓存读取 ${fmtTokens(day.cacheReadTokens)} · ${day.turns} 轮`;
    group.appendChild(title);
    if (inputHeight > 0) {
      group.appendChild(svgElement("rect", {
        x, y: plotBottom - inputHeight, width: barWidth, height: inputHeight,
        rx: Math.min(3, barWidth / 3), class: "stats-bar-input",
      }));
    }
    if (outputHeight > 0) {
      group.appendChild(svgElement("rect", {
        x, y: plotBottom - totalHeight, width: barWidth, height: outputHeight,
        rx: Math.min(3, barWidth / 3), class: "stats-bar-output",
      }));
    }
    svg.appendChild(group);
    const showDate = rows.length <= 7 || index === 0 || index === rows.length - 1 || index % 5 === 0;
    if (showDate) {
      const label = svgElement("text", {
        x: x + barWidth / 2, y: height - 9, class: "stats-date-label", "text-anchor": "middle",
      });
      label.textContent = day.date.slice(5);
      svg.appendChild(label);
    }
  });

  svg.appendChild(svgElement("line", {
    x1: pad.left, y1: plotBottom, x2: width - pad.right, y2: plotBottom, class: "stats-axis-line",
  }));
  container.appendChild(svg);
  if (!rows.some((day) => day.inputTokens + day.outputTokens > 0)) {
    const empty = statsEmptyText("该区间暂无 token 用量；发起对话后会自动出现在这里。");
    empty.classList.add("stats-chart-empty");
    container.appendChild(empty);
  }
  const caption = $("stats-chart-caption");
  if (caption) {
    caption.textContent =
      `${range.startDate.slice(5)} 至 ${range.endDate.slice(5)} · 输入 ${fmtTokens(range.totals.inputTokens)} · 输出 ${fmtTokens(range.totals.outputTokens)}`;
  }
}

function renderStatsBars(rows: StatsModelRow[]): void {
  const container = $("stats-models");
  if (!container) return;
  container.innerHTML = "";
  if (!rows.length) {
    container.appendChild(statsEmptyText("当前区间暂无模型调用记录。"));
    return;
  }
  const max = Math.max(...rows.map((row) => row.inputTokens + row.outputTokens), 1);
  for (const row of rows) {
    const total = row.inputTokens + row.outputTokens;
    const wrap = document.createElement("div");
    wrap.className = "bar-row";
    wrap.innerHTML = `
      <span class="bar-label"></span>
      <div class="bar-track"><div class="bar-fill"></div></div>
      <span class="bar-value"></span>
      <span class="bar-sub"></span>`;
    const label = wrap.querySelector(".bar-label");
    if (label) label.textContent = row.model;
    const fill = wrap.querySelector<HTMLElement>(".bar-fill");
    if (fill) fill.style.width = `${Math.round((total / max) * 100)}%`;
    const value = wrap.querySelector(".bar-value");
    if (value) value.textContent = fmtTokens(total);
    const sub = wrap.querySelector(".bar-sub");
    if (sub) sub.textContent = `${row.calls} 次模型调用`;
    wrap.title = `${row.model}\n${row.calls} 次模型调用 · 输入 ${fmtTokens(row.inputTokens)} · 输出 ${fmtTokens(row.outputTokens)} · 缓存读取 ${fmtTokens(row.cacheReadTokens)}`;
    container.appendChild(wrap);
  }
}

function renderStatsSessions(rows: StatsSessionRow[]): void {
  const container = $("stats-sessions");
  if (!container) return;
  container.innerHTML = "";
  if (!rows.length) {
    container.appendChild(statsEmptyText("当前区间暂无会话记录。"));
    return;
  }
  for (const session of rows) {
    const row = document.createElement("div");
    row.className = "stats-session-row";
    row.innerHTML = `<span class="ss-title"></span><span class="ss-meta"></span>`;
    const title = row.querySelector(".ss-title");
    if (title) title.textContent = session.title;
    const meta = row.querySelector(".ss-meta");
    if (meta) meta.textContent = `${session.turns} 轮 · ${fmtTokens(session.tokens)} tokens`;
    container.appendChild(row);
  }
}

function renderStatsRange(range: StatsRange | null): void {
  if (!range) {
    renderStatsError("没有可展示的统计区间");
    return;
  }
  const totals = range.totals;
  const title = $("stats-selected-title");
  if (title) title.textContent = `${range.label}明细`;
  const meta = $("stats-range-meta");
  if (meta) {
    meta.textContent =
      `${range.startDate} 至 ${range.endDate} · ${totals.modelCalls ?? 0} 次模型调用 · 按服务器本地自然日统计（含今天）`;
  }
  const cells: Array<[string, string]> = [
    ["轮次", String(totals.turns ?? 0)],
    ["输入 tokens", fmtTokens(totals.inputTokens ?? 0)],
    ["输出 tokens", fmtTokens(totals.outputTokens ?? 0)],
    ["缓存读取", fmtTokens(totals.cacheReadTokens ?? 0)],
    ["有记录会话", String(totals.sessions ?? 0)],
    ["子 Agent 委派", String(totals.delegateCalls ?? 0)],
  ];
  const totalsEl = $("stats-totals");
  if (totalsEl) {
    totalsEl.innerHTML = "";
    for (const [label, value] of cells) {
      const cell = document.createElement("div");
      cell.className = "stats-cell";
      cell.innerHTML = `<div class="sc-value"></div><div class="sc-label"></div>`;
      const valueEl = cell.querySelector(".sc-value");
      if (valueEl) valueEl.textContent = value;
      const labelEl = cell.querySelector(".sc-label");
      if (labelEl) labelEl.textContent = label;
      totalsEl.appendChild(cell);
    }
  }
  renderStatsChart(range);
  renderStatsBars(range.byModel || []);
  renderStatsSessions(range.topSessions || []);
}

function renderStats(data: StatsResult): void {
  const ranges = data?.ranges || [];
  if (!ranges.length) {
    renderStatsError("统计接口未返回时间区间");
    return;
  }
  if (!ranges.some((range) => range.id === activeStatsRange)) activeStatsRange = ranges[0].id;
  renderStatsOverview(data);
  renderStatsRange(statsRangeById(data, activeStatsRange));
  const updated = $("stats-updated");
  if (updated) {
    updated.textContent = Number.isFinite(data.generatedAt)
      ? `更新于 ${new Date(data.generatedAt).toLocaleString()}`
      : "已更新";
  }
}

function renderStatsError(message: string): void {
  for (const id of ["stats-window-overview", "stats-totals", "stats-models", "stats-sessions", "stats-chart"]) {
    const el = $(id);
    if (el) el.innerHTML = "";
  }
  const title = $("stats-selected-title");
  if (title) title.textContent = "使用统计";
  for (const id of ["stats-range-meta", "stats-updated"]) {
    const el = $(id);
    if (el) el.textContent = "";
  }
  $("stats-chart")?.appendChild(statsEmptyText(`加载失败：${message}`));
}

export function refreshStats(): void {
  const updated = $("stats-updated");
  if (updated) updated.textContent = "正在加载…";
  api<StatsResult>("/api/stats").then(renderStats).catch((err) => {
    renderStatsError((err as Error).message);
  });
}
