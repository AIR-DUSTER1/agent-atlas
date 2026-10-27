/**
 * ============================================================
 * views/settings.ts — 设置页骨架：分区导航 / 插件目录 / 开合
 * ============================================================
 * 职责：设置页的打开关闭、四个分区的切换与懒加载、插件目录卡片。
 * 设计立场：
 *  - 分区懒加载：只有切到某个分区才拉它的数据（打开设置不该打一堆请求）；
 *  - 分区内容各自独立成模块（backup / memories / stats），本文件只管导航；
 *  - 插件卡片的「已就绪」判定依赖 RAG / 贝壳两处状态，进分区时统一刷新。
 */

import { $, setSidebarOpen } from "../core/dom.js";
import { api } from "../core/api.js";
import { state } from "../core/state.js";
import { BUILTIN_PLUGINS, pluginTransportMeta } from "../modules/plugin-registry.js";
import { applyConfigState } from "./composer-bar.js";
import { closeCmMenus } from "./navigation.js";
import { closeComposerMenu } from "../composer/menu.js";
import { refreshBackups } from "./settings-backup.js";
import { refreshMemories, memStatus } from "./settings-memories.js";
import { refreshCommands, cmdStatus } from "./settings-commands.js";
import { refreshSkills } from "./settings-skills.js";
import { refreshMcp } from "./settings-mcp.js";
import { refreshStats } from "./stats/index.js";
import { destroyStatsCharts } from "./stats/charts.js";
import type { AppConfig, EstateState, RagState } from "../modules/types.js";

const SETTINGS_VIEWS = new Set(["models", "plugins", "memories", "commands", "skills", "mcp", "stats"]);

export function isSettingsPageOpen(): boolean {
  const page = $("settings-page");
  return Boolean(page) && !page?.classList.contains("hidden");
}

/** 切换设置页分区；数据只在对应分区被选中时懒加载。 */
export function showSettingsView(view: string): void {
  const next = SETTINGS_VIEWS.has(view) ? view : "models";
  state.settingsView = next;
  document.querySelectorAll<HTMLElement>(".settings-nav-item").forEach((btn) => {
    const active = btn.dataset.settingsView === next;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", String(active));
  });
  document.querySelectorAll<HTMLElement>(".settings-view").forEach((panel) => {
    panel.classList.toggle("hidden", panel.dataset.settingsPanel !== next);
  });
  if (next !== "stats") destroyStatsCharts();
  const content = document.querySelector<HTMLElement>(".settings-page-content");
  if (content) content.scrollTop = 0;

  if (next === "models") {
    api<AppConfig>("/api/config").then(applyConfigState).catch(() => {});
    void refreshBackups().catch(() => {}); // 备份列表懒加载（失败不打扰设置流程）
  } else if (next === "plugins") {
    void loadPluginStates();
  } else if (next === "memories") {
    void refreshMemories().catch((err) => memStatus(`✗ ${(err as Error).message}`, "err"));
  } else if (next === "commands") {
    void refreshCommands().catch((err) => cmdStatus(`✗ ${(err as Error).message}`, "err"));
  } else if (next === "skills") {
    void refreshSkills().catch(() => {});
  } else if (next === "mcp") {
    void refreshMcp().catch(() => {});
  } else {
    refreshStats();
  }
}

/** 插件状态依赖 RAG / 贝壳两处，统一在进入分区时刷新 */
async function loadPluginStates(): Promise<void> {
  try { state.rag = await api<RagState>("/api/rag"); } catch { /* 旧服务进程无该接口 */ }
  try { state.estate = await api<EstateState>("/api/estate"); } catch { /* 同上 */ }
  renderPluginCards();
}

/** 打开独立设置页；models 分区可带供应商 id 做定位高亮。 */
export function openSettings(view = "models", focusProviderId: string | null = null): void {
  void import("./model-menu.js").then((m) => m.showProviderMenu(false));
  closeCmMenus();
  closeComposerMenu();
  setSidebarOpen(false);
  const target = SETTINGS_VIEWS.has(view) ? view : "models";
  void import("./model-store.js").then((m) => m.setSettingsFocus(target === "models" ? focusProviderId : null));
  void import("./model-form.js").then((m) => m.closeProviderForm());
  $("settings-page")?.classList.remove("hidden");
  document.body.classList.add("settings-open");
  showSettingsView(target);
  requestAnimationFrame(() => $("settings-back-btn")?.focus());
}

/** 返回工作台；表单状态在离开时清理，避免下次打开残留。 */
export function closeSettingsPage(): void {
  const page = $("settings-page");
  if (!page || page.classList.contains("hidden")) return;
  page.classList.add("hidden");
  document.body.classList.remove("settings-open");
  void import("./model-form.js").then((m) => m.closeProviderForm());
  $("settings-btn")?.focus();
}

/** 插件目录按真实接入类型渲染：HTTP / CLI / MCP 不混用配置方式。 */
export function renderPluginCards(): void {
  const list = $("plugin-list");
  if (!list) return;
  list.innerHTML = "";
  for (const plugin of BUILTIN_PLUGINS) {
    const transport = pluginTransportMeta(plugin.transport);
    const ready = plugin.id === "rag"
      ? Boolean(state.rag?.configured)
      : Boolean(state.estate?.installed);
    const status = plugin.id === "rag"
      ? (ready ? "已配置" : "未配置")
      : (ready ? `已安装${state.estate?.version ? ` ${state.estate.version}` : ""}` : "未安装");
    const card = document.createElement("article");
    card.className = "plugin-card";
    card.dataset.transport = transport.id;
    card.innerHTML = `
      <div class="plugin-main">
        <div class="plugin-icon"></div>
        <div class="plugin-copy">
          <div class="plugin-title-row"><h3></h3><span class="plugin-kind"></span></div>
          <p class="plugin-desc"></p>
          <div class="plugin-runtime-row"><span class="plugin-runtime"></span><span class="plugin-status"></span></div>
        </div>
      </div>
      <button type="button" class="plugin-manage btn btn-approve"></button>`;
    const iconEl = card.querySelector(".plugin-icon");
    if (iconEl) iconEl.textContent = plugin.icon;
    const h3 = card.querySelector("h3");
    if (h3) h3.textContent = plugin.name;
    const kind = card.querySelector(".plugin-kind");
    if (kind) {
      kind.textContent = transport.label;
      kind.classList.add(`kind-${transport.id}`);
    }
    const desc = card.querySelector(".plugin-desc");
    if (desc) desc.textContent = plugin.description;
    const runtime = card.querySelector(".plugin-runtime");
    if (runtime) runtime.textContent = plugin.runtime;
    const statusEl = card.querySelector(".plugin-status");
    if (statusEl) {
      statusEl.textContent = status;
      statusEl.classList.toggle("ready", ready);
    }
    const button = card.querySelector<HTMLButtonElement>(".plugin-manage");
    if (button) {
      button.textContent = plugin.manageLabel;
      button.addEventListener("click", () => {
        if (plugin.id === "rag") void import("./rag.js").then((m) => m.openKb());
        else if (plugin.id === "estate") void import("./estate.js").then((m) => m.openEstate());
      });
    }
    list.appendChild(card);
  }
}
