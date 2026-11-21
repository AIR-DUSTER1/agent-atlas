/**
 * ============================================================
 * views/model-panel.ts — 模型面板渲染分发桥（M4 4.3 起）
 * ============================================================
 * 左栏导航 / 右栏详情 / 模型列表 / 网关 chips 已迁往 Vue
 * （models-panel-vue.vue + stores/models.ts）：渲染随 store 响应式更新，
 * 本文件只保留两个 legacy 语义：
 *  1. renderProviderList —— legacy 各处「配置变更后刷新面板」的调用点，
 *     现在等价于「从 core state 同步配置 + 确保选中态」；
 *  2. 面板挂载入口 refreshModelsPanel（设置壳 models 分区懒加载调用）。
 * store 经动态 import 进入（本模块在 1:1 过渡树链上）。
 */

async function store() {
  const { useModelsStore } = await import("../stores/models.js");
  return useModelsStore();
}

/** legacy 渲染点语义：从 core state 同步配置并修正选中态（Vue 自动重渲染）。 */
export async function renderProviderList(): Promise<void> {
  const models = await store();
  models.syncConfig(null);
  models.ensureSelection();
}

/** 设置页 models 分区懒加载：挂载 Vue 面板（数据装载在组件 onMounted 完成）。 */
export async function refreshModelsPanel(): Promise<void> {
  void import("../apps/models-panel-vue.js")
    .then((m) => m.mountModelsPanelVue())
    .catch(() => {});
}
