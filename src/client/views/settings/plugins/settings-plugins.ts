/**
 * ============================================================
 * views/settings-plugins.ts — 插件面板数据装载与 legacy 对话框入口
 * ============================================================
 * M4 批次 4.1 起卡片渲染与启停写回已迁往 Vue（settings-plugins-vue.vue +
 * stores/plugins.ts）；本文件只保留三件 legacy 侧职责：
 *  1. 面板状态装载入口（loadPluginState / refreshPluginPanel，供壳与 main 调用）；
 *  2. #plugin-status 状态行写入（Vue 组件与壳的错误路径共用）；
 *  3. 「管理」按钮的 legacy 对话框跳转（RAG / 贝壳 / 求职面板尚未 Vue 化）。
 * 设计立场：
 *  - 开关只改变 tool allowlist，插件自身配置仍保留；关闭不等于删除配置；
 *  - Vue 面板与 Pinia store 都经**动态 import** 进入：1:1 过渡树（tsc）的
 *    静态图不能出现 .vue 与裸包名（vue/pinia），否则浏览器按 1:1 路径
 *    import 内部模块（render/parts.js → estate.js → 本模块）整链崩断；
 *  - 本模块的静态依赖图保持纯 .ts、零前端框架依赖。
 */
import { $ } from "../../../core/dom.js";
import { uiAlert } from "../../../ui/dialog.js";
import { state } from "../../../core/state.js";
import type { BuiltinPlugin } from "../../../modules/plugin-registry.js";

let statusTimer: ReturnType<typeof setTimeout> | undefined;

/** 状态行写入（#plugin-status，static HTML）：空文案即清零计时器。 */
export function pluginStatus(text: string, cls = ""): void {
  const el = $("plugin-status");
  if (!el) return;
  el.textContent = text;
  el.className = "settings-status" + (cls ? " " + cls : "");
  clearTimeout(statusTimer);
  if (text) {
    statusTimer = setTimeout(() => {
      if (el.textContent === text) pluginStatus("");
    }, 6000);
  }
}

/** 面板打开时「管理」按钮：跳转对应 legacy 面板或弹出能力说明。 */
export function openPluginManage(plugin: BuiltinPlugin): void {
  if (plugin.id === "rag") {
    void import("../../kb/rag.js").then((mod) => mod.openKb());
    return;
  }
  if (plugin.id === "estate") {
    void import("../../estate/estate.js").then((mod) => mod.openEstate());
    return;
  }
  if (plugin.id === "job") {
    void import("../../job/job.js").then((mod) => mod.openJob());
    return;
  }
  if (plugin.id === "browser") {
    const status = state.browser;
    void uiAlert(
      "Browser Use 使用本机 Chrome / Edge 的无头浏览器，不持久化账号数据，空闲 10 分钟自动回收。\n\n" +
      "启用后通用 Agent 可以打开网页、读取真实渲染内容、点击、填写表单和滚动；所有会改变页面的动作仍需人工审批。\n\n" +
      (status?.available
        ? `当前浏览器：${status.browserName}（${status.executableName}）`
        : status?.error || "当前未检测到可用浏览器，可设置 BROWSER_USE_EXECUTABLE_PATH。"),
      "Browser Use 说明"
    );
    return;
  }
  if (plugin.id === "computer") {
    void uiAlert(
      "Computer Use 只在本机 Windows 桌面会话可用。\n\n" +
      "启用后通用 Agent 才能调用截图、点击、输入、按键和滚动工具；动作仍受会话权限与高风险审批约束。\n\n" +
      "默认关闭是为了避免应用在用户未授权时获得本机控制能力。",
      "Computer Use 说明"
    );
  }
}

/** 首次初始化只需要启停状态（main 启动时调用一次）。 */
export async function loadPluginState(): Promise<void> {
  const { usePluginsStore } = await import("../../../stores/plugins.js");
  await usePluginsStore().loadEnabled();
}

/** 设置页插件分区懒加载：挂载 Vue 面板后由 store 拉取各插件运行态。 */
export async function refreshPluginPanel(): Promise<void> {
  // Vue 面板经动态 import 进入（1:1 过渡树里 .vue 缺失会拒绝，降级不影响状态装载）；
  // 4.5 壳反转后面板随应用壳一起挂载，本动态分支随之退役。
  void import("./settings-plugins-vue.js")
    .then((m) => m.mountPluginsVue())
    .catch(() => {});
  const { usePluginsStore } = await import("../../../stores/plugins.js");
  await usePluginsStore().refreshAll();
}

/** legacy 侧（rag / estate 配置流）改写状态后刷新插件卡片：同步回 store，Vue 卡片自动重渲染。 */
export function refreshPluginCards(): void {
  void import("../../../stores/plugins.js")
    .then(({ usePluginsStore }) => usePluginsStore().syncFromLegacyState())
    .catch(() => {});
}
