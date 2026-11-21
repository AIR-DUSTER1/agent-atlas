/**
 * ============================================================
 * apps/settings-plugins-vue.ts — 插件面板 Vue 挂载（M4 批次 4.1）
 * ============================================================
 * 把 settings-plugins-vue.vue 挂进插件面板的 #plugins-vue-mount 容器。
 * 本模块只被 views/settings-plugins.ts **动态 import**：
 *  - antdv-next 与 Vue 不进首屏启动闭包（可选项动态加载红线）；
 *  - 过渡期 1:1 树里本模块的静态 .vue 导入会 404，调用方 catch 降级，
 *    迁移完成后（M4 4.2 起 h() 面板退役）该降级分支随之删除。
 */
import { createApp } from "vue";
import SettingsPluginsVue from "../views/settings-plugins-vue.vue";

export function mountPluginsVue(): void {
  const target = document.getElementById("plugins-vue-mount");
  if (!target || target.childElementCount > 0) return;
  createApp(SettingsPluginsVue).mount(target);
}
