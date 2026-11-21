/**
 * ============================================================
 * apps/settings-commands-vue.ts — 命令页 Vue 挂载（M4 批次 4.1）
 * ============================================================
 * 把 settings-commands-vue.vue 挂进 #commands-modal 容器（组件渲染双栏
 * 管理页全部内容）。本模块只被 views/settings-commands.ts **动态 import**：
 *  - Vue 不进首屏启动闭包（可选项动态加载红线）；
 *  - 过渡期 1:1 树里本模块的静态 .vue 导入会 404，调用方 catch 降级；
 *  - 挂载一次后不再重复（refreshCommands 重复进入只重置视图 + 刷数据）。
 */
import { createApp } from "vue";
import { pinia } from "../stores/pinia.js";
import SettingsCommandsVue from "../views/settings-commands-vue.vue";

export function mountCommandsVue(): void {
  const target = document.getElementById("commands-modal");
  if (!target || target.dataset.vueMounted === "1") return;
  target.dataset.vueMounted = "1";
  createApp(SettingsCommandsVue).use(pinia).mount(target);
}
