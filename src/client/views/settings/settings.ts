/**
 * ============================================================
 * views/settings.ts — 设置页壳：分区切换 / 懒加载 / 开合（M4 批次 4.5 起）
 * ============================================================
 * 导航渲染已迁往 Vue（settings-nav-vue.vue + stores/settings.ts）：本文件
 * 只保留「壳」职责：
 *  1. 分区面板显隐（过渡期分区内容是 include 的 legacy 片段，仍由 DOM 切类）；
 *  2. 分区数据懒加载分发（refreshXxx 桥）；
 *  3. 设置页开合与返回按钮 / 退出登录。
 * 导航状态（当前分区 / 搜索词 / 隐藏项）全部在 store，不再读写 DOM 选中态。
 */
import { $, setSidebarOpen } from "../../core/dom.js";
import { api, logoutSession } from "../../core/api.js";
import { state } from "../../core/state.js";

import { applyConfigState } from "../chat/composer-bar.js";
import { closeCmMenus } from "../app/navigation.js";
import { closeComposerMenu } from "../../composer/menu.js";

import { uiConfirm } from "../../ui/dialog.js";
import { refreshBackups } from "./models/settings-backup.js";
import { refreshModelsPanel } from "./models/model-panel.js";
import { refreshMemorySettings, memStatus } from "./memories/settings-memories.js";
import { refreshCommands, cmdStatus } from "./commands/settings-commands.js";
import { refreshSkills, showSkillStatus } from "./skills/settings-skills.js";
import { refreshMcp } from "./mcp/settings-mcp.js";
import { refreshPluginPanel } from "./plugins/settings-plugins.js";
import { refreshTracing } from "./tracing/settings-tracing.js";
import { refreshSubagents } from "./subagents/settings-subagents.js";
import { refreshRouting } from "./routing/settings-routing.js";
import { refreshStats } from "./stats/index.js";
import { refreshUsers } from "./users/settings-users.js";
import { destroyStatsCharts } from "./stats/charts.js";
import type { AppConfig } from "../../modules/types.js";

/**
 * 分区清单与 stores/settings.ts 的 SETTINGS_NAV_GROUPS 一致（导航由 Vue 渲染）。
 * 这里保留一份本地常量：本模块在 1:1 过渡树链上（settings-plugins → 本模块），
 * 静态 import store 会把 pinia 带进 1:1 静态图并崩掉整条浏览器链。
 */
const SETTINGS_VIEWS = new Set<string>([
  "models", "plugins", "subagents", "routing", "tracing",
  "memories", "commands", "skills", "mcp", "stats", "users",
]);

export function isSettingsPageOpen(): boolean {
  const page = $("settings-page");
  return Boolean(page) && !page?.classList.contains("hidden");
}

/** 切换设置页分区；导航选中态由 Vue 响应 store，面板显隐与懒加载在这里。 */
export function showSettingsView(view: string): void {
  const next = SETTINGS_VIEWS.has(view) ? view : "models";
  state.settingsView = next;
  // 同步 store（Vue 导航据此渲染 active / aria-selected）
  void import("../../stores/settings/settings.js")
    .then(({ useSettingsStore }) => { useSettingsStore().show(next); })
    .catch(() => {});
  document.querySelectorAll<HTMLElement>(".settings-view").forEach((panel) => {
    panel.classList.toggle("hidden", panel.dataset.settingsPanel !== next);
  });
  if (next !== "stats") destroyStatsCharts();
  const content = document.querySelector<HTMLElement>(".settings-page-content");
  if (content) content.scrollTop = 0;

  if (next === "models") {
    void refreshModelsPanel().catch(() => {});
    api<AppConfig>("/api/config").then(applyConfigState).catch(() => {});
    void refreshBackups().catch(() => {}); // 备份列表懒加载（失败不打扰设置流程）
  } else if (next === "plugins") {
    void refreshPluginPanel().catch((err) => setPluginPanelError(err));
  } else if (next === "subagents") {
    void refreshSubagents().catch((err) => setSubagentPanelError(err));
  } else if (next === "tracing") {
    void refreshTracing().catch((err) => setTracingPanelError(err));
  } else if (next === "routing") {
    void refreshRouting().catch((err) => setRoutingPanelError(err));
  } else if (next === "memories") {
    void refreshMemorySettings().catch((err) => memStatus(`✗ ${(err as Error).message}`, "err"));
  } else if (next === "commands") {
    void refreshCommands().catch((err) => cmdStatus(`✗ ${(err as Error).message}`, "err"));
  } else if (next === "skills") {
    void refreshSkills().catch((err) => showSkillStatus(`✗ ${(err as Error).message}`, "err"));
  } else if (next === "mcp") {
    void refreshMcp().catch(() => {});
  } else if (next === "users") {
    // 分区入口对非 admin 隐藏；直开 URL 时这里再挡一层（懒加载即校验）。
    void refreshUsers()
      .then((visible) => {
        if (visible) return;
        void import("../../stores/settings/settings.js").then(({ useSettingsStore }) => {
          useSettingsStore().setHidden("users", true);
        });
        showSettingsView("models");
      })
      .catch(() => showSettingsView("models"));
  } else {
    refreshStats();
  }
}

