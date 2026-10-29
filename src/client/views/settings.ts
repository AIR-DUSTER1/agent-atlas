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
import { api, logoutSession } from "../core/api.js";
import { state } from "../core/state.js";
import { BUILTIN_PLUGINS, pluginTransportMeta } from "../modules/plugin-registry.js";
import { applyConfigState } from "./composer-bar.js";
import { closeCmMenus } from "./navigation.js";
import { closeComposerMenu } from "../composer/menu.js";
import { h } from "../ui/h.js";
import { uiConfirm } from "../ui/dialog.js";
import { refreshBackups } from "./settings-backup.js";
import { refreshMemories, memStatus, bindMemorySettings } from "./settings-memories.js";
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

/** 过滤左侧设置项；搜索只匹配导航标题/说明，不触碰表单数据。 */
function filterSettingsNav(query: string): void {
  const term = query.trim().toLowerCase();
  const buttons = [...document.querySelectorAll<HTMLElement>(".settings-nav-item")];
  for (const button of buttons) {
    const match = !term || (button.textContent ?? "").toLowerCase().includes(term);
    button.classList.toggle("hidden", !match);
    button.classList.toggle("search-hit", Boolean(term && match));
  }
  for (const group of document.querySelectorAll<HTMLElement>(".settings-nav-group")) {
    const visible = [...group.querySelectorAll<HTMLElement>(".settings-nav-item")].some((button) => !button.classList.contains("hidden"));
    group.classList.toggle("hidden", !visible);
  }
}

/** 绑定设置页导航、搜索与 `/` 聚焦；只执行一次。 */
export function bindSettingsNavigation(): void {
  bindMemorySettings();
  document.querySelectorAll<HTMLElement>(".settings-nav-item").forEach((button) => {
    button.addEventListener("click", () => showSettingsView(button.dataset.settingsView || "models"));
  });
  const logout = $("settings-logout-btn");
  logout?.addEventListener("click", () => {
    void (async () => {
      const confirmed = await uiConfirm("退出后需要重新输入访问令牌，确定退出？", { title: "退出登录", okText: "退出", danger: true });
      if (!confirmed) return;
      await logoutSession();
      window.location.reload();
    })().catch((err) => {
      logout.textContent = "退出失败";
      logout.title = (err as Error).message;
    });
  });
  void fetch("/api/auth/session", { credentials: "same-origin" })
    .then(async (res) => {
      if (!res.ok) return null;
      return await res.json() as { authenticated?: boolean; authRequired?: boolean };
    })
    .then((status) => {
      logout?.classList.toggle("hidden", !(status?.authenticated && status.authRequired));
    })
    .catch(() => {});
  const input = $("settings-search") as HTMLInputElement | null;
  if (!input) return;
  input.addEventListener("input", () => filterSettingsNav(input.value));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && input.value) {
      input.value = "";
      filterSettingsNav("");
      event.preventDefault();
      event.stopPropagation();
    } else if (event.key === "Enter") {
      const first = document.querySelector<HTMLElement>(".settings-nav-item:not(.hidden)");
      if (first?.dataset.settingsView) {
        showSettingsView(first.dataset.settingsView);
        first.focus();
      }
      event.preventDefault();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "/" || !isSettingsPageOpen()) return;
    const target = event.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    event.preventDefault();
    input.focus();
    input.select();
  });
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
  const search = $("settings-search") as HTMLInputElement | null;
  if (search) search.value = "";
  filterSettingsNav("");
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
  list.replaceChildren();
  for (const plugin of BUILTIN_PLUGINS) {
    const transport = pluginTransportMeta(plugin.transport);
    const ready = plugin.id === "rag"
      ? Boolean(state.rag?.configured)
      : Boolean(state.estate?.installed);
    const status = plugin.id === "rag"
      ? (ready ? "已配置" : "未配置")
      : (ready ? `已安装${state.estate?.version ? ` ${state.estate.version}` : ""}` : "未安装");
    const manage = h("button", {
      type: "button",
      class: "plugin-manage btn btn-approve",
      onclick: () => {
        if (plugin.id === "rag") void import("./rag.js").then((mod) => mod.openKb());
        else if (plugin.id === "estate") void import("./estate.js").then((mod) => mod.openEstate());
      },
    }, plugin.manageLabel);
    const card = h("article", { class: "plugin-card", dataset: { transport: transport.id } },
      h("div", { class: "plugin-main" },
        h("div", { class: "plugin-icon", "aria-hidden": "true" }, plugin.icon),
        h("div", { class: "plugin-copy" },
          h("div", { class: "plugin-title-row" },
            h("h3", null, plugin.name),
            h("span", { class: `plugin-kind kind-${transport.id}` }, transport.label),
          ),
          h("p", { class: "plugin-desc" }, plugin.description),
          h("div", { class: "plugin-runtime-row" },
            h("span", { class: "plugin-runtime" }, plugin.runtime),
            h("span", { class: "plugin-status" + (ready ? " ready" : "") }, status),
          ),
        ),
      ),
      manage,
    );
    list.appendChild(card);
  }
}
