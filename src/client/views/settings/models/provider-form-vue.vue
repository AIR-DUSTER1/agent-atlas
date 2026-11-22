<!--
  provider-form-vue.vue — 供应商连接弹窗（框架迁移 M4 批次 4.3）
  ============================================================
  职责：供应商新增/编辑表单（名称 / 网关地址 / Key / 协议 / 初始模型 /
  网关拉取）与保存。DOM 契约与静态版逐 id 一致（provider-modal-* / pf-*）。
  立场：API Key 只写不读，留空 = 保持不变；保存走 stores/models + model-actions。
-->
<script setup lang="ts">
import { Select } from "antdv-next";
import AntdvProvider from "../../../ui/antdv-provider.vue";
import { computed, onMounted, ref, watch } from "vue";
import { useModelsStore } from "../../../stores/models.js";
import { addPendingModelByName, fetchGatewayModelChips, saveProvider } from "./model-actions.js";
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

/** 网关返回模型 chips：待提交清单里已有的标记为已添加。 */
function gatewayChipLabel(m: { id: string; contextWindow: number | null; supportsVision: boolean; supportsReasoning: boolean }): string {
  const existing = store.pendingModels.some((item) => item.name === m.id);
  return (existing ? "✓ " : "＋ ") + m.id
    + (m.contextWindow ? ` · 上下文 ${m.contextWindow}` : "")
    + (m.supportsVision ? " · 🖼" : "")
    + (m.supportsReasoning ? " · ⚡" : "");
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

onMounted(() => {
  // 遮罩点击空白处关闭（mount 容器在组件模板之外，只能原生挂监听）
  const mask = document.getElementById("provider-modal-mask");
  mask?.addEventListener("click", (event) => {
    if (event.target === mask) store.closeProviderForm();
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
      <button id="provider-modal-close" type="button" class="provider-modal-close" aria-label="关闭供应商弹窗" @click="store.closeProviderForm()">×</button>
    </div>

    <div id="provider-form-wrap" class="provider-form">
      <div class="field-label edit-title">正在配置：<em id="pf-mode" class="key-state" :class="{ ok: Boolean(editingProvider) }">{{ editingProvider ? editingProvider.name : "新增供应商" }}</em></div>

      <div class="provider-form-grid">
        <label class="field">
          <span class="field-label">名称</span>
          <input id="pf-name" v-model="form.name" type="text" spellcheck="false" placeholder="例如 TokenRhythm / 本地 vLLM" @keydown.enter.prevent="onSave" />
        </label>

        <label class="field">
          <span class="field-label">网关地址 BASE_URL</span>
          <input id="pf-base-url" v-model="form.baseURL" type="text" spellcheck="false" placeholder="https://api.example.com/v1" @keydown.enter.prevent="onSave" />
        </label>
      </div>

      <label class="field">
        <span class="field-label">API Key <em id="pf-key-state" class="key-state" :class="{ ok: Boolean(editingProvider?.hasKey) }">{{ keyStateText }}</em></span>
        <div class="key-row">
          <input id="pf-api-key" v-model="form.apiKey" type="password" spellcheck="false" placeholder="编辑时留空 = 保持当前 Key 不变" @keydown.enter.prevent="onSave" />
          <button id="pf-key-toggle" type="button" class="ghost-btn small" title="显示/隐藏" aria-label="显示或隐藏 API Key" @click="toggleKeyVisible">
            <i class="ui-icon" data-icon="Eye" aria-hidden="true"></i>
          </button>
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
              <button type="button" class="pending-model-remove" @click="store.removePendingModel(m.name)">移除</button>
            </div>
          </template>
        </div>
        <div class="key-row model-add-row">
          <input id="pf-new-model-name" v-model="newModelName" aria-label="新模型 ID" type="text" spellcheck="false" placeholder="输入模型名，或从网关列表选择" @keydown="onPendingKeydown" />
          <button id="pf-new-fetch-models" type="button" class="ghost-btn small" @click="onTest">获取列表</button>
          <button id="pf-new-model-add-btn" type="button" class="ghost-btn small" @click="addPendingFromInput">＋ 添加</button>
        </div>
        <div id="pf-new-gateway-models" class="gw-models">
          <template v-if="store.gatewayModels.length">
            <div class="gw-label">网关返回 {{ store.gatewayModels.length }} 个模型（点一下直接添加）：</div>
            <div class="gw-chips">
              <button
                v-for="m in store.gatewayModels"
                :key="m.id"
                type="button"
                class="gw-chip"
                :class="{ added: store.pendingModels.some((item) => item.name === m.id) }"
                :title="`${m.id}\n上下文：${m.contextWindow ?? '未知'}\n多模态：${m.supportsVision ? '是' : '未知'} · 支持推理：${m.supportsReasoning ? '是' : '未知'}`"
                @click="addPendingModelByName(m.id, m)"
              >{{ gatewayChipLabel(m) }}</button>
            </div>
          </template>
        </div>
      </div>

      <div class="settings-actions provider-modal-actions">
        <button id="pf-test" class="ghost-btn" type="button" @click="onTest">{{ isCreate ? "测试连接 / 拉取模型" : "测试连接" }}</button>
        <div class="spacer"></div>
        <button id="pf-cancel-edit" class="ghost-btn" type="button" @click="store.closeProviderForm()">取消</button>
        <button id="pf-save" class="btn btn-approve" type="button" :disabled="saving" @click="onSave">保存供应商</button>
      </div>
      <div id="provider-modal-status" class="settings-status" role="status" aria-live="polite"></div>
    </div>
  </div>
  </AntdvProvider>
</template>
