<!--
  settings-subagents-vue.vue — 子代理面板（框架迁移 M4 批次 4.2）
  ============================================================
  职责：目录搜索/筛选、运行状态渲染、新增/编辑/删除编辑器（含焦点循环、
  Esc 关闭与未保存确认）。DOM 契约与 h() 版逐 id/类名一致（subagent-* /
  subagents-* / data-subagent-filter / data-subagent-id），样式产物
  e2e（grid 布局、卡片边框、textarea 占满字段）依赖结构不变。
  立场：
  - 页面只管理身份、用途、启停和模型；提示词与工具由主 Agent 运行时赋予；
  - 编辑器焦点循环在 mask 上监听 Tab 实现（与 h() 版同语义）；
  - 领域提示词按下拉实际取值透传（曾硬编码只认 estate 的坑不复现）。
-->
<script setup lang="ts">
import { Button, Checkbox, Input, Select, Switch } from "antdv-next";
import { computed, onUnmounted, ref } from "vue";
import AntdvProvider from "../../../ui/antdv-provider.vue";
import { onMounted } from "vue";
import { useSubagentsStore, type SubagentFilter, type SubagentSavePayload } from "../../../stores/subagents.js";
import { registerSubagentEditorOpenHook } from "./settings-subagents.js";
import type { SubagentEntry, SubagentRouting } from "../../../modules/types.js";
import { uiConfirm } from "../../../ui/dialog.js";

onMounted(() => {
  registerSubagentEditorOpenHook(() => editorOpen.value);
  // 进入分区时同步目录与供应商配置（与 h() 版 refreshSubagents 同语义）
  status("正在同步子代理配置…");
  void store.refresh()
    .then(() => status(""))
    .catch((err: unknown) => status(`✗ ${(err as Error).message}`, "err"));
});
onUnmounted(() => registerSubagentEditorOpenHook(null));

const store = useSubagentsStore();

const statusText = ref("");
const statusKind = ref<"ok" | "err" | "">("");
const editorStatusText = ref("");
const editorStatusKind = ref<"ok" | "err" | "">("");
const activeFilter = ref<SubagentFilter>("all");
const searchTerm = ref("");
const editorOpen = ref(false);
const editingId = ref<string | null>(null);
const busy = ref(false);
const initialSnapshot = ref("");
let trigger: HTMLElement | null = null;
const editorMask = ref<HTMLElement | null>(null);
const editorForm = ref<HTMLElement | null>(null);

// 编辑器表单
const form = ref({
  name: "",
  description: "",
  enabled: true,
  mode: "inherit" as "inherit" | "fixed",
  provider: "",
  model: "",
  keywords: "",
  category: "",
  suitable: "",
  notSuitable: "",
  domain: "",
});

function status(message: string, kind: "ok" | "err" | "" = ""): void {
  statusText.value = message;
  statusKind.value = kind;
}

function editorStatus(message: string, kind: "ok" | "err" | "" = ""): void {
  editorStatusText.value = message;
  editorStatusKind.value = kind;
}

const stats = computed(() => {
  const enabled = store.agents.filter((agent) => agent.enabled).length;
  return { total: store.agents.length, enabled, disabled: store.agents.length - enabled };
});

const filteredAgents = computed(() => store.agents.filter((agent) => {
  if (activeFilter.value === "enabled" && !agent.enabled) return false;
  if (activeFilter.value === "disabled" && agent.enabled) return false;
  const term = searchTerm.value.trim().toLocaleLowerCase("zh-CN");
  if (!term) return true;
  return [agent.name, agent.id, agent.description, agent.modelLabel]
    .some((value) => value.toLocaleLowerCase("zh-CN").includes(term));
}));

const resultCount = computed(() => filteredAgents.value.length === store.agents.length
  ? `${store.agents.length} 个子代理`
  : `显示 ${filteredAgents.value.length} / ${store.agents.length} 个子代理`);

const filterCounts = computed<Record<SubagentFilter, number>>(() => ({
  all: stats.value.total,
  enabled: stats.value.enabled,
  disabled: stats.value.disabled,
}));

