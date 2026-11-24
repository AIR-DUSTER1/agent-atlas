<!--
  models-panel-vue.vue — 模型与供应商面板（框架迁移 M4 批次 4.3）
  ============================================================
  职责：左栏供应商导航、右栏详情与模型列表、网关 chips、单模型编辑面板
  与 #settings-status。DOM 契约与静态版逐 id/类名一致
  （provider-* / pf-* / mf-* / model-row / gw-chip），模型相关 e2e 零改动。
  立场：
  - 左栏只放导航，右栏放详情 —— 首次配置时认知负担最小；
  - 每行模型自带「启用 / 编辑 / 删除」三个动作，不做二级菜单；
  - 空供应商 / 空模型时降级显示引导文案。

  antdv 接入说明：单模型编辑面板的文本/数字/JSON 输入用 Input 与 Input.TextArea，
  「获取列表 / 添加 / 保存 / 删除」等动作按钮用 Button。
  **保留原生**的三处：`#mf-vision` checkbox（行内紧凑勾选）、`#mf-dialect` 与
  `#mf-level` 两个 <select>（依赖原生 select 语义与 `.pf-select` 样式），
  以及列表行内的 `.m-pick` / `.m-edit` / `.m-del` 图标小按钮（antdv Button 的
  内边距会撑开行高）。
-->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { Button, Checkbox, Input, Modal, Select } from "antdv-next";
import { useModelsStore } from "../../../stores/settings/models/models.js";
import {
  activateModel, addModelByName, fetchGatewayModelChips, removeModel, removeProvider,
} from "./model-actions.js";
import { setSettingsStatus } from "./model-status.js";
import { PROTOCOL_LABEL } from "../../chat/composer-bar.js";
import { fmtTokens } from "../../../modules/format.js";
import type { GatewayModel, ModelEntry, ProviderEntry } from "../../../modules/types.js";
import AntdvProvider from "../../../ui/antdv-provider.vue";

const store = useModelsStore();

// 单模型编辑面板表单
const mfForm = ref({
  name: "",
  label: "",
  vision: false,
  ctx: "",
  dialect: "auto",
  level: "default",
  custom: "",
});
const savingModel = ref(false);
const newModelName = ref("");
const fetchingModels = ref(false);

const selected = computed(() => store.selectedProvider);
const modelCount = computed(() => selected.value ? `共 ${(selected.value.models || []).length} 个 · 一个供应商可添加多个模型` : "");
const models = computed<ModelEntry[]>(() => selected.value ? (selected.value.models || []) : []);

/** 已启用模型的名称集合：选择器里据此显示「已添加」，不再逐个全量扫描。 */
const configuredModelNames = computed(() => new Set(models.value.map((model) => model.name)));

/** 网关模型选择器的搜索过滤；空列表时展示加载/空态，不撑满页面。 */
const gatewayPickerModels = computed(() => {
  const query = store.gatewayPickerQuery.trim().toLowerCase();
  if (!query) return store.gatewayModels;
  return store.gatewayModels.filter((model) => model.id.toLowerCase().includes(query));
});

const dialects = computed(() => store.config?.dialects || []);
const effectiveDialect = computed(() => {
  if (mfForm.value.dialect !== "auto") return mfForm.value.dialect;
  return store.config?.reasoning?.dialect || "none";
});
const levelOptions = computed(() => {
  const d = dialects.value.find((x) => x.id === effectiveDialect.value);
  return d?.levels || [{ id: "default", label: "供应商默认", desc: "" }];
});
/** 下拉选项：antdv Select 用 options 数组（不再写 <option>）。 */
const dialectSelectOptions = computed(() => [
  { value: "auto", label: "自动识别（按网关地址 / 模型名判断）" },
  ...dialects.value.map((d) => ({ value: d.id, label: `${d.label} —— ${d.vendor}` })),
]);
const levelSelectOptions = computed(() =>
  levelOptions.value.map((lv) => ({ value: lv.id, label: lv.label })));
