/**
 * ============================================================
 * views/settings-mcp.ts — MCP 分区状态行与装载入口（M4 批次 4.2 起）
 * ============================================================
 * 列表/编辑器/导入已迁往 Vue（settings-mcp-vue.vue + stores/mcp.ts）；
 * 本文件只保留 legacy 侧职责：
 *  1. #mcp-status / #mcp-editor-status 状态行写入（Vue 组件与壳共用）；
 *  2. 分区懒加载入口 refreshMcp（供 settings.ts 调用）；
 *  3. 编辑器开关状态钩子 isMcpEditorOpen 与外部关闭钩子 closeMcpEditor
 *     （main.ts 的全局 Esc 分流依赖）。
 * Vue 面板与 store 都经动态 import 进入（1:1 过渡树静态图不得出现 .vue
 * 与裸包名 vue/pinia），本模块静态依赖图保持纯 .ts。
 */
import { $ } from "../../../core/dom.js";

let statusTimer: ReturnType<typeof setTimeout> | undefined;

/** 状态行写入：editor=true 写 #mcp-editor-status（不自动清空）。 */
export function showMcpStatus(text: string, cls = "", editor = false): void {
  const el = $(editor ? "mcp-editor-status" : "mcp-status");
  if (!el) return;
  el.textContent = text;
  el.className = "settings-status" + (cls ? " " + cls : "");
  if (editor) return;
  clearTimeout(statusTimer);
  if (text) {
    statusTimer = setTimeout(() => {
      if (el.textContent === text) { el.textContent = ""; el.className = "settings-status"; }
    }, 4500);
  }
}

/** 编辑器开关状态钩子：Vue 组件挂载时注册，卸载时注销。 */
let mcpEditorOpenHook: (() => boolean) | null = null;
let mcpCloseHook: (() => void) | null = null;

export function registerMcpEditorOpenHook(hook: (() => boolean) | null): void {
  mcpEditorOpenHook = hook;
}

export function registerMcpCloseHook(hook: (() => void) | null): void {
  mcpCloseHook = hook;
}

export function isMcpEditorOpen(): boolean {
  return mcpEditorOpenHook?.() ?? false;
}

export function closeMcpEditor(): void {
  mcpCloseHook?.();
}

/** 进入 mcp 分区时懒加载（挂载 + store.refresh 一体在组件内完成）。 */
export async function refreshMcp(): Promise<void> {
  void import("./settings-mcp-vue.js")
    .then((m) => m.mountMcpVue())
    .catch(() => {});
}