const providers = computed(() => store.config?.providers ?? []);
const selectedProviderModels = computed(() =>
  providers.value.find((item) => item.id === form.value.provider)?.models ?? []);

/** 下拉选项：antdv Select 用 options 数组；失效项仍列出来但标记不可用。 */
const MODEL_MODE_OPTIONS = [
  { value: "inherit", label: "继承当前主对话模型（推荐）" },
  { value: "fixed", label: "固定供应商与模型" },
];
const ROUTING_DOMAIN_OPTIONS = [
  { value: "", label: "通用后台子代理提示词" },
  { value: "estate", label: "继承房产顾问提示词与领域规则" },
  { value: "job", label: "继承求职顾问提示词与领域规则" },
];
/** 供应商选项：空配置时给占位项，失效供应商也列出来以便用户改选。 */
const providerOptions = computed(() => {
  const rows = providers.value.map((item) => ({ value: item.id, label: item.name }));
  if (!rows.length) return [{ value: "", label: "尚未配置供应商" }];
  if (invalidProvider.value) rows.push({ value: invalidProvider.value, label: `已失效：${invalidProvider.value}` });
  return rows;
});
const modelOptions = computed(() => {
  const rows = selectedProviderModels.value.map((item) => ({ value: item.id, label: `${item.displayName} · ${item.name}` }));
  if (!rows.length) return [{ value: "", label: "该供应商没有可用模型" }];
  if (invalidModel.value) rows.push({ value: invalidModel.value, label: `已失效：${invalidModel.value}` });
  return rows;
});

const editorModelHint = computed(() => form.value.mode === "fixed"
  ? "执行时固定使用所选供应商模型；若模型被删除或停用，卡片会标记为不可用。"
  : "执行时使用主对话当前实际模型，不复制对话内容。");

function modelBadgeLabel(agent: SubagentEntry): string {
  return agent.model.mode === "fixed" ? `固定 · ${agent.modelLabel}` : `继承 · ${agent.modelLabel}`;
}

/** 逗号/顿号/换行分隔的文本 → 去重字符串数组（设置页与路由层口径一致）。 */
function splitList(raw: string, max: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const piece of raw.split(/[,，、;；\n]+/)) {
    const text = piece.trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(text);
    if (result.length >= max) break;
  }
  return result;
}

function fillForm(agent?: SubagentEntry): void {
  form.value = {
    name: agent?.name ?? "",
    description: agent?.description ?? "",
    enabled: agent?.enabled ?? true,
    mode: agent?.model.mode ?? "inherit",
    provider: agent?.model.mode === "fixed" ? agent.model.providerId : "",
    model: agent?.model.mode === "fixed" ? agent.model.modelId : "",
    keywords: (agent?.routing.keywords ?? []).join(", "),
    category: agent?.routing.category ?? "",
    suitable: (agent?.routing.suitableFor ?? []).join("\n"),
    notSuitable: (agent?.routing.notSuitableFor ?? []).join("\n"),
    domain: agent?.routing.domainProfile ?? "",
  };
}

function readRoutingInput(): SubagentRouting {
  const picked = form.value.domain;
  return {
    keywords: splitList(form.value.keywords, 40),
    ...((form.value.category.trim()) ? { category: form.value.category.trim() } : {}),
    suitableFor: splitList(form.value.suitable, 8),
    notSuitableFor: splitList(form.value.notSuitable, 8),
    // 领域提示词按下拉实际取值透传：这里曾硬编码只认 estate，
    // 导致给求职子代理选了领域后被静默丢弃。
    ...(picked === "estate" ? { domainProfile: "estate" as const } : {}),
    ...(picked === "job" ? { domainProfile: "job" as const } : {}),
  };
}

function editorSnapshot(): string {
  return JSON.stringify({
    name: form.value.name,
    description: form.value.description,
    enabled: form.value.enabled,
    mode: form.value.mode,
    provider: form.value.provider,
    model: form.value.model,
    keywords: form.value.keywords,
    category: form.value.category,
    suitable: form.value.suitable,
    notSuitable: form.value.notSuitable,
    domain: form.value.domain,
  });
}

