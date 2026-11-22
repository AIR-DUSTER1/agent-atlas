<!--
  stats-panel-vue.vue — 使用统计分区（框架迁移 M4 批次 4.2）
  ============================================================
  职责：区间卡、KPI、明细表与图表骨架的声明式渲染；错误降级区。
  DOM 契约与 h() 版逐 id / 类名一致（stats-window-overview / stats-kpis /
  stats-charts / stats-tables / stats-refresh / stats-selected-title /
  stats-range-meta / stats-updated 与 .stats-* 类），settings-page 单测与
  统计页 e2e 依赖这些锚点。
  立场：
  - 切换 7d/30d 是纯本地重绘（服务端一次给全区间），不发新请求；
  - Chart.js 是 Canvas 命令式库：卡片与 canvas 骨架在这里声明式渲染，
    实例创建交给 views/stats/charts.ts（仍动态 import，失败切数据表降级）；
  - 所有数字都过 safeNumber，旧服务缺字段时显示 0，不出现 NaN/Infinity。
-->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useStatsStore } from "../../../stores/stats.js";
import { fmtPercent, fmtTokens } from "../../../modules/format.js";
import { CHART_SPECS, destroyStatsCharts, renderCharts } from "./charts.js";
import type { StatsRange } from "../../../modules/types-api.js";

const store = useStatsStore();

/** 会话表排序维度（本地状态，切区间保留）。 */
const sessionSort = ref<"turns" | "tokens">("turns");
/** 图表降级原因（非空 = 展示数据表）。 */
const chartsFallback = ref("");
const chartsRoot = ref<HTMLElement | null>(null);

