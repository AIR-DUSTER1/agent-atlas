/**
 * ============================================================
 * views/settings-routing.ts — 路由分区装载入口（M4 批次 4.2 起）
 * ============================================================
 * 表单与试跑已迁往 Vue（settings-routing-vue.vue + stores/routing.ts）；
 * 本文件只保留 legacy 侧职责：分区懒加载入口 refreshRouting（供 settings.ts
 * 调用，失败时壳把错误写进 #routing-status）。
 * Vue 面板与 store 都经动态 import 进入（1:1 过渡树静态图不得出现 .vue
 * 与裸包名 vue/pinia），本模块静态依赖图保持纯 .ts。
 */

/** 进入 routing 分区时懒加载（挂载 + store.load 一体在组件 onMounted 完成）。 */
export async function refreshRouting(): Promise<void> {
  void import("../apps/settings-routing-vue.js")
    .then((m) => m.mountRoutingVue())
    .catch(() => {});
}
