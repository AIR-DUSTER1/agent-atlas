/**
 * ============================================================
 * views/settings-plugins.ts — 设置页插件目录与启停
 * ============================================================
 * 职责：读取 RAG / 贝壳 / Computer Use 状态，渲染真实接入类型卡片，并提交启停开关。
 * 设计立场：
 *  - 开关只改变 tool allowlist，插件自身配置仍保留；关闭不等于删除配置；
 *  - 卡片文本全部走 h() 的 textContent 语义，不拼用户可控 HTML；
 *  - 关闭 Computer Use 默认不发任何 PowerShell，启用仍受会话权限与审批约束。
 */
import { api } from "../core/api.js";
import { $ } from "../core/dom.js";
import { state } from "../core/state.js";
import { h } from "../ui/h.js";
import { uiAlert } from "../ui/dialog.js";
import { BUILTIN_PLUGINS, pluginTransportMeta, type BuiltinPlugin } from "../modules/plugin-registry.js";
import type { EstateState, PluginSettingsState, RagState } from "../modules/types.js";
import { refreshAgentCards } from "./shell.js";

type PluginId = keyof PluginSettingsState["enabled"];

let statusTimer: ReturnType<typeof setTimeout> | undefined;

function setPluginStatus(text: string, cls = ""): void {
  const el = $("plugin-status");
  if (!el) return;
  el.textContent = text;
  el.className = "settings-status" + (cls ? " " + cls : "");
  clearTimeout(statusTimer);
  if (text) {
    statusTimer = setTimeout(() => {
      if (el.textContent === text) setPluginStatus("");
    }, 6000);
  }
}

function pluginKey(plugin: BuiltinPlugin): PluginId {
  return plugin.id as PluginId;
}

function isEnabled(plugin: BuiltinPlugin): boolean {
  return state.plugins?.enabled[pluginKey(plugin)] ?? plugin.defaultEnabled;
}

function readiness(plugin: BuiltinPlugin): { ready: boolean; label: string } {
  if (plugin.id === "rag") {
    const ready = Boolean(state.rag?.configured);
    return { ready, label: ready ? "已配置" : "未配置" };
  }
  if (plugin.id === "estate") {
    const ready = Boolean(state.estate?.installed);
    return {
      ready,
      label: ready
        ? `已安装${state.estate?.version ? ` ${state.estate.version}` : ""}`
        : "未安装",
    };
  }
  const available = !state.plugins || state.plugins.platform === "win32";
  return { ready: available, label: available ? "Windows 可用" : "仅支持 Windows" };
}

async function togglePlugin(plugin: BuiltinPlugin, input: HTMLInputElement): Promise<void> {
  const next = input.checked;
  input.disabled = true;
  try {
    state.plugins = await api<PluginSettingsState>(`/api/plugins/${encodeURIComponent(plugin.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: next }),
    });
    renderPluginCards();
    refreshAgentCards();
    setPluginStatus(`✓ ${plugin.name}已${next ? "启用" : "停用"}，下一条消息生效`, "ok");
  } catch (err) {
    input.checked = !next;
    input.disabled = false;
    setPluginStatus(`✗ ${(err as Error).message}`, "err");
  }
}

function openPluginManage(plugin: BuiltinPlugin): void {
  if (plugin.id === "rag") {
    void import("./rag.js").then((mod) => mod.openKb());
    return;
  }
  if (plugin.id === "estate") {
    void import("./estate.js").then((mod) => mod.openEstate());
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

/** 首次初始化只需要启停状态；插件页打开后再补齐 RAG / CLI 的详细状态。 */
export async function loadPluginState(): Promise<void> {
  try {
    state.plugins = await api<PluginSettingsState>("/api/plugins");
  } catch {
    // 旧服务进程没有 /api/plugins：保留目录默认值，不阻断启动。
  }
  renderPluginCards();
}

/** 设置页插件分区懒加载：三个接口互不阻塞，任一失败保留其它状态。 */
export async function refreshPluginPanel(): Promise<void> {
  const [rag, estate, plugins] = await Promise.allSettled([
    api<RagState>("/api/rag"),
    api<EstateState>("/api/estate"),
    api<PluginSettingsState>("/api/plugins"),
  ]);
  if (rag.status === "fulfilled") state.rag = rag.value;
  if (estate.status === "fulfilled") state.estate = estate.value;
  if (plugins.status === "fulfilled") state.plugins = plugins.value;
  renderPluginCards();
}

export function renderPluginCards(): void {
  const list = $("plugin-list");
  if (!list) return;
  list.replaceChildren();
  for (const plugin of BUILTIN_PLUGINS) {
    const transport = pluginTransportMeta(plugin.transport);
    const ready = readiness(plugin);
    const enabled = isEnabled(plugin);
    const supported = plugin.id !== "computer" || !state.plugins || state.plugins.platform === "win32";
    const toggle = h("input", {
      type: "checkbox",
      role: "switch",
      "aria-label": supported ? `${enabled ? "停用" : "启用"}${plugin.name}` : `${plugin.name}仅支持 Windows`,
    });
    toggle.checked = enabled;
    toggle.disabled = !supported;
    toggle.addEventListener("change", () => { void togglePlugin(plugin, toggle); });

    const manage = h("button", {
      type: "button",
      class: "plugin-manage btn btn-approve",
      onclick: () => openPluginManage(plugin),
    }, plugin.manageLabel);

    const card = h("article", {
      class: "plugin-card" + (enabled ? "" : " disabled"),
      dataset: { pluginId: plugin.id, transport: transport.id },
    },
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
            h("span", { class: "plugin-status" + (ready.ready ? " ready" : "") }, ready.label),
            h("span", { class: "plugin-enabled-state" + (enabled ? " on" : "") }, enabled ? "已启用" : "已停用"),
          ),
        ),
      ),
      h("div", { class: "plugin-actions" },
        h("label", {
          class: "plugin-switch",
          title: supported ? (enabled ? "停用插件" : "启用插件") : "当前平台不支持",
        }, toggle, h("span", { class: "plugin-switch-track", "aria-hidden": "true" })),
        manage,
      ),
    );
    list.appendChild(card);
  }
}