/** 切到固定模型时默认选中第一个模型（h() 版靠浏览器自动选中首项，v-model 需显式补）。 */
function onModeChange(): void {
  editorStatus("");
  if (form.value.mode === "fixed") {
    if (!form.value.provider && providers.value.length) form.value.provider = providers.value[0]?.id ?? "";
    if (!form.value.model && selectedProviderModels.value.length) {
      form.value.model = selectedProviderModels.value[0]?.id ?? "";
    }
  }
}

function openEditor(agent?: SubagentEntry): void {
  trigger = document.activeElement as HTMLElement | null;
  editingId.value = agent?.id ?? null;
  editorStatus("");
  fillForm(agent);
  // 固定模型但已失效的兜底：provider/model 选择列表里补一个「已失效」项
  invalidProvider.value = agent?.model.mode === "fixed" && !providers.value.some((item) => item.id === agent.model.providerId)
    ? agent.model.providerId : "";
  invalidModel.value = agent?.model.mode === "fixed" && !selectedProviderModels.value.some((item) => item.id === agent.model.modelId)
    ? agent.model.modelId : "";
  if (!form.value.provider && providers.value.length) form.value.provider = providers.value[0]?.id ?? "";
  if (form.value.mode === "fixed" && !form.value.model && selectedProviderModels.value.length) {
    form.value.model = selectedProviderModels.value[0]?.id ?? "";
  }
  initialSnapshot.value = editorSnapshot();
  editorOpen.value = true;
  document.body.classList.add("subagent-editor-open");
  requestAnimationFrame(() => document.getElementById("subagent-name")?.focus());
}

function closeEditor(): void {
  const closedId = editingId.value;
  editorOpen.value = false;
  editingId.value = null;
  initialSnapshot.value = "";
  document.body.classList.remove("subagent-editor-open");
  editorStatus("");
  const updatedTrigger = closedId
    ? document.querySelector<HTMLElement>(`[data-subagent-id="${closedId}"] .subagent-edit-btn`)
    : null;
  const fallbackTrigger = closedId ? document.getElementById("subagent-add-btn") : trigger;
  (updatedTrigger ?? fallbackTrigger)?.focus();
  trigger = null;
}

async function requestCloseEditor(): Promise<void> {
  if (!editorOpen.value || busy.value) return;
  if (editorSnapshot() !== initialSnapshot.value) {
    const confirmed = await uiConfirm("当前配置尚未保存，确定放弃本次修改？", {
      title: "放弃修改",
      okText: "放弃修改",
      danger: true,
    });
    if (!confirmed) return;
  }
  closeEditor();
}

