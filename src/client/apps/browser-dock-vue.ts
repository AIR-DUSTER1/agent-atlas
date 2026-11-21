/**
 * ============================================================
 * apps/browser-dock-vue.ts — Browser Use 画面 Vue 挂载（M4 批次 4.4）
 * ============================================================
 * 把 browser-dock-vue.vue 挂进 #browser-dock-mount。本模块只被
 * views/browser-use.ts **动态 import**（Vue 不进 1:1 静态图，e2e 仍可
 * import("/views/browser-use.js") 驱动同一份轮询与状态机）。
 */
import { createApp } from "vue";
import { pinia } from "../stores/pinia.js";
import BrowserDockVue from "../views/browser-dock-vue.vue";

export function mountBrowserDockVue(): void {
  const target = document.getElementById("browser-dock-mount");
  if (!target || target.dataset.vueMounted === "1") return;
  target.dataset.vueMounted = "1";
  createApp(BrowserDockVue).use(pinia).mount(target);
}

