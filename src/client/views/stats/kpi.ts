/**
 * views/stats/kpi.ts — 使用统计 KPI 卡
 * ============================================================
 * 只消费 StatsRange，不请求网络；百分比与耗时都做有限数保护，旧服务响应缺字段时
 * 显示 0，不出现 NaN/Infinity。
 */
import { fmtPercent, fmtTokens } from "../../modules/format.js";
import { h } from "../../ui/h.js";
import type { StatsRange } from "../../modules/types.js";

function safeNumber(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function metric(label: string, value: string, hint: string): HTMLElement {
  return h("div", { class: "stats-kpi" },
    h("span", { class: "stats-kpi-label" }, label),
    h("strong", { class: "stats-kpi-value" }, value),
    h("span", { class: "stats-kpi-hint" }, hint),
  );
}

export function renderKpis(container: HTMLElement | null, range: StatsRange): void {
  if (!container) return;
  const health = range.health;
  const cacheRate = safeNumber(health?.cacheHitRate) * 100;
  const avgMs = safeNumber(health?.avgTurnMs);
  const duration = avgMs >= 1000 ? `${(avgMs / 1000).toFixed(avgMs >= 10_000 ? 1 : 2)}s` : `${Math.round(avgMs)}ms`;
  container.replaceChildren(
    metric("对话轮次", String(safeNumber(range.totals.turns)), `${safeNumber(range.totals.sessions)} 个有记录会话`),
    metric("输入 Tokens", fmtTokens(safeNumber(range.totals.inputTokens)), "提示词与工具上下文"),
    metric("输出 Tokens", fmtTokens(safeNumber(range.totals.outputTokens)), "模型生成内容"),
    metric("缓存命中", fmtPercent(cacheRate), `读取 ${fmtTokens(safeNumber(range.totals.cacheReadTokens))}`),
    metric("平均轮次耗时", duration, `${safeNumber(range.health?.failedTurns)} 次失败 · ${safeNumber(range.health?.interruptedTurns)} 次中断`),
    metric("子 Agent 委派", String(safeNumber(range.totals.delegateCalls)), `${safeNumber(range.totals.modelCalls)} 次模型调用`),
  );
}
