/**
 * ============================================================
 * views/shell.ts — 新建对话弹窗 / 欢迎页：命令面与弹窗开合（M4 4.5 起）
 * ============================================================
 * Agent 卡片与示例 chips 的渲染已迁往 Vue（agent-cards-vue.vue /
 * example-chips-vue.vue + stores/shell.ts）；本文件保留：
 *  1. createSession 注入点（由 stream/turn.ts 提供，避免循环依赖）；
 *  2. window 命令面（组件点击 → 建会话，失败给阻塞式对话框）；
 *  3. 新建对话弹窗开合。
 * 本模块在 1:1 静态图上，只动态 import Vue 挂载模块。
 */
import { $ } from "../core/dom.js";
import { uiAlert } from "../ui/dialog.js";
import { refreshWelcomePluginCopy } from "./navigation.js";
import type { SessionKind } from "../modules/types.js";

type CreateSessionFn = (
  kind?: SessionKind | null, demo?: number | null, prefill?: string | null, agentId?: string
) => Promise<void>;

let createSessionFn: CreateSessionFn = async () => {};

function registerShellCommands(): void {
  window.__agentatlasShellCommands = {
    create: (kind, demo, prefill) => {
      void createSessionFn(kind ?? "agent", demo ?? null, prefill ?? null).catch((err) => {
        uiAlert("创建对话失败：" + (err as Error).message, "创建对话");
      });
    },
  };
}

export function bindCreateSession(fn: CreateSessionFn): void {
  createSessionFn = fn;
  registerShellCommands();
}

/** 兼容旧调用名（main.ts 里叫 bindShellCreate）。 */
export const bindShellCreate = bindCreateSession;

/** 通知已挂载的 Vue 卡片重算（插件启停 / 配置加载后）。 */
function notifyShell(): void {
  for (const listener of window.__agentatlasShellListeners ?? []) listener();
}

/** 卡片挂载与重算（幂等；插件启停、配置就绪、启动时都会调用）。 */
export function buildDemoCards(): void {
  void import("../apps/agent-cards-vue.js")
    .then((m) => m.mountAgentCardsVue())
    .catch(() => {});
  notifyShell();
}

/** 示例 chips 挂载（幂等）。 */
export function buildExampleChips(): void {
  void import("../apps/agent-cards-vue.js")
    .then((m) => m.mountExampleChipsVue())
    .catch(() => {});
  notifyShell();
}

/** 插件启停后重建欢迎页与新会话弹窗中的 Agent 卡片。 */
export function refreshAgentCards(): void {
  buildDemoCards();
  refreshWelcomePluginCopy();
}

export function openModal(): void { $("modal-mask")?.classList.remove("hidden"); }
export function closeModal(): void { $("modal-mask")?.classList.add("hidden"); }

/** 兼容既有 import：示例文案常量已迁到 stores/shell.ts，这里转发。 */
export { GENERAL_EXAMPLES } from "../stores/shell.js";