/** 编辑器焦点循环：Tab 在表单可聚焦元素间循环（与 h() 版同语义）。 */
function trapEditorFocus(event: KeyboardEvent): void {
  if (!editorOpen.value) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    void requestCloseEditor();
    return;
  }
  if (event.key !== "Tab") return;
  const formEl = editorForm.value;
  if (!formEl) return;
  const focusable = [...formEl.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
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

const togglingId = ref<string | null>(null);

async function toggleAgent(agent: SubagentEntry, next: boolean): Promise<void> {
  togglingId.value = agent.id;
  try {
    await store.setEnabled(agent.id, next);
    status(`${agent.name}已${next ? "启用" : "停用"}，下一条消息生效`, "ok");
  } catch (err) {
    status(`保存失败：${(err as Error).message}`, "err");
  } finally {
    togglingId.value = null;
  }
}

async function saveEditor(): Promise<void> {
  if (busy.value) return;
  const name = form.value.name.trim();
  const description = form.value.description.trim();
  if (!name) {
    editorStatus("名称不能为空", "err");
    document.getElementById("subagent-name")?.focus();
    return;
  }
  if (!description) {
    editorStatus("用途说明不能为空，主 Agent 需要据此判断何时委派", "err");
    document.getElementById("subagent-description")?.focus();
    return;
  }
  let model: SubagentSavePayload["model"] = { mode: "inherit" };
  if (form.value.mode === "fixed") {
    const providerId = form.value.provider;
    const modelId = form.value.model;
    if (!providerId || !modelId) {
      editorStatus("请选择一个有效的供应商与模型", "err");
      return;
    }
    model = { mode: "fixed", providerId, modelId };
  }
  busy.value = true;
  editorStatus("正在保存…");
  try {
    await store.save({
      name,
      description,
      enabled: form.value.enabled,
      model,
      routing: readRoutingInput(),
    }, editingId.value ?? undefined);
    status(`子代理「${name}」已保存，下一条消息生效`, "ok");
    closeEditor();
  } catch (err) {
    editorStatus(`保存失败：${(err as Error).message}`, "err");
  } finally {
    busy.value = false;
  }
}

async function deleteEditing(): Promise<void> {
  const agent = store.agents.find((item) => item.id === editingId.value);
  if (!agent || busy.value) return;
  const confirmed = await uiConfirm(
    `删除子代理「${agent.name}」？已有会话下一条消息将不再看到它。\n\n子代理的身份与模型配置会删除，不影响当前主对话。`,
    { title: "删除子代理", okText: "删除", danger: true },
  );
  if (!confirmed) return;
  busy.value = true;
  try {
    await store.remove(agent.id);
    closeEditor();
    status(`已删除子代理「${agent.name}」`, "ok");
  } catch (err) {
    editorStatus(`删除失败：${(err as Error).message}`, "err");
  } finally {
    busy.value = false;
  }
}

const invalidProvider = ref("");
const invalidModel = ref("");
</script>

<template>
  <AntdvProvider>
  <div class="subagents-head">
    <div class="subagents-heading">
      <span class="subagents-kicker"><i class="ui-icon" data-icon="Sparkles" aria-hidden="true"></i> Runtime delegation</span>
      <h2 id="subagents-title"><i class="ui-icon" data-icon="Bot" aria-hidden="true"></i> 子代理</h2>
    </div>
    <button id="subagent-add-btn" type="button" class="ui-button ui-button-primary subagent-add-btn" @click="openEditor()">
      <i class="ui-icon" data-icon="Plus" aria-hidden="true"></i> 新建子代理
    </button>
  </div>

  <section class="subagents-hero" aria-labelledby="subagents-hero-title">
    <div class="subagents-hero-copy">
      <span class="subagents-hero-tag"><i class="ui-icon" data-icon="ShieldCheck" aria-hidden="true"></i> 主 Agent 运行时授权</span>
      <h3 id="subagents-hero-title">让专项任务在独立上下文中执行</h3>
      <p>子代理只获得本次任务所需的提示词与工具，执行结果和工具轨迹回传到主会话；主 Agent 继续负责澄清、审批与最终答复。</p>
      <div class="subagents-rule-row" aria-label="子代理运行规则">
        <span><i class="ui-icon" data-icon="Bot" aria-hidden="true"></i> 身份与模型可配置</span>
        <span><i class="ui-icon" data-icon="Wrench" aria-hidden="true"></i> 工具最小授权</span>
        <span><i class="ui-icon" data-icon="Activity" aria-hidden="true"></i> 执行过程可回看</span>
      </div>
    </div>
    <div class="subagents-stats" aria-label="子代理状态概览">
      <div class="subagent-stat-card">
        <strong id="subagent-stat-total">{{ stats.total }}</strong>
        <span>全部</span>
      </div>
      <div class="subagent-stat-card is-on">
        <strong id="subagent-stat-enabled">{{ stats.enabled }}</strong>
        <span>已启用</span>
      </div>
      <div class="subagent-stat-card">
        <strong id="subagent-stat-disabled">{{ stats.disabled }}</strong>
        <span>已停用</span>
      </div>
    </div>
  </section>

  <div class="subagents-toolbar">
    <label class="subagents-search" for="subagent-search">
      <i class="ui-icon" data-icon="Search" aria-hidden="true"></i>
      <Input id="subagent-search" v-model:value="searchTerm" type="search" autocomplete="off" placeholder="搜索名称、用途或 ID" aria-label="搜索子代理" />
    </label>
    <div class="subagents-filters" role="group" aria-label="筛选子代理">
      <button
        v-for="tab in (['all', 'enabled', 'disabled'] as const)"
        :key="tab"
        type="button"
        class="subagents-filter-tab"
        :class="{ active: activeFilter === tab }"
        :data-subagent-filter="tab"
        :aria-pressed="String(activeFilter === tab)"
        @click="activeFilter = tab"
      >{{ tab === "all" ? "全部" : tab === "enabled" ? "已启用" : "已停用" }} <span :data-subagent-count="tab">{{ filterCounts[tab] }}</span></button>
    </div>
  </div>

  <div class="subagents-list-meta">
    <span id="subagents-result-count">{{ resultCount }}</span>
    <span class="subagents-list-hint"><i class="ui-icon" data-icon="Zap" aria-hidden="true"></i> 配置变更在下一条消息生效</span>
  </div>
  <div id="subagent-status" class="settings-status subagent-status-line" :class="statusKind" role="status" aria-live="polite">{{ statusText }}</div>
  <div id="subagents-list" class="subagents-list" aria-live="polite">
    <article
      v-for="agent in filteredAgents"
      :key="agent.id"
      class="subagent-card"
      :class="{ disabled: !agent.enabled, 'needs-attention': !agent.modelAvailable }"
      :data-subagent-id="agent.id"
      :aria-labelledby="`subagent-title-${agent.id}`"
    >
      <div class="subagent-card-icon" aria-hidden="true">
        <i class="ui-icon" data-icon="Bot" style="--icon-size: 20px"></i>
        <span class="subagent-card-live" :class="{ off: !agent.enabled }"></span>
      </div>
      <div class="subagent-card-main">
        <div class="subagent-card-title">
          <h3 :id="`subagent-title-${agent.id}`">{{ agent.name }}</h3>
          <span class="subagent-card-id">{{ agent.id }}</span>
          <span v-if="agent.builtIn" class="subagent-builtin">内置</span>
        </div>
        <p class="subagent-card-desc">{{ agent.description || "未填写用途说明" }}</p>
        <div class="subagent-card-meta">
          <span
            :class="`subagent-model-badge${agent.model.mode === 'fixed' ? ' fixed' : ''}${agent.modelAvailable ? '' : ' invalid'}`"
            :title="agent.modelAvailable ? modelBadgeLabel(agent) : '固定模型不可用，请配置子代理后重新选择'"
          >
            <i class="ui-icon" :data-icon="agent.model.mode === 'fixed' ? 'SlidersHorizontal' : 'Bot'" aria-hidden="true" style="--icon-size: 12px"></i>
            <span class="subagent-model-badge-text">{{ modelBadgeLabel(agent) }}</span>
          </span>
          <span class="subagent-policy-badge" title="每次委派由主 Agent 选择工具子集，且只能使用当前安全目录">
            <i class="ui-icon" data-icon="ShieldCheck" aria-hidden="true" style="--icon-size: 12px"></i> 运行时授权工具
          </span>
          <span v-if="!agent.modelAvailable" class="subagent-model-warning">
            <i class="ui-icon" data-icon="CircleAlert" aria-hidden="true" style="--icon-size: 12px"></i> 模型不可用
          </span>
        </div>
      </div>
      <div class="subagent-card-actions">
        <label class="subagent-switch" :class="{ on: agent.enabled }" :title="agent.enabled ? '停用子代理' : '启用子代理'">
          <span class="subagent-switch-copy" aria-hidden="true">
            <strong>{{ agent.enabled ? "已启用" : "已停用" }}</strong>
            <small>{{ agent.enabled ? "点击停用" : "点击启用" }}</small>
          </span>
          <span class="subagent-switch-control">
            <Switch
              :aria-label="`${agent.enabled ? '停用' : '启用'}${agent.name}`"
              :checked="agent.enabled"
              :disabled="togglingId === agent.id"
              :loading="togglingId === agent.id"
              @update:checked="(next: boolean) => toggleAgent(agent, next)"
            />
          </span>
        </label>
        <button
          type="button"
          class="subagent-edit-btn"
          :aria-label="`配置子代理 ${agent.name}`"
          :title="`配置 ${agent.name}`"
          @click="openEditor(agent)"
        >
          <i class="ui-icon" data-icon="Pencil" aria-hidden="true" style="--icon-size: 13px"></i> 配置
        </button>
      </div>
    </article>
  </div>
  <div id="subagents-empty" class="subagents-empty" :class="{ hidden: filteredAgents.length > 0 }">
    <span class="subagents-empty-icon"><i class="ui-icon" data-icon="Bot" aria-hidden="true"></i></span>
    <h3 id="subagents-empty-title">{{ store.agents.length === 0 ? "还没有可用子代理" : "没有匹配的子代理" }}</h3>
    <p id="subagents-empty-copy">{{ store.agents.length === 0
      ? "新建后，主 Agent 才能通过 delegate_agent 选择它执行专项任务。"
      : "调整搜索词或筛选条件后再试。" }}</p>
  </div>

  <div
    id="subagent-editor-mask"
    ref="editorMask"
    class="subagent-editor-mask"
    :class="{ hidden: !editorOpen }"
    @click.self="requestCloseEditor"
    @keydown="trapEditorFocus"
  >
    <form
      id="subagent-editor"
      ref="editorForm"
      class="subagent-editor"
      role="dialog"
      aria-modal="true"
      aria-labelledby="subagent-editor-title"
      aria-describedby="subagent-editor-description"
      @submit.prevent="saveEditor"
    >
      <div class="subagent-editor-head">
        <div>
          <span id="subagent-editor-eyebrow" class="subagent-editor-eyebrow">{{ editingId ? `子代理 · ${editingId}` : "子代理目录" }}</span>
          <h3 id="subagent-editor-title">{{ editingId ? "编辑子代理" : "新建子代理" }}</h3>
          <p id="subagent-editor-description" class="subagent-editor-description">定义主 Agent 可以委派的对象；工具和专项提示词不会在这里写死。</p>
        </div>
        <button id="subagent-editor-close" type="button" class="subagent-icon-btn" aria-label="关闭子代理编辑器" title="关闭" @click="requestCloseEditor">
          <i class="ui-icon" data-icon="X" aria-hidden="true"></i>
        </button>
      </div>

      <section class="subagent-form-section" aria-labelledby="subagent-identity-title">
        <div class="subagent-section-heading">
          <span>01</span>
          <div><strong id="subagent-identity-title">身份与委派边界</strong><small>名称用于识别，用途说明决定主 Agent 何时选择它。</small></div>
        </div>
        <label class="field">
          <span class="field-label">名称 <em class="key-state">60 字以内</em></span>
          <Input id="subagent-name" v-model:value="form.name" type="text" :maxlength="60" autocomplete="off" placeholder="例如：代码审查员" />
        </label>
        <label class="field">
          <span class="field-label">用途说明 <em class="key-state">写清适用与不适用场景</em></span>
          <Input.TextArea id="subagent-description" v-model:value="form.description" :rows="4" :maxlength="500" placeholder="例如：适合审查改动、定位回归风险并给出可验证的修复建议。" />
        </label>
      </section>

      <section class="subagent-form-section" aria-labelledby="subagent-model-title">
        <div class="subagent-section-heading">
          <span>02</span>
          <div><strong id="subagent-model-title">运行模型</strong><small>默认跟随主对话；固定模型适合稳定复现或成本隔离。</small></div>
        </div>
        <label class="field">
          <span class="field-label">模型策略</span>
          <Select id="subagent-model-mode" v-model:value="form.mode" :options="MODEL_MODE_OPTIONS" @change="onModeChange" />
          <small id="subagent-model-hint" class="subagent-field-hint">{{ editorModelHint }}</small>
        </label>
        <div id="subagent-model-picker" class="subagent-model-picker" :class="{ hidden: form.mode !== 'fixed' }">
          <label class="field">
            <span class="field-label">供应商</span>
            <Select id="subagent-provider" v-model:value="form.provider" :options="providerOptions" @change="form.model = selectedProviderModels[0]?.id ?? ''" />
          </label>
          <label class="field">
            <span class="field-label">模型</span>
            <Select id="subagent-model" v-model:value="form.model" :options="modelOptions" />
          </label>
        </div>
        <div class="subagent-runtime-note">
          <i class="ui-icon" data-icon="ShieldCheck" aria-hidden="true"></i>
          <div><strong>工具由主 Agent 本次授予</strong><span>只能从当前安全工具目录中选择；子代理不能递归委派，也不能直接读写长期记忆。</span></div>
        </div>
      </section>

      <section class="subagent-form-section" aria-labelledby="subagent-routing-title">
        <div class="subagent-section-heading">
          <span>03</span>
          <div><strong id="subagent-routing-title">路由名片</strong><small>决定「什么时候派给它」。关键词或类别都为空时，它不参与自动路由（只作为兜底型子代理）。</small></div>
        </div>
        <label class="field">
          <span class="field-label">关键词 <em class="key-state">逗号分隔，命中即加分</em></span>
          <Input id="subagent-routing-keywords" v-model:value="form.keywords" type="text" autocomplete="off" placeholder="例如：租房, 买房, 房源, 小区" :maxlength="600" />
        </label>
        <label class="field">
          <span class="field-label">类别 <em class="key-state">用于多意图分层归并</em></span>
          <Input id="subagent-routing-category" v-model:value="form.category" type="text" autocomplete="off" placeholder="例如：居住 / 研发 / 数据" :maxlength="20" />
        </label>
        <label class="field">
          <span class="field-label">适用场景 <em class="key-state">每行一条，最多 8 条</em></span>
          <Input.TextArea id="subagent-routing-suitable" v-model:value="form.suitable" :rows="2" :maxlength="1000" placeholder="按城市/预算/区域检索房源并给出对比结论" />
        </label>
        <label class="field">
          <span class="field-label">不适用场景 <em class="key-state">负向信号，能显著压低误派</em></span>
          <Input.TextArea id="subagent-routing-not-suitable" v-model:value="form.notSuitable" :rows="2" :maxlength="1000" placeholder="天气查询, 数学计算, 写代码" />
        </label>
        <label class="field">
          <span class="field-label">领域提示词</span>
          <Select id="subagent-routing-domain" v-model:value="form.domain" :options="ROUTING_DOMAIN_OPTIONS" />
          <small class="subagent-field-hint">只继承提示词与领域规则；工具仍由主 Agent 本次显式授予。</small>
        </label>
      </section>

      <section class="subagent-form-section is-compact" aria-labelledby="subagent-state-title">
        <div class="subagent-section-heading">
          <span>04</span>
          <div><strong id="subagent-state-title">可用状态</strong><small>停用后不会出现在主 Agent 的委派目录中。</small></div>
        </div>
        <label class="subagent-enable-row">
          <span><strong>允许主 Agent 委派此子代理</strong><small>保存或切换后，下一条消息生效。</small></span>
          <span class="subagent-switch">
            <Checkbox id="subagent-enabled" v-model:checked="form.enabled" aria-label="启用子代理" />
            <span class="subagent-switch-track" aria-hidden="true"></span>
          </span>
        </label>
      </section>

      <div id="subagent-editor-status" class="settings-status" :class="editorStatusKind" role="status" aria-live="polite">{{ editorStatusText }}</div>
      <div class="subagent-editor-actions">
        <Button id="subagent-delete-btn" size="small" danger :class="{ hidden: !editingId }" :disabled="busy" @click="deleteEditing">删除子代理</Button>
        <span class="subagent-editor-spacer"></span>
        <Button id="subagent-cancel-btn" size="small" :disabled="busy" @click="requestCloseEditor">取消</Button>
        <Button id="subagent-save-btn" type="primary" html-type="submit" :loading="busy">{{ busy ? "保存中…" : "保存配置" }}</Button>
      </div>
    </form>
  </div>
  </AntdvProvider>
</template>
