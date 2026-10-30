/**
 * views/settings-subagents.ts — 子代理设置页与编辑器
 * ============================================================
 * 职责：加载子代理目录、渲染启停状态、管理新增/编辑/删除，并把模型选择
 * 绑定到已配置的「供应商 × 模型」。
 *
 * 设计立场：
 *  - 设置页只管理身份、用途、启停和模型；提示词与工具由主 Agent 运行时赋予；
 *  - 所有 DOM 用 h()/textContent 创建，模型名与用户输入不拼 HTML 字符串；
 *  - 关闭编辑器时清空表单状态，保存成功才替换页面快照。
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

let editingId: string | null = null;
let editorOpen = false;
let busy = false;
let trigger: HTMLElement | null = null;

function status(message: string, kind: "ok" | "err" | "" = ""): void {
  const el = $("subagent-status");
  if (!el) return;
  el.textContent = message;
  el.className = `settings-status${kind ? ` ${kind}` : ""}`;
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
  $("subagent-model-picker")?.classList.toggle("hidden", mode !== "fixed");
}

function setEditorBusy(value: boolean): void {
  busy = value;
  for (const id of ["subagent-save-btn", "subagent-delete-btn", "subagent-cancel-btn", "subagent-editor-close"]) {
    const el = $(id) as HTMLButtonElement | null;
    if (el) el.disabled = value;
  }
  const save = $("subagent-save-btn") as HTMLButtonElement | null;
  if (save) save.textContent = value ? "保存中…" : "保存";
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
  if (title) title.textContent = agent ? `编辑 ${agent.name}` : "新建子代理";
  if (eyebrow) eyebrow.textContent = agent ? `ID · ${agent.id}` : "新建子代理";
  remove?.classList.toggle("hidden", !agent);

  const fixed = agent?.model.mode === "fixed" ? agent.model : null;
  populateProviders(fixed?.providerId);
  populateModels(fixed?.modelId);
  syncModelMode();
  $("subagent-editor-mask")?.classList.remove("hidden");
  requestAnimationFrame(() => name?.focus());
}

export function closeSubagentEditor(): void {
  if (!editorOpen) return;
  editorOpen = false;
  editingId = null;
  $("subagent-editor-mask")?.classList.add("hidden");
  editorStatus("");
  trigger?.focus();
  trigger = null;
}

export function isSubagentEditorOpen(): boolean {
  return editorOpen;
}

function modelBadge(agent: SubagentEntry): HTMLElement {
  const label = agent.model.mode === "inherit" ? `继承 · ${agent.modelLabel}` : `固定 · ${agent.modelLabel}`;
  return h("span", {
    class: `subagent-model-badge${agent.model.mode === "fixed" ? " fixed" : ""}${agent.modelAvailable ? "" : " invalid"}`,
    title: agent.modelAvailable ? label : "固定模型不可用，请编辑子代理后重新选择",
  }, label);
}

function renderCards(): void {
  const list = $("subagents-list");
  const empty = $("subagents-empty");
  if (!list || !empty) return;
  list.replaceChildren();
  const agents = state.subagents?.agents ?? [];
  empty.classList.toggle("hidden", agents.length > 0);
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
      class: "ghost-btn small",
      "aria-label": `编辑子代理 ${agent.name}`,
      onclick: () => openEditor(agent),
    }, "编辑");

    const card = h("article", {
      class: `subagent-card${agent.enabled ? "" : " disabled"}`,
      dataset: { subagentId: agent.id },
    },
      h("div", { class: "subagent-card-icon", "aria-hidden": "true" }, icon("Bot", { size: 20 })),
      h("div", { class: "subagent-card-main" },
        h("div", { class: "subagent-card-title" },
          h("h3", null, agent.name),
          h("span", { class: "subagent-card-id" }, agent.id),
          agent.builtIn ? h("span", { class: "subagent-builtin" }, "内置") : null,
        ),
        h("p", { class: "subagent-card-desc" }, agent.description || "未填写用途说明"),
        h("div", { class: "subagent-card-meta" },
          modelBadge(agent),
          h("span", { class: `subagent-state${agent.enabled ? " on" : ""}` }, agent.enabled ? "已启用" : "已停用"),
        ),
      ),
      h("div", { class: "subagent-card-actions" },
        h("label", { class: "subagent-switch", title: agent.enabled ? "停用子代理" : "启用子代理" },
          toggle,
          h("span", { class: "subagent-switch-track", "aria-hidden": "true" }),
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
    status(`✓ ${agent.name}已${input.checked ? "启用" : "停用"}，下一条消息生效`, "ok");
  } catch (err) {
    input.checked = !input.checked;
    input.disabled = false;
    status(`✗ ${(err as Error).message}`, "err");
  }
}

export async function refreshSubagents(): Promise<void> {
  const [config, agents] = await Promise.allSettled([
    api<AppConfig>("/api/config"),
    api<SubagentSettingsState>("/api/subagents"),
  ]);
  if (config.status === "fulfilled") state.config = config.value;
  if (agents.status === "fulfilled") state.subagents = agents.value;
  else throw agents.reason;
  renderCards();
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
    status(`✓ 子代理「${name}」已保存，下一条消息生效`, "ok");
    closeSubagentEditor();
  } catch (err) {
    editorStatus(`✗ ${(err as Error).message}`, "err");
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
    status(`✓ 已删除子代理「${agent.name}」`, "ok");
  } catch (err) {
    editorStatus(`✗ ${(err as Error).message}`, "err");
  } finally {
    setEditorBusy(false);
  }
}

/** 只绑定一次；页面数据按需 refresh。 */
export function bindSubagentSettings(): void {
  $("subagent-add-btn")?.addEventListener("click", () => openEditor());
  $("subagent-editor-close")?.addEventListener("click", closeSubagentEditor);
  $("subagent-cancel-btn")?.addEventListener("click", closeSubagentEditor);
  $("subagent-delete-btn")?.addEventListener("click", () => { void deleteEditing(); });
  $("subagent-model-mode")?.addEventListener("change", syncModelMode);
  $("subagent-provider")?.addEventListener("change", () => populateModels());
  $("subagent-editor")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveEditor();
  });
  const mask = $("subagent-editor-mask");
  mask?.addEventListener("click", (event) => {
    if (event.target === mask) closeSubagentEditor();
  });
  mask?.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeSubagentEditor();
    }
  });
}
