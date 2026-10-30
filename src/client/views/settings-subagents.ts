/**
 * views/settings-subagents.ts — 子代理设置页与编辑器
 * ============================================================
 * 职责：加载子代理目录、搜索筛选、渲染运行状态、管理新增/编辑/删除，
 * 并把模型策略绑定到已配置的「供应商 × 模型」。
 *
 * 设计立场：
 *  - 页面只管理身份、用途、启停和模型；提示词与工具由主 Agent 运行时赋予；
 *  - 状态、模型可用性和启用结果必须同时可读，不能只依赖颜色或开关位置；
 *  - 所有 DOM 用 h()/textContent 创建，用户输入不拼 HTML 字符串；
 *  - 编辑器支持焦点循环、Esc 关闭和未保存修改确认，避免误操作丢配置。
 */
import { $ } from "../core/dom.js";
import { api } from "../core/api.js";
import { state } from "../core/state.js";
import { h } from "../ui/h.js";
import { icon } from "../ui/icon.js";
import { uiConfirm } from "../ui/dialog.js";
import type {
  AppConfig,
  ProviderEntry,
  SubagentEntry,
  SubagentModelSelection,
  SubagentSettingsState,
} from "../modules/types.js";

type SubagentFilter = "all" | "enabled" | "disabled";

let editingId: string | null = null;
let editorOpen = false;
let busy = false;
let trigger: HTMLElement | null = null;
let activeFilter: SubagentFilter = "all";
let searchTerm = "";
let initialSnapshot = "";

function status(message: string, kind: "ok" | "err" | "" = ""): void {
  const el = $("subagent-status");
  if (!el) return;
  el.textContent = message;
  el.className = `settings-status subagent-status-line${kind ? ` ${kind}` : ""}`;
}

function editorStatus(message: string, kind: "ok" | "err" | "" = ""): void {
  const el = $("subagent-editor-status");
  if (!el) return;
  el.textContent = message;
  el.className = `settings-status${kind ? ` ${kind}` : ""}`;
}

function findAgent(id: string | null): SubagentEntry | null {
  return id ? state.subagents?.agents.find((item) => item.id === id) ?? null : null;
}

function providers(): ProviderEntry[] {
  return state.config?.providers ?? [];
}

function option(value: string, label: string, selected = false): HTMLOptionElement {
  const el = h("option", { value }, label) as HTMLOptionElement;
  el.selected = selected;
  return el;
}

function setText(id: string, value: string): void {
  const el = $(id);
  if (el) el.textContent = value;
}

function populateProviders(selectedId?: string): void {
  const select = $("subagent-provider") as HTMLSelectElement | null;
  if (!select) return;
  const list = providers();
  select.replaceChildren();
  if (!list.length) {
    select.appendChild(option("", "尚未配置供应商"));
    select.disabled = true;
    return;
  }
  select.disabled = false;
  for (const provider of list) select.appendChild(option(provider.id, provider.name, provider.id === selectedId));
  if (selectedId && !list.some((provider) => provider.id === selectedId)) {
    select.appendChild(option(selectedId, `已失效：${selectedId}`, true));
  }
  if (!select.value) select.value = list[0]?.id ?? "";
}

function populateModels(selectedId?: string): void {
  const providerSelect = $("subagent-provider") as HTMLSelectElement | null;
  const modelSelect = $("subagent-model") as HTMLSelectElement | null;
  if (!providerSelect || !modelSelect) return;
  const provider = providers().find((item) => item.id === providerSelect.value);
  modelSelect.replaceChildren();
  if (!provider || !provider.models.length) {
    modelSelect.appendChild(option("", "该供应商没有可用模型"));
    modelSelect.disabled = true;
    return;
  }
  modelSelect.disabled = false;
  for (const model of provider.models) {
    modelSelect.appendChild(option(model.id, `${model.displayName} · ${model.name}`, model.id === selectedId));
  }
  if (selectedId && !provider.models.some((model) => model.id === selectedId)) {
    modelSelect.appendChild(option(selectedId, `已失效：${selectedId}`, true));
  }
  if (!modelSelect.value) modelSelect.value = provider.models[0]?.id ?? "";
}

