/**
 * ============================================================
 * apps/settings-mcp-vue.ts — MCP 面板 Vue 挂载（M4 批次 4.2）
 * ============================================================
 * 把 settings-mcp-vue.vue 挂进 #mcp-page 容器（编辑器弹窗在组件模板内）。
 * 本模块只被 views/settings-mcp.ts **动态 import**（Vue 不进 1:1 静态图）。
 */
import { createApp } from "vue";
import { pinia } from "../../../stores/pinia.js";
import SettingsMcpVue from "./settings-mcp-vue.vue";

export function mountMcpVue(): void {
  const target = document.getElementById("mcp-page");
  if (!target || target.dataset.vueMounted === "1") return;
  target.dataset.vueMounted = "1";
  createApp(SettingsMcpVue).use(pinia).mount(target);
}