const dialectHint = computed(() => {
  if (mfForm.value.dialect === "auto") {
    return `当前自动识别为「${store.config?.reasoning?.dialectLabel || "—"}」`;
  }
  const d = dialects.value.find((x) => x.id === mfForm.value.dialect);
  return d ? `请求字段 ${d.field}` : "";
});
const schemeText = computed(() => {
  const d = dialects.value.find((x) => x.id === effectiveDialect.value);
  const protocol = selected.value?.protocol || "openai";
  const mismatch = d?.protocols && !d.protocols.includes(protocol);
  return (d?.scheme || "")
    + (mismatch && d?.protocols
      ? `\n⚠ 这个划分方式是为「${d.protocols.join(" / ")}」协议准备的，当前供应商用的是「${String(protocol)}」协议：档位会按近似方式换算后发送（详见 README 的思考等级章节）。`
      : "");
});
const showCustom = computed(() => effectiveDialect.value === "custom" && mfForm.value.level === "custom");

const editingModel = computed(() => store.currentEditingModel);
const editingProviderEntry = computed(() => store.currentEditingProvider);

const editingTitle = computed(() => {
  const p = editingProviderEntry.value;
  const m = editingModel.value;
  return p && m ? `${p.name} · ${m.displayName}` : "";
});

function contextSourceLabel(m: ModelEntry): string {
  return m.contextWindowSource === "manual" ? "手动"
    : m.contextWindowSource === "gateway" ? "网关" : "默认";
}

function modelDetail(m: ModelEntry): string {
  return `${m.name} · 思考等级 ${m.reasoningLabel || "供应商默认"}`
    + (m.contextWindow ? ` · 窗口 ${fmtTokens(m.contextWindow)}（${contextSourceLabel(m)}）` : "");
}

function gatewayMeta(m: GatewayModel): string {
  return [
    m.contextWindow ? `上下文 ${fmtTokens(m.contextWindow)}` : "上下文未知",
    m.supportsVision ? "多模态" : "",
    m.supportsReasoning ? "支持推理" : "",
  ].filter(Boolean).join(" · ");
}

function isModelAdded(m: GatewayModel): boolean {
  return configuredModelNames.value.has(m.id);
}

async function openGatewayPicker(): Promise<void> {
  if (!selected.value) return;
  fetchingModels.value = true;
  try {
    await fetchGatewayModelChips("detail");
    // fetchGatewayModelChips 失败时不会得到模型；只在成功拿到列表后打开，
    // 避免用户看到一个空弹窗。
    if (store.gatewayModels.length) store.openGatewayPicker("detail");
  } finally {
    fetchingModels.value = false;
  }
}

async function chooseGatewayModel(m: GatewayModel): Promise<void> {
  if (isModelAdded(m)) return;
  const ok = await addModelByName(m.id, m);
  // addModelByName 失败会落在状态条，此时保留弹窗让用户继续选择
  if (ok) store.closeGatewayPicker();
}

/** 打开编辑面板时回填（watch editingModelId，覆盖打开/关闭两种流转）。 */
watch(() => [store.modelFormOpen, store.editingModelId] as const, ([open]) => {
  if (!open) return;
  const p = editingProviderEntry.value;
  const m = editingModel.value;
  if (!p || !m) return;
  mfForm.value = {
    name: m.name,
    label: m.displayName === m.name ? "" : m.displayName,
    vision: m.modality === "vision",
    ctx: m.manualContextWindow ? String(m.manualContextWindow) : "",
    dialect: m.reasoning?.dialect || "auto",
    level: m.reasoning?.level || "default",
    custom: m.reasoning?.custom || "",
  };
  document.getElementById("mf-name")?.focus();
});

function selectProvider(provider: ProviderEntry): void {
  // 供应商连接配置在独立弹窗里；左栏始终只负责「当前查看哪个供应商」。
  if (store.providerFormOpen) store.closeProviderForm();
  store.selectProvider(provider.id);
}

async function useProvider(provider: ProviderEntry): Promise<void> {
  if (!provider.active) await activateModel(provider.id, null);
}

async function addModelFromInput(): Promise<void> {
  const name = newModelName.value;
  newModelName.value = "";
  await addModelByName(name, null);
}

async function saveModelForm(): Promise<void> {
  savingModel.value = true;
  try {
    await saveModelFormInternal();
  } finally {
    savingModel.value = false;
  }
}