function syncModelMode(): void {
  const mode = ($("subagent-model-mode") as HTMLSelectElement | null)?.value;
  const fixed = mode === "fixed";
  $("subagent-model-picker")?.classList.toggle("hidden", !fixed);
  setText(
    "subagent-model-hint",
    fixed
      ? "执行时固定使用所选供应商模型；若模型被删除或停用，卡片会标记为不可用。"
      : "执行时使用主对话当前实际模型，不复制对话内容。",
  );
}

function setEditorBusy(value: boolean): void {
  busy = value;
  for (const id of ["subagent-save-btn", "subagent-delete-btn", "subagent-cancel-btn", "subagent-editor-close"]) {
    const el = $(id) as HTMLButtonElement | null;
    if (el) el.disabled = value;
  }
  const save = $("subagent-save-btn") as HTMLButtonElement | null;
  if (save) save.textContent = value ? "保存中…" : "保存配置";
}

function editorSnapshot(): string {
  return JSON.stringify({
    name: ($("subagent-name") as HTMLInputElement | null)?.value ?? "",
    description: ($("subagent-description") as HTMLTextAreaElement | null)?.value ?? "",
    enabled: ($("subagent-enabled") as HTMLInputElement | null)?.checked ?? true,
    mode: ($("subagent-model-mode") as HTMLSelectElement | null)?.value ?? "inherit",
    provider: ($("subagent-provider") as HTMLSelectElement | null)?.value ?? "",
    model: ($("subagent-model") as HTMLSelectElement | null)?.value ?? "",
  });
}

function openEditor(agent?: SubagentEntry): void {
  trigger = document.activeElement as HTMLElement | null;
  editingId = agent?.id ?? null;
  editorOpen = true;
  editorStatus("");
  const name = $("subagent-name") as HTMLInputElement | null;
  const description = $("subagent-description") as HTMLTextAreaElement | null;
  const mode = $("subagent-model-mode") as HTMLSelectElement | null;
  const enabled = $("subagent-enabled") as HTMLInputElement | null;
  const title = $("subagent-editor-title");
  const eyebrow = $("subagent-editor-eyebrow");
  const remove = $("subagent-delete-btn");

  if (name) name.value = agent?.name ?? "";
  if (description) description.value = agent?.description ?? "";
  if (enabled) enabled.checked = agent?.enabled ?? true;
  if (mode) mode.value = agent?.model.mode ?? "inherit";
  if (title) title.textContent = agent ? "编辑子代理" : "新建子代理";
  if (eyebrow) eyebrow.textContent = agent ? `子代理 · ${agent.id}` : "子代理目录";
  remove?.classList.toggle("hidden", !agent);

  const fixed = agent?.model.mode === "fixed" ? agent.model : null;
  populateProviders(fixed?.providerId);
  populateModels(fixed?.modelId);
  syncModelMode();
  initialSnapshot = editorSnapshot();
  $("subagent-editor-mask")?.classList.remove("hidden");
  document.body.classList.add("subagent-editor-open");
  requestAnimationFrame(() => name?.focus());
}

function closeSubagentEditor(): void {
  if (!editorOpen) return;
  const closedId = editingId;
  editorOpen = false;
  editingId = null;
  initialSnapshot = "";
  $("subagent-editor-mask")?.classList.add("hidden");
  document.body.classList.remove("subagent-editor-open");
  editorStatus("");
  const updatedTrigger = closedId
    ? document.querySelector<HTMLElement>(`[data-subagent-id="${closedId}"] .subagent-edit-btn`)
    : null;
  const fallbackTrigger = closedId ? $("subagent-add-btn") : trigger;
  (updatedTrigger ?? fallbackTrigger)?.focus();
  trigger = null;
}

