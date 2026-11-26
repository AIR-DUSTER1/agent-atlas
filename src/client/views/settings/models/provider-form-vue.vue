<!--
  provider-form-vue.vue — 供应商连接弹窗（框架迁移 M4 批次 4.3）
  ============================================================
  职责：供应商新增/编辑表单（名称 / 网关地址 / Key / 协议 / 初始模型 /
  网关拉取）与保存。DOM 契约与静态版逐 id 一致（provider-modal-* / pf-*）。
  立场：API Key 只写不读，留空 = 保持不变；保存走 stores/models + model-actions。
-->
<script setup lang="ts">
import { Button, Input, Select } from "antdv-next";
import AntdvProvider from "../../../ui/antdv-provider.vue";
import { computed, onMounted, ref, watch } from "vue";
import { useModelsStore } from "../../../stores/settings/models/models.js";
import { addPendingModelByName, fetchGatewayModelChips, saveProvider } from "./model-actions.js";
import ModelSelectionPicker from "./model-selection-picker.vue";
import type { GatewayModel } from "../../../modules/types.js";
import { setProviderModalStatus } from "./model-status.js";

const store = useModelsStore();

/** 请求协议选项：antdv Select 用 options 数组。 */
const PROTOCOL_OPTIONS = [
  { value: "openai", label: "OpenAI Chat Completions（默认 · /chat/completions）" },
  { value: "openai-responses", label: "OpenAI Responses API（/responses）" },
  { value: "anthropic", label: "Anthropic Messages 原生（/v1/messages）" },
  { value: "gemini", label: "Gemini 原生 generateContent（/v1beta）" },
];

const form = ref({ name: "", baseURL: "", apiKey: "", protocol: "openai" });
const newModelName = ref("");
const keyVisible = ref(false);
const saving = ref(false);
const testing = ref(false);
const fetchingModels = ref(false);

const editingProvider = computed(() => store.currentEditingProvider);
const isCreate = computed(() => store.providerFormMode === "create");

/** 弹窗打开时回填表单（watch providerFormOpen 而不是 onMounted：可反复开关）。 */
watch(() => store.providerFormOpen, (open) => {
  // mount 容器就是遮罩层（在组件模板之外），hidden 类由组件代管
  document.getElementById("provider-modal-mask")?.classList.toggle("hidden", !open);
  if (!open) return;
  const p = editingProvider.value;
  form.value = {
    name: p?.name ?? "",
    baseURL: p?.baseURL ?? "",
    apiKey: "",
    protocol: p?.protocol ?? "openai",
  };
  newModelName.value = "";
  keyVisible.value = false;
  setProviderModalStatus("", "");
  requestAnimationFrame(() => document.getElementById("pf-name")?.focus());
});

const keyStateText = computed(() => {
  const p = editingProvider.value;
  if (!p) return "";
  return p.hasKey ? `已保存 ${p.keyMasked || ""}，留空则不修改` : "未保存 Key";
});

const pendingEmpty = computed(() => store.pendingModels.length === 0);
const pendingSelectedNames = computed(() => store.pendingModels.map((item) => item.name));
const pendingExtraModels = computed<GatewayModel[]>(() => store.pendingModels.map((item) => ({
  id: item.name,
  contextWindow: item.contextWindow,
  supportsVision: item.modality === "vision",
  supportsReasoning: false,
})));

function closeProviderModal(): void {
  if (store.gatewayPickerContext === "pending") store.closeGatewayPicker();
  store.closeProviderForm();
}

function applyPendingSelection(selectedModels: GatewayModel[]): void {
  const wanted = new Set(selectedModels.map((model) => model.id));
  for (const current of [...store.pendingModels]) {
    if (!wanted.has(current.name)) store.removePendingModel(current.name);
  }
  const existing = new Set(store.pendingModels.map((model) => model.name));
  for (const model of selectedModels) {
    if (existing.has(model.id)) continue;
    store.addPendingModel({
      name: model.id,
      modality: model.supportsVision ? "vision" : "text",
      contextWindow: model.contextWindow ?? null,
    });
  }
  setProviderModalStatus(`✓ 已选择 ${selectedModels.length} 个初始模型，保存供应商时一起提交`, "ok");
  store.closeGatewayPicker();
}

function addPendingFromInput(): void {
  addPendingModelByName(newModelName.value, null);
  newModelName.value = "";
}

function onPendingKeydown(event: KeyboardEvent): void {
  if (event.key === "Enter") {
    event.preventDefault();
    addPendingFromInput();
  }
}

async function onSave(): Promise<void> {
  saving.value = true;
  try {
    await saveProvider(form.value);
  } finally {
    saving.value = false;
  }
}

async function onTest(): Promise<void> {
  testing.value = true;
  try {
    await fetchGatewayModelChips("pending", { baseURL: form.value.baseURL, apiKey: form.value.apiKey, protocol: form.value.protocol });
  } finally {
    testing.value = false;
  }
}

async function openPendingPicker(): Promise<void> {
  fetchingModels.value = true;
  try {
    await onTest();
    if (store.gatewayModels.length) {
      store.openGatewayPicker("pending");
    }
  } finally {
    fetchingModels.value = false;
  }
}

onMounted(() => {
  // 遮罩点击空白处关闭（mount 容器在组件模板之外，只能原生挂监听）
  const mask = document.getElementById("provider-modal-mask");
  mask?.addEventListener("click", (event) => {
      if (event.target === mask) closeProviderModal();
  });
});