/** 挂载设置导航组件（幂等；设置页首次打开时调用）。 */
export async function mountSettingsNav(): Promise<void> {
  void import("./settings-nav-vue.js")
    .then((m) => m.mountSettingsNavVue())
    .catch(() => {});
}

function setTracingPanelError(err: unknown): void {
  const el = $("tracing-status");
  if (!el) return;
  el.textContent = "✗ " + (err instanceof Error ? err.message : String(err));
  el.className = "settings-status err";
}

function setPluginPanelError(err: unknown): void {
  const el = $("plugin-status");
  if (!el) return;
  el.textContent = "✗ " + (err instanceof Error ? err.message : String(err));
  el.className = "settings-status err";
}

function setSubagentPanelError(err: unknown): void {
  const el = $("subagent-status");
  if (!el) return;
  el.textContent = "✗ " + (err instanceof Error ? err.message : String(err));
  el.className = "settings-status err";
}

function setRoutingPanelError(err: unknown): void {
  const el = $("routing-status");
  if (!el) return;
  el.textContent = "✗ " + (err instanceof Error ? err.message : String(err));
  el.className = "settings-status err";
}

/** 绑定设置页外壳（返回 / 退出登录）；只执行一次。导航交互由 Vue 组件接管。 */
export function bindSettingsNavigation(): void {
  const logout = $("settings-logout-btn");
  logout?.addEventListener("click", () => {
    void (async () => {
      const confirmed = await uiConfirm("退出后本设备需要重新配对，确定退出？", { title: "退出登录", okText: "退出", danger: true });
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
      return await res.json() as { authenticated?: boolean; authRequired?: boolean; autoSession?: boolean };
    })
    .then((status) => {
      logout?.classList.toggle("hidden", !(status?.authenticated && status.authRequired && !status.autoSession));
    })
    .catch(() => {});
}

/** 打开独立设置页；models 分区可带供应商 id 做定位高亮。 */
export function openSettings(view = "models", focusProviderId: string | null = null): void {
  closeCmMenus();
  closeComposerMenu();
  setSidebarOpen(false);
  const target = SETTINGS_VIEWS.has(view) ? view : "models";
  void mountSettingsNav();
  void import("./models/model-store.js").then((m) => m.setSettingsFocus(target === "models" ? focusProviderId : null));
  void import("./models/model-form.js").then((m) => m.closeProviderForm());
  $("settings-page")?.classList.remove("hidden");
  document.body.classList.add("settings-open");
  showSettingsView(target);
  requestAnimationFrame(() => $("settings-back-btn")?.focus());
}

/** 返回 agentatlas 主界面；表单状态在离开时清理，避免下次打开残留。 */
export function closeSettingsPage(): void {
  const page = $("settings-page");
  if (!page || page.classList.contains("hidden")) return;
  page.classList.add("hidden");
  document.body.classList.remove("settings-open");
  void import("./models/model-form.js").then((m) => m.closeProviderForm());
  $("settings-btn")?.focus();
}