async function requestCloseSubagentEditor(): Promise<void> {
  if (!editorOpen || busy) return;
  if (editorSnapshot() !== initialSnapshot) {
    const confirmed = await uiConfirm("当前配置尚未保存，确定放弃本次修改？", {
      title: "放弃修改",
      okText: "放弃修改",
      danger: true,
    });
    if (!confirmed) return;
  }
  closeSubagentEditor();
}

export function isSubagentEditorOpen(): boolean {
  return editorOpen;
}

function modelBadge(agent: SubagentEntry): HTMLElement {
  const fixed = agent.model.mode === "fixed";
  const label = fixed ? `固定 · ${agent.modelLabel}` : `继承 · ${agent.modelLabel}`;
  return h("span", {
    class: `subagent-model-badge${fixed ? " fixed" : ""}${agent.modelAvailable ? "" : " invalid"}`,
    title: agent.modelAvailable ? label : "固定模型不可用，请配置子代理后重新选择",
  },
    icon(fixed ? "SlidersHorizontal" : "Bot", { size: 12 }),
    h("span", { class: "subagent-model-badge-text" }, label),
  );
}

function agentMatches(agent: SubagentEntry): boolean {
  if (activeFilter === "enabled" && !agent.enabled) return false;
  if (activeFilter === "disabled" && agent.enabled) return false;
  if (!searchTerm) return true;
  return [agent.name, agent.id, agent.description, agent.modelLabel]
    .some((value) => value.toLocaleLowerCase("zh-CN").includes(searchTerm));
}

function syncOverview(agents: readonly SubagentEntry[]): void {
  const enabled = agents.filter((agent) => agent.enabled).length;
  const disabled = agents.length - enabled;
  setText("subagent-stat-total", String(agents.length));
  setText("subagent-stat-enabled", String(enabled));
  setText("subagent-stat-disabled", String(disabled));
  const counts: Record<SubagentFilter, number> = { all: agents.length, enabled, disabled };
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-subagent-filter]")) {
    const filter = button.dataset.subagentFilter as SubagentFilter | undefined;
    if (!filter) continue;
    button.classList.toggle("active", filter === activeFilter);
    button.setAttribute("aria-pressed", String(filter === activeFilter));
    const count = button.querySelector<HTMLElement>("[data-subagent-count]");
    if (count) count.textContent = String(counts[filter]);
  }
}

function updateEmptyState(visible: boolean, total: number): void {
  const empty = $("subagents-empty");
  if (!empty) return;
  empty.classList.toggle("hidden", !visible);
  if (!visible) return;
  if (total === 0) {
    setText("subagents-empty-title", "还没有可用子代理");
    setText("subagents-empty-copy", "新建后，主 Agent 才能通过 delegate_agent 选择它执行专项任务。");
    return;
  }
  setText("subagents-empty-title", "没有匹配的子代理");
  setText("subagents-empty-copy", "调整搜索词或筛选条件后再试。");
}