function toggleKeyVisible(): void {
  keyVisible.value = !keyVisible.value;
  const input = document.getElementById("pf-api-key") as HTMLInputElement | null;
  if (input) input.type = keyVisible.value ? "text" : "password";
  const button = document.getElementById("pf-key-toggle");
  if (button) {
    button.setAttribute("aria-label", keyVisible.value ? "隐藏 API Key" : "显示或隐藏 API Key");
    button.querySelector("i.ui-icon")?.setAttribute("data-icon", keyVisible.value ? "EyeOff" : "Eye");
  }
}
</script>

<template>
  <AntdvProvider>
  <div id="provider-modal" role="dialog" aria-modal="true" aria-labelledby="provider-modal-title">
    <div class="provider-modal-head">
      <div>
        <h2 id="provider-modal-title">{{ editingProvider ? "编辑供应商" : "添加供应商" }}</h2>
        <p id="provider-modal-sub">{{ editingProvider
          ? "修改连接信息不会影响已配置模型；API Key 留空表示保持原值。"
          : "一套网关凭据可以挂多个模型。" }}</p>
      </div>
      <Button id="provider-modal-close" class="provider-modal-close" aria-label="关闭供应商弹窗" @click="closeProviderModal">×</Button>
    </div>

    <div id="provider-form-wrap" class="provider-form">
      <div class="field-label edit-title">正在配置：<em id="pf-mode" class="key-state" :class="{ ok: Boolean(editingProvider) }">{{ editingProvider ? editingProvider.name : "新增供应商" }}</em></div>

      <div class="provider-form-grid">
        <label class="field">
          <span class="field-label">名称</span>
          <Input id="pf-name" v-model:value="form.name" type="text" spellcheck="false" placeholder="例如 TokenRhythm / 本地 vLLM" @keydown.enter.prevent="onSave" />
        </label>

        <label class="field">
          <span class="field-label">网关地址 BASE_URL</span>
          <Input id="pf-base-url" v-model:value="form.baseURL" type="text" spellcheck="false" placeholder="https://api.example.com/v1" @keydown.enter.prevent="onSave" />
        </label>
      </div>

      <label class="field">
        <span class="field-label">API Key <em id="pf-key-state" class="key-state" :class="{ ok: Boolean(editingProvider?.hasKey) }">{{ keyStateText }}</em></span>
        <div class="key-row">
          <Input.Password id="pf-api-key" v-model:value="form.apiKey" spellcheck="false" placeholder="编辑时留空 = 保持当前 Key 不变" @keydown.enter.prevent="onSave" />
          <Button id="pf-key-toggle" class="ghost-btn small" title="显示/隐藏" aria-label="显示或隐藏 API Key" @click="toggleKeyVisible">
            <i class="ui-icon" data-icon="Eye" aria-hidden="true"></i>
          </Button>
        </div>
      </label>

      <label class="field">
        <span class="field-label">请求协议 <em class="key-state">中转站多协议路由时按此决定请求路径</em></span>
        <Select id="pf-protocol" v-model:value="form.protocol" :options="PROTOCOL_OPTIONS" />
      </label>

      <div id="pf-initial-models" class="pf-initial-models" :class="{ hidden: !isCreate }">
        <div class="field-label">初始模型 <em class="key-state">新增供应商至少需要一个模型，保存后仍可继续添加</em></div>
        <div id="pf-pending-model-list" class="pending-model-list">
          <div v-if="pendingEmpty" class="model-empty">还没有初始模型，请在下方输入模型名或从网关列表选择。</div>
          <template v-else>
            <div v-for="m in store.pendingModels" :key="m.name" class="pending-model-row">
              <span class="pending-model-name">{{ m.name }}</span>
              <span class="pending-model-meta">{{ [m.modality === "vision" ? "多模态" : "文本", m.contextWindow ? `窗口 ${m.contextWindow}` : ""].filter(Boolean).join(" · ") }}</span>
              <Button class="pending-model-remove" @click="store.removePendingModel(m.name)">移除</Button>
            </div>
          </template>
        </div>
        <div class="key-row model-add-row">
          <Input id="pf-new-model-name" v-model:value="newModelName" type="text" aria-label="新模型 ID" spellcheck="false" placeholder="输入模型名，或从网关列表选择" @keydown="onPendingKeydown" />
          <Button id="pf-new-fetch-models" class="ghost-btn small" :loading="fetchingModels" @click="openPendingPicker">从网关选择</Button>
          <Button id="pf-new-model-add-btn" class="ghost-btn small" aria-label="添加模型" @click="addPendingFromInput">
            <i class="ui-icon" data-icon="Plus" aria-hidden="true"></i><span>添加</span>
          </Button>
        </div>
      </div>

      <div class="settings-actions provider-modal-actions">
        <Button id="pf-test" class="ghost-btn" @click="onTest">{{ isCreate ? "测试连接 / 拉取模型" : "测试连接" }}</Button>
        <div class="spacer"></div>
        <Button id="pf-cancel-edit" class="ghost-btn" @click="closeProviderModal">取消</Button>
        <Button id="pf-save" :disabled="saving" @click="onSave" type="primary">保存供应商</Button>
      </div>
      <div id="provider-modal-status" class="settings-status" role="status" aria-live="polite"></div>
    </div>
  </div>

  <ModelSelectionPicker
    :open="store.gatewayPickerContext === 'pending'"
    title="选择初始模型"
    :models="store.gatewayModels"
    :extra-models="pendingExtraModels"
    :selected-names="pendingSelectedNames"
    modal-id="pending-model-picker"
    input-id="gmp-search-pending"
    list-id="gmp-pending-list"
    description="勾选的模型会加入初始模型清单，保存供应商时一起提交。"
    @cancel="store.closeGatewayPicker()"
    @apply="applyPendingSelection"
  />
  </AntdvProvider>
</template>
