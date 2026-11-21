/**
 * ============================================================
 * apps/message-list-vue.ts — 消息流块骨架挂载（M4 批次 4.6）
 * ============================================================
 * 把 message-list-vue.vue 挂进 #messages。启动即挂载（空清单就是空列表），
 * 后续由 stores/messages 的 refresh 驱动重渲染。
 * 1:1 过渡树已退役，本模块可被静态 import。
 */
import { createApp } from "vue";
import { pinia } from "../stores/pinia.js";
import MessageListView from "../views/message-list-vue.vue";

export function mountMessageListVue(): void {
  const target = document.getElementById("messages");
  if (!target || target.dataset.vueMounted === "1") return;
  target.dataset.vueMounted = "1";
  createApp(MessageListView).use(pinia).mount(target);
}