function renderCards(): void {
  const list = $("subagents-list");
  if (!list) return;
  const allAgents = state.subagents?.agents ?? [];
  const agents = allAgents.filter(agentMatches);
  const visibleCount = agents.length === allAgents.length
    ? `${allAgents.length} 个子代理`
    : `显示 ${agents.length} / ${allAgents.length} 个子代理`;

  syncOverview(allAgents);
  setText("subagents-result-count", visibleCount);
  list.replaceChildren();
  updateEmptyState(agents.length === 0, allAgents.length);

  for (const agent of agents) {
    const toggle = h("input", {
      type: "checkbox",
      role: "switch",
      "aria-label": `${agent.enabled ? "停用" : "启用"}${agent.name}`,
    }) as HTMLInputElement;
    toggle.checked = agent.enabled;
    toggle.addEventListener("change", () => { void toggleAgent(agent, toggle); });

    const edit = h("button", {
      type: "button",
      class: "subagent-edit-btn",
      "aria-label": `配置子代理 ${agent.name}`,
      title: `配置 ${agent.name}`,
      onclick: () => openEditor(agent),
    }, icon("Pencil", { size: 13 }), "配置");

    const titleId = `subagent-title-${agent.id}`;
    const needsAttention = !agent.modelAvailable;
    const card = h("article", {
      class: `subagent-card${agent.enabled ? "" : " disabled"}${needsAttention ? " needs-attention" : ""}`,
      dataset: { subagentId: agent.id },
      "aria-labelledby": titleId,
    },
      h("div", { class: "subagent-card-icon", "aria-hidden": "true" },
        icon("Bot", { size: 20 }),
        h("span", { class: `subagent-card-live${agent.enabled ? "" : " off"}` }),
      ),
      h("div", { class: "subagent-card-main" },
        h("div", { class: "subagent-card-title" },
          h("h3", { id: titleId }, agent.name),
          h("span", { class: "subagent-card-id" }, agent.id),
          agent.builtIn ? h("span", { class: "subagent-builtin" }, "内置") : null,
        ),
        h("p", { class: "subagent-card-desc" }, agent.description || "未填写用途说明"),
        h("div", { class: "subagent-card-meta" },
          modelBadge(agent),
          h("span", { class: "subagent-policy-badge", title: "每次委派由主 Agent 选择工具子集，且只能使用当前安全目录" },
            icon("ShieldCheck", { size: 12 }), "运行时授权工具",
          ),
          !agent.modelAvailable
            ? h("span", { class: "subagent-model-warning" }, icon("CircleAlert", { size: 12 }), "模型不可用")
            : null,
        ),
      ),
      h("div", { class: "subagent-card-actions" },
        h("label", { class: `subagent-switch${agent.enabled ? " on" : ""}`, title: agent.enabled ? "停用子代理" : "启用子代理" },
          h("span", { class: "subagent-switch-copy", "aria-hidden": "true" },
            h("strong", null, agent.enabled ? "已启用" : "已停用"),
            h("small", null, agent.enabled ? "点击停用" : "点击启用"),
          ),
          h("span", { class: "subagent-switch-control" },
            toggle,
            h("span", { class: "subagent-switch-track", "aria-hidden": "true" }),
          ),
        ),
        edit,
      ),
    );
    list.appendChild(card);
  }
}

export function renderSubagents(): void {
  renderCards();
}