function safeNumber(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function rangeTokens(range: StatsRange): number {
  return safeNumber(range.totals.inputTokens) + safeNumber(range.totals.outputTokens);
}

const activeRange = computed(() => store.activeRange);

/** KPI 六卡：与 h() 版逐字段一致。 */
const kpis = computed(() => {
  const range = activeRange.value;
  if (!range) return [];
  const health = range.health;
  const cacheRate = safeNumber(health?.cacheHitRate) * 100;
  const avgMs = safeNumber(health?.avgTurnMs);
  const duration = avgMs >= 1000
    ? `${(avgMs / 1000).toFixed(avgMs >= 10_000 ? 1 : 2)}s`
    : `${Math.round(avgMs)}ms`;
  return [
    { label: "对话轮次", value: String(safeNumber(range.totals.turns)), hint: `${safeNumber(range.totals.sessions)} 个有记录会话` },
    { label: "输入 Tokens", value: fmtTokens(safeNumber(range.totals.inputTokens)), hint: "提示词与工具上下文" },
    { label: "输出 Tokens", value: fmtTokens(safeNumber(range.totals.outputTokens)), hint: "模型生成内容" },
    { label: "缓存命中", value: fmtPercent(cacheRate), hint: `读取 ${fmtTokens(safeNumber(range.totals.cacheReadTokens))}` },
    { label: "平均轮次耗时", value: duration, hint: `${safeNumber(health?.failedTurns)} 次失败 · ${safeNumber(health?.interruptedTurns)} 次中断` },
    { label: "子 Agent 委派", value: String(safeNumber(range.totals.delegateCalls)), hint: `${safeNumber(range.totals.modelCalls)} 次模型调用` },
  ];
});

const rangeMeta = computed(() => {
  const range = activeRange.value;
  if (!range) return "";
  return `${range.startDate} 至 ${range.endDate} · ${safeNumber(range.totals.modelCalls)} 次模型调用 · 按服务器本地自然日统计（含今天）`;
});

const sessionRows = computed(() => {
  const rows = [...(activeRange.value?.topSessions ?? [])];
  return rows.sort((left, right) =>
    sessionSort.value === "tokens" ? right.tokens - left.tokens : right.turns - left.turns);
});

const toolRows = computed(() => activeRange.value?.toolCalls ?? []);

const toolMax = computed(() => Math.max(...toolRows.value.map((row) => row.count), 1));

function barWidth(count: number): string {
  return `${Math.round((count / toolMax.value) * 100)}%`;
}

function selectRange(id: string): void {
  store.selectRange(id);
  chartsFallback.value = "";
}

async function refreshCharts(): Promise<void> {
  const range = activeRange.value;
  if (!range) return;
  chartsFallback.value = "";
  await renderCharts(range, chartsRoot.value, (reason) => { chartsFallback.value = reason; });
}

onMounted(async () => {
  await store.load();
  await refreshCharts();
});

/** 壳重复进入分区时 bump refreshTick → 重新拉数据（组件可能已挂载）。 */
watch(() => store.refreshTick, async () => {
  await store.load();
  await refreshCharts();
});

/** 区间切换只重建图表（KPI/表格由 computed 自动重算）。 */
watch(() => store.activeRangeId, () => { void refreshCharts(); });

/** 错误态出现时销毁旧实例，避免 canvas 泄漏。 */
watch(() => store.error, (value) => { if (value) { destroyStatsCharts(); chartsFallback.value = ""; } });

async function retry(): Promise<void> {
  await store.load();
  await refreshCharts();
}
</script>

<template>
  <div class="stats-page-head">
    <div>
      <h2 id="stats-title"><i class="ui-icon" data-icon="BarChart3" aria-hidden="true"></i> 使用统计</h2>
    </div>
    <button id="stats-refresh" type="button" class="ghost-btn small" :aria-busy="String(store.loading)" :disabled="store.loading" @click="retry">
      <i class="ui-icon" data-icon="RefreshCw" aria-hidden="true"></i> 刷新
    </button>
  </div>

  <div id="stats-window-overview" class="stats-window-overview" aria-label="统计时间区间">
    <button
      v-for="range in store.ranges"
      :key="range.id"
      type="button"
      class="stats-window-card"
      :class="{ active: range.id === store.activeRangeId }"
      :data-stats-range="range.id"
      :aria-pressed="String(range.id === store.activeRangeId)"
      @click="selectRange(range.id)"
    >
      <span class="sw-top">
        <span class="sw-label">{{ range.label }}</span>
        <span class="sw-arrow">查看明细 →</span>
      </span>
      <strong class="sw-turns">{{ safeNumber(range.totals.turns) }} 轮</strong>
      <span class="sw-tokens">{{ fmtTokens(rangeTokens(range)) }} tokens</span>
      <span class="sw-sub">{{ safeNumber(range.totals.sessions) }} 个会话 · {{ safeNumber(range.totals.modelCalls) }} 次模型调用 · {{ range.startDate.slice(5) }} ~ {{ range.endDate.slice(5) }}</span>
    </button>
  </div>

  <div class="stats-selected-head">
    <div>
      <h3 id="stats-selected-title">{{ activeRange ? `${activeRange.label}明细` : "使用统计" }}</h3>
      <p id="stats-range-meta" class="key-state">{{ rangeMeta }}</p>
    </div>
    <span id="stats-updated" class="key-state" aria-live="polite">
      {{ store.loading ? "正在加载…" : store.data ? store.updatedText : "" }}
    </span>
  </div>

  <div id="stats-kpis" class="stats-kpis" aria-label="关键指标">
    <div v-for="kpi in kpis" :key="kpi.label" class="stats-kpi">
      <span class="stats-kpi-label">{{ kpi.label }}</span>
      <strong class="stats-kpi-value">{{ kpi.value }}</strong>
      <span class="stats-kpi-hint">{{ kpi.hint }}</span>
    </div>
  </div>

  <div id="stats-charts" ref="chartsRoot" class="stats-charts" aria-label="统计图表">
    <section v-if="store.error" class="stats-card stats-degraded" role="alert">
      <h3>统计暂不可用</h3>
      <p>{{ store.error }}</p>
      <button type="button" class="ghost-btn small" @click="retry">重试</button>
    </section>
    <template v-else-if="chartsFallback">
      <section class="stats-card stats-degraded" role="status">
        <h3>图表暂不可用</h3>
        <p>已切换为数据表：{{ chartsFallback }}</p>
      </section>
      <div class="stats-grid">
        <section class="stats-card">
          <h3>每日用量</h3>
          <table class="stats-table">
            <thead><tr><th>日期</th><th class="num">轮次</th><th class="num">输入</th><th class="num">输出</th></tr></thead>
            <tbody>
              <tr v-for="day in (activeRange?.byDay ?? []).filter((item) => item.turns > 0)" :key="day.date">
                <td>{{ day.date }}</td>
                <td class="num">{{ day.turns }}</td>
                <td class="num">{{ fmtTokens(day.inputTokens) }}</td>
                <td class="num">{{ fmtTokens(day.outputTokens) }}</td>
              </tr>
            </tbody>
          </table>
        </section>
        <section class="stats-card">
          <h3>模型用量</h3>
          <table class="stats-table">
            <thead><tr><th>模型</th><th class="num">调用</th><th class="num">Tokens</th></tr></thead>
            <tbody>
              <tr v-for="model in activeRange?.byModel ?? []" :key="model.model">
                <td>{{ model.model }}</td>
                <td class="num">{{ model.calls }}</td>
                <td class="num">{{ fmtTokens(model.inputTokens + model.outputTokens) }}</td>
              </tr>
            </tbody>
          </table>
        </section>
      </div>
    </template>
    <template v-else>
      <section v-for="spec in CHART_SPECS" :key="spec.key" class="stats-card stats-chart-card" :data-chart-key="spec.key">
        <div class="stats-card-head">
          <div>
            <h3>{{ spec.title }}</h3>
            <p class="key-state">{{ spec.subtitle }}</p>
          </div>
          <button type="button" class="ghost-btn small stats-chart-export" disabled>存为 PNG</button>
        </div>
        <div class="stats-chart-canvas-wrap">
          <canvas role="img" :aria-label="spec.title"></canvas>
          <p class="stats-chart-empty hidden">当前区间暂无数据。</p>
        </div>
      </section>
    </template>
  </div>

  <div id="stats-tables" class="stats-tables">
    <section class="stats-card stats-table-card">
      <div class="stats-card-head">
        <div>
          <h3>Top 会话</h3>
          <p class="key-state">点击列名切换排序</p>
        </div>
      </div>
      <p v-if="!sessionRows.length" class="memories-empty">当前区间暂无会话记录。</p>
      <table v-else class="stats-table">
        <thead>
          <tr>
            <th>会话</th>
            <th class="num">
              <button type="button" class="stats-sort" :class="{ active: sessionSort === 'turns' }" @click="sessionSort = 'turns'">轮次</button>
            </th>
            <th class="num">
              <button type="button" class="stats-sort" :class="{ active: sessionSort === 'tokens' }" @click="sessionSort = 'tokens'">Tokens</button>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in sessionRows" :key="row.sessionId">
            <td>{{ row.title }}</td>
            <td class="num">{{ row.turns }}</td>
            <td class="num">{{ fmtTokens(row.tokens) }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="stats-card stats-table-card">
      <div class="stats-card-head">
        <div>
          <h3>工具调用</h3>
          <p class="key-state">流式分片按 call id 去重</p>
        </div>
      </div>
      <p v-if="!toolRows.length" class="memories-empty">当前区间暂无工具调用。</p>
      <table v-else class="stats-table">
        <thead><tr><th>工具</th><th class="num">调用次数</th></tr></thead>
        <tbody>
          <tr v-for="row in toolRows" :key="row.name">
            <td>{{ row.name }}</td>
            <td class="tool-count-cell">
              <span class="stats-inline-bar" :style="{ '--bar-width': barWidth(row.count) }"></span>
              <span class="num">{{ row.count }}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </section>
  </div>
</template>
