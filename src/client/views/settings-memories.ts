/**
 * ============================================================
 * views/settings-memories.ts — 记忆面板状态行与装载入口（M4 批次 4.2 起）
 * ============================================================
 * 配置表单/列表管理/导入导出已迁往 Vue（settings-memories-vue.vue +
 * stores/memories.ts）；本文件只保留 legacy 侧职责：
 *  1. #memories-status 状态行写入（Vue 组件与设置壳错误路径共用）；
 *  2. 分区懒加载入口 refreshMemorySettings（供 settings.ts 调用）。
 * Vue 面板与 store 都经动态 import 进入（1:1 过渡树静态图不得出现 .vue
 * 与裸包名 vue/pinia），本模块静态依赖图保持纯 .ts。
 */
import { $ } from "../core/dom.js";

let memStatusTimer: ReturnType<typeof setTimeout> | undefined;

/** 状态行写入（#memories-status，Vue 渲染的无绑定元素）：5 秒后自动清空。 */
export function memStatus(text: string, cls: string): void {
  const el = $("memories-status");
  if (!el) return;
  el.textContent = text;
  el.className = "settings-status" + (cls ? " " + cls : "");
  clearTimeout(memStatusTimer);
  if (text) {
    memStatusTimer = setTimeout(() => {
      if (el.textContent === text) { el.textContent = ""; el.className = "settings-status"; }
    }, 5000);
  }
}

/** 进入 memories 分区时懒加载（挂载 + store.refreshSettings 一体在组件 onMounted 完成）。 */
export async function refreshMemorySettings(): Promise<void> {
  void import("../apps/settings-memories-vue.js")
    .then((m) => m.mountMemoriesVue())
    .catch(() => {});
}