async function toggleAgent(agent: SubagentEntry, input: HTMLInputElement): Promise<void> {
  input.disabled = true;
  try {
    state.subagents = await api<SubagentSettingsState>(`/api/subagents/${encodeURIComponent(agent.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: input.checked }),
    });
    renderCards();
    status(`${agent.name}已${input.checked ? "启用" : "停用"}，下一条消息生效`, "ok");
  } catch (err) {
    input.checked = !input.checked;
    input.disabled = false;
    status(`保存失败：${(err as Error).message}`, "err");
  }
}

export async function refreshSubagents(): Promise<void> {
  const list = $("subagents-list");
  list?.setAttribute("aria-busy", "true");
  status("正在同步子代理配置…");
  try {
    const [config, agents] = await Promise.allSettled([
      api<AppConfig>("/api/config"),
      api<SubagentSettingsState>("/api/subagents"),
    ]);
    if (config.status === "fulfilled") state.config = config.value;
    if (agents.status !== "fulfilled") throw agents.reason;
    state.subagents = agents.value;
    renderCards();
    status("");
  } finally {
    list?.removeAttribute("aria-busy");
  }
}

async function saveEditor(): Promise<void> {
  if (busy) return;
  const name = ($("subagent-name") as HTMLInputElement | null)?.value.trim() ?? "";
  const description = ($("subagent-description") as HTMLTextAreaElement | null)?.value.trim() ?? "";
  const enabled = ($("subagent-enabled") as HTMLInputElement | null)?.checked ?? true;
  const mode = ($("subagent-model-mode") as HTMLSelectElement | null)?.value === "fixed" ? "fixed" : "inherit";
  if (!name) {
    editorStatus("名称不能为空", "err");
    $("subagent-name")?.focus();
    return;
  }
  if (!description) {
    editorStatus("用途说明不能为空，主 Agent 需要据此判断何时委派", "err");
    $("subagent-description")?.focus();
    return;
  }

  let model: SubagentModelSelection = { mode: "inherit" };
  if (mode === "fixed") {
    const providerId = ($("subagent-provider") as HTMLSelectElement | null)?.value ?? "";
    const modelId = ($("subagent-model") as HTMLSelectElement | null)?.value ?? "";
    if (!providerId || !modelId) {
      editorStatus("请选择一个有效的供应商与模型", "err");
      return;
    }
    model = { mode: "fixed", providerId, modelId };
  }

  setEditorBusy(true);
  editorStatus("正在保存…");
  try {
    const path = editingId ? `/api/subagents/${encodeURIComponent(editingId)}` : "/api/subagents";
    state.subagents = await api<SubagentSettingsState>(path, {
      method: editingId ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description, enabled, model }),
    });
    renderCards();
    status(`子代理「${name}」已保存，下一条消息生效`, "ok");
    closeSubagentEditor();
  } catch (err) {
    editorStatus(`保存失败：${(err as Error).message}`, "err");
  } finally {
    setEditorBusy(false);
  }
}

async function deleteEditing(): Promise<void> {
  const agent = findAgent(editingId);
  if (!agent || busy) return;
  const confirmed = await uiConfirm(
    `删除子代理「${agent.name}」？已有会话下一条消息将不再看到它。

子代理的身份与模型配置会删除，不影响当前主对话。`,
    { title: "删除子代理", okText: "删除", danger: true },
  );
  if (!confirmed) return;
  setEditorBusy(true);
  try {
    state.subagents = await api<SubagentSettingsState>(`/api/subagents/${encodeURIComponent(agent.id)}`, { method: "DELETE" });
    renderCards();
    closeSubagentEditor();
    status(`已删除子代理「${agent.name}」`, "ok");
  } catch (err) {
    editorStatus(`删除失败：${(err as Error).message}`, "err");
  } finally {
    setEditorBusy(false);
  }
}

function trapEditorFocus(event: KeyboardEvent): void {
  if (!editorOpen) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    void requestCloseSubagentEditor();
    return;
  }
  if (event.key !== "Tab") return;
  const form = $("subagent-editor");
  if (!form) return;
  const focusable = [...form.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )].filter((el) => el.offsetParent !== null);
  if (!focusable.length) return;
  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/** 只绑定一次；页面数据按需 refresh。 */
export function bindSubagentSettings(): void {
  $("subagent-add-btn")?.addEventListener("click", () => openEditor());
  $("subagent-editor-close")?.addEventListener("click", () => { void requestCloseSubagentEditor(); });
  $("subagent-cancel-btn")?.addEventListener("click", () => { void requestCloseSubagentEditor(); });
  $("subagent-delete-btn")?.addEventListener("click", () => { void deleteEditing(); });
  $("subagent-model-mode")?.addEventListener("change", () => {
    syncModelMode();
    editorStatus("");
  });
  $("subagent-provider")?.addEventListener("change", () => {
    populateModels();
    editorStatus("");
  });
  $("subagent-editor")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveEditor();
  });

  const search = $("subagent-search") as HTMLInputElement | null;
  search?.addEventListener("input", () => {
    searchTerm = search.value.trim().toLocaleLowerCase("zh-CN");
    renderCards();
  });
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-subagent-filter]")) {
    button.addEventListener("click", () => {
      const filter = button.dataset.subagentFilter as SubagentFilter | undefined;
      if (!filter || !["all", "enabled", "disabled"].includes(filter)) return;
      activeFilter = filter;
      renderCards();
    });
  }

  const mask = $("subagent-editor-mask");
  mask?.addEventListener("click", (event) => {
    if (event.target === mask) void requestCloseSubagentEditor();
  });
  mask?.addEventListener("keydown", trapEditorFocus);
}
