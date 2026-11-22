/**
 * views/stats/index.ts — 使用统计分区装载入口（M4 批次 4.2 起）
 * ============================================================
 * 区间卡、KPI、明细表、图表骨架与降级区已迁往 Vue（stats-panel-vue.vue +
 * stores/stats.ts）；本文件只保留 legacy 侧职责：分区懒加载入口
 * refreshStats（供 settings.ts 调用）：首次进入挂载组件，再次进入 bump
 * store.refreshTick 让组件重新拉数据。
 * Vue 面板与 store 都经动态 import 进入（1:1 过渡树静态图不得出现 .vue
 * 与裸包名 vue/pinia），本模块静态依赖图保持纯 .ts。
 */

/** 进入 stats 分区时懒加载；已挂载则触发一次数据重载。 */
export function refreshStats(): void {
  void import("./stats-panel-vue.js")
    .then((m) => m.mountStatsVue())
    .catch(() => {});
  void import("../../../stores/stats.js")
    .then(({ useStatsStore }) => { useStatsStore().refreshTick += 1; })
    .catch(() => {});
}
