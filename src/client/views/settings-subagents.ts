/**
 * ============================================================
 * views/settings-subagents.ts — 子代理分区装载入口（M4 批次 4.2 起）
 * ============================================================
 * 列表与编辑器已迁往 Vue（settings-subagents-vue.vue + stores/subagents.ts）；
 * 本文件只保留 legacy 侧职责：
 *  1. 分区懒加载入口 refreshSubagents（供 settings.ts 调用）；
 *  2. 编辑器开关状态钩子 isSubagentEditorOpen（main.ts 的全局 Esc 分流依赖：
 *     编辑器打开时 Esc 由编辑器自身处理，不再透传给供应商弹窗/设置页）。
 * Vue 面板与 store 都经动态 import 进入（1:1 过渡树静态图不得出现 .vue
 * 与裸包名 vue/pinia），本模块静态依赖图保持纯 .ts。
 */

/** 编辑器开关状态钩子：Vue 组件挂载时注册，卸载时注销。 */
let subagentEditorOpenHook: (() => boolean) | null = null;

export function registerSubagentEditorOpenHook(hook: (() => boolean) | null): void {
  subagentEditorOpenHook = hook;
}

export function isSubagentEditorOpen(): boolean {
  return subagentEditorOpenHook?.() ?? false;
}

/** 进入 subagents 分区时懒加载（挂载 + store.refresh 一体在组件 onMounted 完成）。 */
export async function refreshSubagents(): Promise<void> {
  void import("../apps/settings-subagents-vue.js")
    .then((m) => m.mountSubagentsVue())
    .catch(() => {});
}