async function saveModelFormInternal(): Promise<void> {
  const p = editingProviderEntry.value;
  const m = editingModel.value;
  if (!p || !m) return;
  const name = mfForm.value.name.trim();
  if (!name) {
    setSettingsStatus("✗ 模型名不能为空", "err");
    return;
  }
  try {
    const { api } = await import("../../../core/api.js");
    const { applyConfigState } = await import("../../chat/composer-bar.js");
    const { toast } = await import("../../../ui/toast.js");
    const res = await api<{ model: { reasoningLabel?: string } }>(
      `/api/config/providers/${p.id}/models/${m.id}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          label: mfForm.value.label,
          modality: mfForm.value.vision ? "vision" : "text",
          contextWindow: mfForm.value.ctx, // 空串 = 清除手动上下文
          reasoning: {
            dialect: mfForm.value.dialect,
            level: mfForm.value.level,
            custom: mfForm.value.dialect === "custom" ? mfForm.value.custom : "",
          },
        }),
      },
    );
    applyConfigState(await api<import("../../../modules/types.js").AppConfig>("/api/config"));
    // 保存后关闭编辑区：改动后的值已回显在「已配置模型」卡片上；
    // #settings-status 在 model-form-wrap 外面，关闭后仍然可见。
    store.closeModelForm();
    const summary = `已保存模型「${name}」· 思考等级 ${res.model.reasoningLabel || "默认"}`;
    setSettingsStatus(`✓ ${summary}`, "ok");
    toast(summary, "success");
  } catch (err) {
    setSettingsStatus(`✗ ${(err as Error).message}`, "err");
  }
}

async function deleteEditingModel(): Promise<void> {
  const p = editingProviderEntry.value;
  const m = editingModel.value;
  if (!p || !m) return;
  await removeModel(p.id, m.id, m.name);
}

async function activateEditingModel(): Promise<void> {
  const p = editingProviderEntry.value;
  const m = editingModel.value;
  if (!p || !m) return;
  await activateModel(p.id, m.id);
}

onMounted(() => {
  // 进入分区时同步配置并确保有选中供应商（首次进入优先「启用中」）
  store.syncConfig(null);
  store.ensureSelection();
  void import("../../../core/api.js").then(async ({ api }) => {
    try {
      store.syncConfig(await api<import("../../../modules/types.js").AppConfig>("/api/config"));
    } catch {
      /* 配置拉取失败保留旧值；applyConfigState 的常规链路也会同步 */
    }
  });
});
</script>

<template>
  <AntdvProvider>
  <div class="provider-workspace">
    <aside class="provider-picker" aria-label="供应商列表">
      <div class="provider-picker-head">
        <div><strong>供应商</strong><span id="provider-count" class="key-state">{{ store.providers.length }} 个</span></div>
        <Button id="add-provider-btn" class="provider-add-btn" title="添加供应商" aria-label="添加供应商" @click="store.openProviderForm(null)">
          <i class="ui-icon" data-icon="Plus" aria-hidden="true"></i>
        </Button>
      </div>
      <div id="provider-list" class="provider-nav-list">
        <Button v-for="p in store.providers" :key="p.id" class="provider-nav-item" :class="{ active: p.id === store.selectedProviderId, 'in-use': p.active }" :title="`${p.name}\n${p.baseURL}`" @click="selectProvider(p)">
          <span class="provider-nav-dot"></span>
          <span class="provider-nav-copy">
            <span class="provider-nav-name">{{ p.name }}</span>
            <span class="provider-nav-url">{{ p.baseURL }}</span>
          </span>
          <span class="provider-nav-count">{{ (p.models || []).length }} 模型</span>
        </Button>
      </div>
    </aside>

    <section class="provider-panel" aria-label="供应商配置与模型">
      <div id="provider-empty" class="provider-empty" :class="{ hidden: Boolean(selected) }">
        <span class="provider-empty-icon"><i class="ui-icon" data-icon="Menu" aria-hidden="true"></i></span>
        <strong>先从左侧选择供应商</strong>
        <span>选中后会显示它保存的 Key 状态、网关地址和已配置模型。</span>
      </div>

      <div v-if="selected" id="provider-detail">
        <div class="provider-detail-head">
          <div class="provider-detail-title">
            <div class="provider-detail-name-row">
              <h3 id="provider-detail-name">{{ selected.name }}</h3>
              <span id="provider-detail-active" class="provider-active-badge" :class="{ hidden: !selected.active }">启用中</span>
            </div>
            <div id="provider-detail-url" class="provider-detail-url">{{ selected.baseURL }}</div>
            <div id="provider-detail-badges" class="provider-detail-badges">
              <span class="provider-detail-badge" :class="selected.hasKey ? 'ok' : 'warn'">{{ selected.hasKey ? "✓ Key 已保存" : "无 Key" }}</span>
              <span v-if="selected.protocol !== 'openai'" class="provider-detail-badge proto">{{ PROTOCOL_LABEL[selected.protocol] || selected.protocol }}</span>
              <span class="provider-detail-badge">{{ (selected.models || []).length }} 个模型</span>
            </div>
          </div>
          <div class="provider-detail-actions">
            <Button id="provider-use-btn" class="ghost-btn small" :disabled="selected.active" @click="useProvider(selected)">{{ selected.active ? "使用中" : "启用" }}</Button>
            <Button id="provider-edit-btn" class="ghost-btn small" @click="store.openProviderForm(selected.id)">编辑连接</Button>
            <Button v-if="store.providers.length> 1"
              id="provider-delete-btn"
              type="button"
              class="ghost-btn small danger-text"
              @click="removeProvider(selected.id, selected.name)"
            >删除</Button>
          </div>
        </div>

        <div class="model-section">
          <div class="field-label model-head">
            <span>已配置模型</span>
            <em id="pf-model-count" class="key-state">{{ modelCount }}</em>
          </div>
          <div id="pf-model-list" class="model-list">
            <div v-if="!models.length" class="model-empty">还没有模型：在下面输入模型名，或点「获取列表」从网关挑选（可加多个）</div>
            <template v-else>
            <div
              v-for="m in models"
              :key="m.id"
              class="model-row"
              :class="{ active: m.active }"
            >
              <Button
                class="m-pick"
                :class="{ active: m.active }"
                :title="m.active ? '当前启用模型' : '设为该供应商的启用模型'"
                :aria-label="m.active ? `当前启用模型 ${m.displayName || m.name}` : `设为启用模型 ${m.displayName || m.name}`"
                @click="!m.active && activateModel(selected.id, m.id)"
              >
                <i class="ui-icon" :data-icon="m.active ? 'CircleCheck' : 'Circle'" aria-hidden="true"></i>
              </Button>
              <div class="m-info">
                <div class="m-name">{{ m.modality === "vision" ? "🖼 " : "" }}{{ m.displayName || m.name }}</div>
                <div class="m-detail">{{ modelDetail(m) }}</div>
              </div>
              <div class="m-actions">
                <Button class="m-edit" @click="store.openModelForm(selected.id, m.id)">编辑</Button>
                <Button class="m-del" @click="removeModel(selected.id, m.id, m.name)">删除</Button>
              </div>
            </div>
            </template>
          </div>

          <div class="key-row model-add-row">
            <Input id="pf-model-new" v-model:value="newModelName" aria-label="输入模型 ID" type="text" spellcheck="false" placeholder="输入模型名，或从网关列表选择" @keydown.enter.prevent="addModelFromInput" />
            <Button id="pf-fetch-models" size="small" :loading="fetchingModels" title="从网关拉取可用模型列表并打开选择器" @click="openGatewayPicker">
              <i class="ui-icon" data-icon="List" aria-hidden="true"></i><span>获取列表</span>
            </Button>
            <Button id="pf-model-add-btn" size="small" aria-label="添加模型" @click="addModelFromInput">
              <i class="ui-icon" data-icon="Plus" aria-hidden="true"></i><span>添加</span>
            </Button>
          </div>
        </div>

        <div v-if="store.modelFormOpen" id="model-form-wrap" class="model-form">
          <div class="field-label edit-title">正在编辑模型：<em id="mf-mode" class="key-state ok">{{ editingTitle }}</em></div>

          <label class="field">
            <span class="field-label">模型名 MODEL <em class="key-state">真正发给网关的 model 字段</em></span>
            <Input id="mf-name" v-model:value="mfForm.name" type="text" spellcheck="false" placeholder="例如 deepseek-v4-pro" @keydown.enter.prevent="saveModelForm" />
          </label>

          <label class="field">
            <span class="field-label">显示名 <em class="key-state">可选，留空则显示模型名</em></span>
            <Input id="mf-label" v-model:value="mfForm.label" type="text" spellcheck="false" placeholder="例如 V4 Pro（强推理）" @keydown.enter.prevent="saveModelForm" />
          </label>

          <label class="field">
            <span class="field-label">能力与上下文</span>
            <div class="cap-row">
              <Checkbox id="mf-vision" v-model:checked="mfForm.vision" title="勾选后可附加图片（多模态模型才支持图片输入）">多模态（支持图片输入）</Checkbox>
              <Input id="mf-ctx" v-model:value="mfForm.ctx" class="cap-ctx" type="number" :min="1024" :step="1" placeholder="上下文窗口 tokens（留空 = 自动获取，无法获取时默认 200k）" />
            </div>
          </label>

          <label class="field">
            <span class="field-label">思考等级划分方式 <em id="mf-dialect-hint" class="key-state">{{ dialectHint }}</em></span>
            <Select id="mf-dialect" v-model:value="mfForm.dialect" :options="dialectSelectOptions" />
          </label>

          <label class="field">
            <span class="field-label">思考等级 <em class="key-state">档位随「划分方式」变化 —— 每家供应商的划分并不一样</em></span>
            <Select id="mf-level" v-model:value="mfForm.level" :options="levelSelectOptions" />
          </label>

          <Input.TextArea
            id="mf-custom"
            v-model:value="mfForm.custom"
            aria-label="自定义 JSON 请求参数"
            class="reason-custom"
            :class="{ hidden: !showCustom }"
            :rows="2"
            spellcheck="false"
            placeholder='自定义 JSON，例如 {"reasoning": {"effort": "high"}}'
          />
          <p id="mf-scheme" class="reason-scheme">{{ schemeText }}</p>

          <div class="settings-actions">
            <Button id="mf-activate" @click="activateEditingModel">设为启用模型</Button>
            <div class="spacer"></div>
            <Button id="mf-delete" @click="deleteEditingModel">删除模型</Button>
            <Button id="mf-save" type="primary" :loading="savingModel" @click="saveModelForm">保存模型</Button>
          </div>
        </div>
      </div>
    </section>
  </div>
  <div id="settings-status" class="settings-status"></div>

  <!-- 网关模型选择器：独立 Modal，避免几百个模型把右侧面板推到很长。
       弹窗只负责筛选和选择，写入仍走 addModelByName 的统一写路径。 -->
  <Modal
    id="gateway-model-picker"
    :open="store.gatewayPickerContext === 'detail'"
    title="从网关选择模型"
    width="760px"
    centered
    :footer="null"
    :mask-closable="true"
    @cancel="store.closeGatewayPicker()"
  >
    <div class="gmp-head">
      <Input
        id="gmp-search"
        v-model:value="store.gatewayPickerQuery"
        aria-label="筛选网关模型"
        allow-clear
        spellcheck="false"
        placeholder="搜索模型 ID，例如 deepseek / claude / glm"
      >
        <template #prefix><i class="ui-icon" data-icon="Search" aria-hidden="true"></i></template>
      </Input>
      <span class="gmp-count">网关返回 {{ store.gatewayModels.length }} 个 · 已配置 {{ configuredModelNames.size }} 个</span>
    </div>
    <div id="gmp-list" class="gmp-list">
      <div v-if="!gatewayPickerModels.length" class="gmp-empty">
        {{ store.gatewayModels.length ? "没有匹配的模型，换个关键词试试" : "网关没有返回模型" }}
      </div>
      <Button
        v-for="m in gatewayPickerModels"
        v-else
        :key="m.id"
        class="gmp-row"
        :class="{ added: isModelAdded(m) }"
        :disabled="isModelAdded(m)"
        @click="chooseGatewayModel(m)"
      >
        <span class="gmp-row-main">
          <strong>{{ m.id }}</strong>
          <small>{{ gatewayMeta(m) }}</small>
        </span>
        <span class="gmp-row-action">{{ isModelAdded(m) ? "已添加" : "添加" }}</span>
      </Button>
    </div>
  </Modal>

  <!-- 备份与恢复分区由 settings-backup-vue 独立挂载，静态骨架保留在 models.html -->
  </AntdvProvider>
</template>
