/**
 * ============================================================
 * views/settings-commands.ts — 命令页数据装载与状态行（M4 批次 4.1 起）
 * ============================================================
 * 列表渲染与编辑器已迁往 Vue（settings-commands-vue.vue + stores/commands.ts）；
 * 本文件只保留三件 legacy 侧职责：
 *  1. #commands-status 状态行写入（Vue 组件与设置壳错误路径共用）；
 *  2. reset 钩子注册（进入设置分区时编辑器回到选择态，Vue 组件挂载时注册）；
 *  3. 分区懒加载入口 refreshCommands（供 settings.ts 调用）。
 * 立场：
 *  - Vue 面板与 Pinia store 都经**动态 import** 进入：1:1 过渡树（tsc）的
 *    静态图不能出现 .vue 与裸包名（vue/pinia），否则浏览器按 1:1 路径
 *    import 内部模块时（settings.js → 本模块 → store）整链崩断；
 *  - 本模块的静态依赖图保持纯 .ts、零前端框架依赖；
 *  - 编辑器停留在选择态：refresh 时重置视图，避免带出上次页面的输入。
 */
import { $ } from "../../../core/dom.js";
import type { UserCommandItem } from "../../../composer/menu.js";

let cmdStatusTimer: ReturnType<typeof setTimeout> | undefined;

/** 状态行写入（#commands-status，Vue 渲染的无绑定元素）：4 秒后自动清空。 */
export function cmdStatus(text: string, cls: string): void {
  const el = $("commands-status");
  if (!el) return;
  el.textContent = text;
  el.className = "settings-status" + (cls ? " " + cls : "");
  clearTimeout(cmdStatusTimer);
  if (text) {
    cmdStatusTimer = setTimeout(() => {
      if (el.textContent === text) {
        el.textContent = "";
        el.className = "settings-status";
      }
    }, 4_000);
  }
}

/** Vue 组件挂载时注册 reset 钩子（卸载时注销，避免指向废弃组件实例）。 */
let commandsResetHook: (() => void) | null = null;

export function registerCommandsReset(hook: (() => void) | null): void {
  commandsResetHook = hook;
}

/** 进入设置分区时重拉列表并同步斜杠菜单；编辑器停留在选择态。 */
export async function refreshCommands(): Promise<UserCommandItem[]> {
  void import("./settings-commands-vue.js")
    .then((m) => m.mountCommandsVue())
    .catch(() => {});
  const { useCommandsStore } = await import("../../../stores/commands.js");
  const commands = await useCommandsStore().refresh();
  commandsResetHook?.();
  cmdStatus("", "");
  return commands;
}
