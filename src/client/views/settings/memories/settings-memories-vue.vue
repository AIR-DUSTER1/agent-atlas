<!--
  settings-memories-vue.vue — 长期记忆面板（框架迁移 M4 批次 4.2）
  ============================================================
  职责：个性化上下文、本地 / HTTP Provider 配置、连接测试、scope 列表与
  导入导出。DOM 契约与 h() 版逐 id/类名一致（mem-* / memories-* /
  memory-*，settings-page.test 的 id 清单与 e2e 依赖这些锚点）。
  立场：
  - 配置保存和连接测试使用同一份表单快照（formPatch），避免「测 A 存 B」；
  - HTTP 不可用只显示 warning，不打断聊天与其他设置；
  - API Key 输入框清空 + placeholder 显示掩码（留空 = 保持不变）。
-->
<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { useMemoriesStore, type MemoryProfile } from "../../../stores/memories.js";
import type { MemoryEntry, MemorySlotConfig } from "../../../modules/types.js";
import { memStatus } from "./settings-memories.js";
import { authFetch } from "../../../core/api.js";
import { uiConfirm } from "../../../ui/dialog.js";

const MAX_PERSONALIZATION_CHARS = 4_000;

const store = useMemoriesStore();

const saving = ref(false);
const testingHttp = ref(false);
const testingEmbedding = ref(false);
const reindexing = ref(false);
const savingPersonalization = ref(false);
const searchQuery = ref("");
const importMode = ref<"merge" | "replace">("merge");

const httpStatusText = ref("");
const httpStatusKind = ref<"ok" | "warn" | "err" | "">("");
const embeddingStatusText = ref("");
const embeddingStatusKind = ref<"ok" | "err" | "">("");
const personalizationStatusText = ref("");
const personalizationStatusKind = ref<"ok" | "err" | "">("");

/** 表单模型：与 MemorySlotConfig 对齐；API Key 字段只承载「本次输入」。 */
const form = reactive({
  activeProvider: "local" as "local" | "http",
  allowPII: false,
  personalizationEnabled: true,
  personalizationText: "",
  httpEnabled: false,
  httpPreset: "generic" as "generic" | "hindsight",
  httpAuthMode: "bearer" as "none" | "bearer",
  httpBaseURL: "",
  httpApiKey: "",
  httpClearKey: false,
  httpTimeoutMs: 8000,
  httpSearchLimit: 8,
  httpWriteEnabled: false,
  httpBankGeneral: "",
  httpBankEstate: "",
  httpBankJob: "",
  distillMode: "smart" as "off" | "confirm" | "smart",
  distillMaxPerTurn: 3,
  distillHourlyLimit: 20,
  staleGraceDays: 30,
  preferenceDays: 180,
  projectFactDays: 120,
  correctionDays: 365,
  identityDays: 365,
  retentionActive: 2000,
  retentionHistory: 5000,
  embeddingEnabled: false,
  embeddingBaseURL: "",
  embeddingModel: "",
  embeddingApiKey: "",
  embeddingClearKey: false,
  embeddingTimeoutMs: 8000,
  embeddingDimensions: 0,
  embeddingMinSimilarity: 0.25,
});

onMounted(async () => {
  try {
    await store.refreshSettings();
    fillForm(store.config);
  } catch (err) {
    memStatus(`✗ ${(err as Error).message}`, "err");
  }
});

function fillForm(config: MemorySlotConfig | null): void {
  if (!config) return;
  form.activeProvider = config.activeProvider;
  form.allowPII = config.local.allowPII;
  form.personalizationEnabled = config.personalization.enabled;
  form.personalizationText = config.personalization.text;
  form.httpEnabled = config.http.enabled;
  form.httpPreset = config.http.preset;
  form.httpAuthMode = config.http.authMode;
  form.httpBaseURL = config.http.baseURL;
  form.httpApiKey = "";
  form.httpClearKey = false;
  form.httpTimeoutMs = config.http.timeoutMs;
  form.httpSearchLimit = config.http.searchLimit;
  form.httpWriteEnabled = config.http.writeEnabled;
  form.httpBankGeneral = config.http.banks.general;
  form.httpBankEstate = config.http.banks.estate;
  form.httpBankJob = config.http.banks.job;
  form.distillMode = config.distillation.mode;
  form.distillMaxPerTurn = config.distillation.maxPerTurn;
  form.distillHourlyLimit = config.distillation.hourlyLimit;
  form.staleGraceDays = config.retention.staleGraceDays;
  form.preferenceDays = config.retention.preferenceDays;
  form.projectFactDays = config.retention.projectFactDays;
  form.correctionDays = config.retention.correctionDays;
  form.identityDays = config.retention.identityDays;
  form.retentionActive = config.retention.activePerScope;
  form.retentionHistory = config.retention.historyPerScope;
  form.embeddingEnabled = config.embedding.enabled;
  form.embeddingBaseURL = config.embedding.baseURL;
  form.embeddingModel = config.embedding.model;
  form.embeddingApiKey = "";
  form.embeddingClearKey = false;
  form.embeddingTimeoutMs = config.embedding.timeoutMs;
  form.embeddingDimensions = config.embedding.dimensions;
  form.embeddingMinSimilarity = config.embedding.minSimilarity;
}

function formPatch() {
  const apiKey = form.httpApiKey.trim();
  const embeddingKey = form.embeddingApiKey.trim();
  return {
    activeProvider: form.activeProvider,
    local: { allowPII: form.allowPII },
    http: {
      enabled: form.httpEnabled,
      preset: form.httpPreset,
      baseURL: form.httpBaseURL.trim(),
      authMode: form.httpAuthMode,
      ...(apiKey ? { apiKey } : {}),
      clearApiKey: form.httpClearKey,
      timeoutMs: Number(form.httpTimeoutMs) || 8000,
      searchLimit: Number(form.httpSearchLimit) || 8,
      writeEnabled: form.httpWriteEnabled,
      banks: {
        general: form.httpBankGeneral.trim(),
        estate: form.httpBankEstate.trim(),
        job: form.httpBankJob.trim(),
      },
    },
    distillation: {
      mode: form.distillMode,
      maxPerTurn: Number(form.distillMaxPerTurn) || 3,
      hourlyLimit: Number(form.distillHourlyLimit) || 20,
    },
    embedding: {
      enabled: form.embeddingEnabled,
      baseURL: form.embeddingBaseURL.trim(),
      model: form.embeddingModel.trim(),
      ...(embeddingKey ? { apiKey: embeddingKey } : {}),
      clearApiKey: form.embeddingClearKey,
      timeoutMs: Number(form.embeddingTimeoutMs) || 8000,
      dimensions: Number(form.embeddingDimensions) || 0,
      minSimilarity: Number(form.embeddingMinSimilarity) || 0.25,
    },
    retention: {
      activePerScope: Number(form.retentionActive) || 2000,
      historyPerScope: Number(form.retentionHistory) || 5000,
      staleGraceDays: Number(form.staleGraceDays) || 30,
      preferenceDays: Number(form.preferenceDays) || 180,
      projectFactDays: Number(form.projectFactDays) || 120,
      correctionDays: Number(form.correctionDays) || 365,
      identityDays: Number(form.identityDays) || 365,
    },
  };
}

/** 校验失败就地报错（与 h() 版同文案、同落点），返回是否可提交。 */
function validateConfigForm(): boolean {
  const patch = formPatch() as {
    activeProvider: string;
    http: { enabled: boolean; baseURL: string; preset: string; banks: { general: string; estate: string; job: string } };
    embedding: { enabled: boolean; baseURL: string; model: string };
    retention: { historyPerScope: number; activePerScope: number };
  };
  if (patch.activeProvider === "http" && !patch.http.enabled) {
    httpStatusText.value = "切换到 HTTP 前请先勾选“启用”";
    httpStatusKind.value = "err";
    return false;
  }
  if (patch.http.enabled && !patch.http.baseURL) {
    httpStatusText.value = "启用 HTTP 记忆必须填写 Base URL";
    httpStatusKind.value = "err";
    return false;
  }
  if (patch.http.enabled && patch.http.preset === "hindsight") {
    const banks = patch.http.banks;
    if (!banks.general || !banks.estate || !banks.job) {
      httpStatusText.value = "Hindsight 必须分别填写 general / estate / job bank";
      httpStatusKind.value = "err";
      return false;
    }
    if (new Set([banks.general, banks.estate, banks.job]).size !== 3) {
      httpStatusText.value = "general / estate / job bank 必须互不相同";
      httpStatusKind.value = "err";
      return false;
    }
  }
  if (patch.embedding.enabled && (!patch.embedding.baseURL || !patch.embedding.model)) {
    embeddingStatusText.value = "启用语义召回必须填写 Embedding Base URL 和模型名";
    embeddingStatusKind.value = "err";
    return false;
  }
  if (patch.retention.historyPerScope < patch.retention.activePerScope) {
    embeddingStatusText.value = "历史保留上限不能小于 active 上限";
    embeddingStatusKind.value = "err";
    return false;
  }
  return true;
}

function httpKeyPlaceholder(hasKey: boolean | undefined, masked: string | undefined): string {
  return hasKey ? `已保存 ${masked || "••••"}` : "未保存 API Key";
}

function httpKeyStateText(): string {
  const http = store.config?.http;
  if (!http) return "留空表示保持不变";
  return http.hasApiKey ? `已保存 ${http.keyMasked || "••••"}；留空保持不变` : "尚未保存；留空保持不变";
}

function embeddingKeyStateText(): string {
  const embedding = store.config?.embedding;
  if (!embedding) return "尚未保存 API Key";
  return embedding.hasApiKey
    ? `已保存 ${embedding.keyMasked || "••••"}；留空保持不变`
    : "尚未保存 Embedding API Key；留空保持不变";
}

function stateTextOf(state: string): string {
  if (state === "ok") return "正常";
  if (state === "migrated") return "已迁移";
  if (state === "missing") return "待创建";
  if (state === "corrupt") return "已隔离坏文件";
  if (state === "future") return "版本过新";
  if (state === "degraded") return "部分降级";
  return "异常";
}

const healthBadge = computed(() => {
  const health = store.status?.health;
  if (!health) return { label: "未检查", cls: "", title: "" };
  return {
    label: health.status === "ok" ? "可用" : health.status === "degraded" ? "降级" : "不可用",
    cls: health.status,
    title: health.message || `provider=${health.providerId}`,
  };
});

const localActive = computed(() => String(store.status?.localStore.activeCount ?? 0));
const localCandidates = computed(() => String(store.status?.localStore.candidateCount ?? 0));
const localHistory = computed(() => String(store.status?.localStore.historyCount ?? 0));
const localState = computed(() => {
  const status = store.status;
  if (!status) return "-";
  return status.semantic.enabled ? `${status.semantic.indexed} 条` : stateTextOf(status.localStore.state);
});

const providerDetail = computed(() => {
  const status = store.status;
  if (!status) return "正在读取记忆插槽状态…";
  const latency = typeof status.health.latencyMs === "number" ? ` · ${status.health.latencyMs}ms` : "";
  const message = status.health.message ? ` · ${status.health.message}` : "";
  const size = typeof status.localStore.bytes === "number" ? ` · ${(status.localStore.bytes / 1024).toFixed(1)}KB` : "";
  return `当前：${status.activeProvider === "http" ? "HTTP 外部记忆" : "内置本地记忆"}${latency}${message}${size}`;
});

const semanticStatus = computed(() => {
  const semantic = store.status?.semantic;
  if (!semantic) return "语义索引未启用";
  return semantic.enabled
    ? `语义索引：${semantic.model || "未命名模型"} · ${semantic.indexed} 条 · ${semantic.dimensions || "自动"} 维${semantic.message ? ` · ${semantic.message}` : ""}`
    : "语义召回未启用，当前使用零依赖词法召回";
});

function memoryProfileLabel(profile: MemoryProfile): string {
  return profile === "estate" ? "租房 Agent" : profile === "job" ? "求职 Agent" : "通用 Agent";
}

function sourceLabel(source: MemoryEntry["source"]): string {
  if (source === "agent") return "Agent 保存";
  if (source === "import") return "导入";
  return "对话内保存";
}

function entryMeta(entry: MemoryEntry): string {
  const statusLabel = entry.status === "candidate" ? " · 待确认"
    : entry.status === "stale" ? " · 已过期待确认"
      : entry.status === "superseded" ? " · 历史版本"
        : entry.status === "archived" ? " · 已归档"
          : "";
  const tags = entry.tags.length ? ` · #${entry.tags.join(" #")}` : "";
  const confidence = typeof entry.confidence === "number" && entry.confidence < 1 ? ` · 置信度 ${(entry.confidence * 100).toFixed(0)}%` : "";
  const expiry = entry.expiresAt ? ` · 到期 ${new Date(entry.expiresAt).toLocaleDateString()}` : "";
  const profile = entry.scope.profileId;
  return `${sourceLabel(entry.source)} · ${memoryProfileLabel(profile)} · 命中 ${entry.useCount ?? 0} 次${statusLabel}${confidence}${expiry}${tags} · ${new Date(entry.updatedAt).toLocaleString()}`;
}

function candidateMeta(entry: MemoryEntry): string {
  const confidence = typeof entry.confidence === "number" ? `${(entry.confidence * 100).toFixed(0)}%` : "未知";
  return `自动沉淀 · 置信度 ${confidence}${entry.category ? ` · ${entry.category}` : ""} · ${new Date(entry.updatedAt).toLocaleString()}`;
}

const visibleMemories = computed(() => {
  const query = searchQuery.value.trim().toLocaleLowerCase();
  if (!query) return store.memories;
  return store.memories.filter((entry) =>
    `${entry.key}\n${entry.content}\n${entry.tags.join(" ")}`.toLocaleLowerCase().includes(query));
});

async function reloadSettings(): Promise<void> {
  try {
    await store.refreshSettings();
    fillForm(store.config);
  } catch (err) {
    memStatus(`✗ ${(err as Error).message}`, "err");
  }
}

async function reloadEntries(): Promise<void> {
  try {
    await store.refreshEntries();
  } catch (err) {
    memStatus(`✗ ${(err as Error).message}`, "err");
  }
}

function onProfileFilterChange(): void {
  void reloadSettings();
}

function onProviderChange(): void {
  if (form.activeProvider === "http" && !form.httpEnabled) {
    httpStatusText.value = "HTTP Provider 尚未启用；勾选启用并保存后才会切换";
    httpStatusKind.value = "warn";
  }
}

async function saveConfig(): Promise<void> {
  if (!validateConfigForm()) return;
  saving.value = true;
  try {
    const result = await store.saveConfig(formPatch());
    fillForm(result.config);
    httpStatusText.value = `已保存，当前 Provider：${result.providerId}`;
    httpStatusKind.value = "ok";
  } catch (err) {
    httpStatusText.value = `✗ ${(err as Error).message}`;
    httpStatusKind.value = "err";
  } finally {
    saving.value = false;
  }
}

async function testHttp(): Promise<void> {
  if (!validateConfigForm()) return;
  testingHttp.value = true;
  httpStatusText.value = "正在连接外部记忆服务…";
  httpStatusKind.value = "";
  try {
    const result = await store.testHttp(formPatch());
    const latency = typeof result.health.latencyMs === "number" ? `，${result.health.latencyMs}ms` : "";
    const detail = result.health.message ? `：${result.health.message}` : "";
    httpStatusText.value = result.ok ? `连接成功${latency}` : `连接失败${latency}${detail}`;
    httpStatusKind.value = result.ok ? "ok" : "err";
  } catch (err) {
    httpStatusText.value = `✗ ${(err as Error).message}`;
    httpStatusKind.value = "err";
  } finally {
    testingHttp.value = false;
  }
}

async function testEmbedding(): Promise<void> {
  if (!validateConfigForm()) return;
  testingEmbedding.value = true;
  embeddingStatusText.value = "正在测试 Embedding 服务…";
  embeddingStatusKind.value = "";
  try {
    const result = await store.testEmbedding(formPatch());
    embeddingStatusText.value = `Embedding 可用：${result.model} · ${result.dimensions} 维`;
    embeddingStatusKind.value = "ok";
  } catch (err) {
    embeddingStatusText.value = `✗ ${(err as Error).message}`;
    embeddingStatusKind.value = "err";
  } finally {
    testingEmbedding.value = false;
  }
}

async function reindex(): Promise<void> {
  reindexing.value = true;
  embeddingStatusText.value = "正在重建当前 Agent 向量索引…";
  embeddingStatusKind.value = "";
  try {
    const result = await store.reindex();
    embeddingStatusText.value = `索引已重建：${result.indexed} 条 · ${result.model}`;
    embeddingStatusKind.value = "ok";
  } catch (err) {
    embeddingStatusText.value = `✗ ${(err as Error).message}`;
    embeddingStatusKind.value = "err";
  } finally {
    reindexing.value = false;
  }
}

async function savePersonalization(): Promise<void> {
  const text = form.personalizationText.trim();
  if (text.length > MAX_PERSONALIZATION_CHARS) {
    personalizationStatusText.value = "个性化上下文不能超过 4000 字";
    personalizationStatusKind.value = "err";
    return;
  }
  savingPersonalization.value = true;
  personalizationStatusText.value = "正在保存…";
  personalizationStatusKind.value = "";
  try {
    await store.savePersonalization({ enabled: form.personalizationEnabled, text });
    personalizationStatusText.value = "已保存；下一轮对话起默认注入";
    personalizationStatusKind.value = "ok";
  } catch (err) {
    personalizationStatusText.value = `✗ ${(err as Error).message}`;
    personalizationStatusKind.value = "err";
  } finally {
    savingPersonalization.value = false;
  }
}

async function removeEntry(entry: MemoryEntry): Promise<void> {
  if (!(await uiConfirm(`删除记忆「${entry.key}」？删除后无法恢复。`, { title: "删除记忆", okText: "删除", danger: true }))) return;
  try {
    await store.removeEntry(entry.id);
    memStatus("已删除", "ok");
  } catch (err) {
    memStatus(`✗ ${(err as Error).message}`, "err");
  }
}

async function confirmCandidate(entry: MemoryEntry): Promise<void> {
  try {
    await store.confirmCandidate(entry.id);
    memStatus("候选记忆已确认并生效", "ok");
  } catch (err) {
    memStatus(`✗ ${(err as Error).message}`, "err");
  }
}

async function rejectCandidate(entry: MemoryEntry): Promise<void> {
  try {
    await store.rejectCandidate(entry.id);
    memStatus("候选记忆已拒绝", "ok");
  } catch (err) {
    memStatus(`✗ ${(err as Error).message}`, "err");
  }
}

async function exportMemories(): Promise<void> {
  try {
    const profileId = store.profileFilter;
    const res = await authFetch(`/api/memories/export?profileId=${profileId}&history=1`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(data.error || `导出失败（HTTP ${res.status}）`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `memories-${profileId}-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    memStatus("本地记忆快照已导出", "ok");
  } catch (err) {
    memStatus(`✗ ${(err as Error).message}`, "err");
  }
}

async function importMemories(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  try {
    if (file.size > 1_500_000) throw new Error("导入文件过大（上限 1.5MB）");
    const snapshot = JSON.parse(await file.text());
    const mode = importMode.value;
    if (mode === "replace") {
      const confirmed = await uiConfirm(
        `替换当前「${memoryProfileLabel(store.profileFilter)}」scope 的全部本地记忆？其他 scope 不受影响。`,
        { title: "替换记忆", okText: "替换导入", danger: true },
      );
      if (!confirmed) return;
    }
    const imported = await store.importSnapshot(mode, snapshot);
    memStatus(`已导入 ${imported} 条`, "ok");
  } catch (err) {
    memStatus(`✗ ${(err as Error).message}`, "err");
  }
}
</script>

<template>
  <div class="settings-section-heading">
    <div>
      <h2 id="memories-title"><i class="ui-icon" data-icon="Brain" aria-hidden="true"></i> 记忆与个性化</h2>
    </div>
    <button id="mem-refresh-btn" type="button" class="ghost-btn small" title="刷新记忆插槽状态" @click="reloadSettings">刷新状态</button>
  </div>

  <section class="settings-card memory-personalization-card" aria-labelledby="memory-personalization-title">
    <div class="memory-card-head">
      <div>
        <h3 id="memory-personalization-title">个性化上下文</h3>
        <p>填写稳定的个人背景、协作偏好与输出要求；启用后每轮对话默认注入，不占用记忆条目；请勿填写密钥或敏感凭据</p>
      </div>
      <label class="cap-check"><input id="mem-personalization-enabled" v-model="form.personalizationEnabled" type="checkbox" /><span>默认启用</span></label>
    </div>
    <label class="field">
      <span class="field-label">默认上下文</span>
      <textarea id="mem-personalization-text" v-model="form.personalizationText" maxlength="4000" rows="5" spellcheck="false" placeholder="例如：我常驻上海，负责产品研发；回答先给结论，复杂任务分步骤说明；默认中文，方案优先保证可维护性。"></textarea>
    </label>
    <div class="settings-actions memory-personalization-actions">
      <button id="mem-personalization-save-btn" type="button" class="ghost-btn small btn-approve" :disabled="savingPersonalization" @click="savePersonalization">保存个性化上下文</button>
      <span id="mem-personalization-status" class="settings-status" :class="personalizationStatusKind" role="status" aria-live="polite">{{ personalizationStatusText }}</span>
    </div>
  </section>

  <div class="memory-provider-grid">
    <section class="settings-card memory-provider-card" aria-labelledby="memory-provider-title">
      <div class="memory-card-head">
        <div>
          <h3 id="memory-provider-title">存储提供方</h3>
          <p>当前生效的数据源与健康状态</p>
        </div>
        <span id="mem-health-badge" class="memory-health-badge" :class="healthBadge.cls" :title="healthBadge.title">{{ healthBadge.label }}</span>
      </div>
      <label class="field">
        <span class="field-label">当前 Provider</span>
        <select id="mem-active-provider" v-model="form.activeProvider" class="pf-select" @change="onProviderChange">
          <option value="local">内置本地记忆</option>
          <option value="http">HTTP 外部记忆</option>
        </select>
      </label>
      <div class="memory-stat-grid">
        <div><span>active</span><strong id="mem-local-active">{{ localActive }}</strong></div>
        <div><span>待确认</span><strong id="mem-local-candidates">{{ localCandidates }}</strong></div>
        <div><span>历史版本</span><strong id="mem-local-history">{{ localHistory }}</strong></div>
        <div><span>索引状态</span><strong id="mem-local-state">{{ localState }}</strong></div>
      </div>
      <p id="mem-provider-detail" class="settings-note">{{ providerDetail }}</p>
      <label class="cap-check memory-check">
        <input id="mem-allow-pii" v-model="form.allowPII" type="checkbox" />
        <span>允许保存明显 PII（手机号 / 身份证；密钥仍永远拒绝）</span>
      </label>
    </section>

    <section class="settings-card memory-http-card" aria-labelledby="memory-http-title">
      <div class="memory-card-head">
        <div>
          <h3 id="memory-http-title">HTTP 外部记忆</h3>
          <p>故障时自动降级为“无记忆可注入”，不阻塞聊天与 /readyz</p>
        </div>
        <label class="cap-check"><input id="mem-http-enabled" v-model="form.httpEnabled" type="checkbox" /><span>启用</span></label>
      </div>
      <fieldset id="memory-http-fields" class="memory-http-fields" :disabled="!form.httpEnabled">
        <div class="memory-form-grid">
          <label class="field">
            <span class="field-label">协议预设</span>
            <select id="mem-http-preset" v-model="form.httpPreset" class="pf-select">
              <option value="generic">Generic HTTP</option>
              <option value="hindsight">Hindsight</option>
            </select>
          </label>
          <label class="field">
            <span class="field-label">认证方式</span>
            <select id="mem-http-auth-mode" v-model="form.httpAuthMode" class="pf-select">
              <option value="bearer">Bearer Token</option>
              <option value="none">无认证</option>
            </select>
          </label>
          <label class="field memory-span-2">
            <span class="field-label">Base URL</span>
            <input id="mem-http-base-url" v-model="form.httpBaseURL" type="url" spellcheck="false" placeholder="https://memory.example.com" />
          </label>
          <label class="field memory-span-2">
            <span class="field-label">API Key <em id="mem-http-key-state" class="key-state">{{ httpKeyStateText() }}</em></span>
            <input id="mem-http-api-key" v-model="form.httpApiKey" type="password" spellcheck="false" autocomplete="new-password" :placeholder="httpKeyPlaceholder(store.config?.http.hasApiKey, store.config?.http.keyMasked)" />
          </label>
          <label class="cap-check memory-span-2"><input id="mem-http-clear-key" v-model="form.httpClearKey" type="checkbox" /><span>清除已保存的 API Key</span></label>
          <label class="field">
            <span class="field-label">超时（毫秒）</span>
            <input id="mem-http-timeout" v-model.number="form.httpTimeoutMs" type="number" min="500" max="30000" step="500" />
          </label>
          <label class="field">
            <span class="field-label">单次召回上限</span>
            <input id="mem-http-limit" v-model.number="form.httpSearchLimit" type="number" min="1" max="20" step="1" />
          </label>
        </div>
        <div id="mem-http-banks" class="memory-form-grid memory-banks" :class="{ hidden: form.httpPreset !== 'hindsight' }">
          <label class="field">
            <span class="field-label">通用 Agent Bank</span>
            <input id="mem-http-bank-general" v-model="form.httpBankGeneral" type="text" spellcheck="false" placeholder="例如 general-local" />
          </label>
          <label class="field">
            <span class="field-label">租房 Agent Bank</span>
            <input id="mem-http-bank-estate" v-model="form.httpBankEstate" type="text" spellcheck="false" placeholder="例如 estate-local" />
          </label>
          <label class="field">
            <span class="field-label">求职 Agent Bank</span>
            <input id="mem-http-bank-job" v-model="form.httpBankJob" type="text" spellcheck="false" placeholder="例如 job-local" />
          </label>
        </div>
        <label class="cap-check"><input id="mem-http-write" v-model="form.httpWriteEnabled" type="checkbox" /><span>允许 Agent 工具写入外部记忆</span></label>
      </fieldset>
      <div class="settings-actions memory-config-actions">
        <button id="mem-test-http-btn" type="button" class="ghost-btn small" :disabled="testingHttp" @click="testHttp">测试连接</button>
        <button id="mem-save-config-btn" type="button" class="ghost-btn small btn-approve" :disabled="saving" @click="saveConfig">保存并切换</button>
      </div>
      <p id="mem-http-status" class="settings-status" :class="httpStatusKind" role="status" aria-live="polite">{{ httpStatusText }}</p>
    </section>
  </div>

  <div class="memory-advanced-grid">
    <section class="settings-card" aria-labelledby="memory-distill-title">
      <div class="memory-card-head">
        <div>
          <h3 id="memory-distill-title">自动沉淀与生命周期</h3>
          <p>对话完成后提取长期记忆；高置信低风险项可自动入库，其余等待确认</p>
        </div>
      </div>
      <div class="memory-form-grid">
        <label class="field">
          <span class="field-label">沉淀模式</span>
          <select id="mem-distill-mode" v-model="form.distillMode" class="pf-select">
            <option value="off">关闭</option>
            <option value="confirm">每次确认</option>
            <option value="smart">智能沉淀</option>
          </select>
        </label>
        <label class="field">
          <span class="field-label">每轮最多候选</span>
          <input id="mem-distill-max-turn" v-model.number="form.distillMaxPerTurn" type="number" min="1" max="10" />
        </label>
        <label class="field">
          <span class="field-label">每小时上限</span>
          <input id="mem-distill-hourly" v-model.number="form.distillHourlyLimit" type="number" min="1" max="200" />
        </label>
        <label class="field">
          <span class="field-label">Stale 宽限（天）</span>
          <input id="mem-stale-grace-days" v-model.number="form.staleGraceDays" type="number" min="1" max="3650" />
        </label>
        <label class="field">
          <span class="field-label">偏好有效期（天）</span>
          <input id="mem-preference-days" v-model.number="form.preferenceDays" type="number" min="1" max="3650" />
        </label>
        <label class="field">
          <span class="field-label">项目事实有效期（天）</span>
          <input id="mem-project-days" v-model.number="form.projectFactDays" type="number" min="1" max="3650" />
        </label>
        <label class="field">
          <span class="field-label">纠错有效期（天）</span>
          <input id="mem-correction-days" v-model.number="form.correctionDays" type="number" min="1" max="3650" />
        </label>
        <label class="field">
          <span class="field-label">身份信息有效期（天）</span>
          <input id="mem-identity-days" v-model.number="form.identityDays" type="number" min="1" max="3650" />
        </label>
        <label class="field">
          <span class="field-label">每 Agent active 上限</span>
          <input id="mem-retention-active" v-model.number="form.retentionActive" type="number" min="100" max="50000" />
        </label>
        <label class="field">
          <span class="field-label">每 Agent 历史上限</span>
          <input id="mem-retention-history" v-model.number="form.retentionHistory" type="number" min="100" max="100000" />
        </label>
      </div>
    </section>

    <section class="settings-card" aria-labelledby="memory-semantic-title">
      <div class="memory-card-head">
        <div>
          <h3 id="memory-semantic-title">语义召回</h3>
          <p>OpenAI 兼容 Embedding；失败时自动降级词法召回，不阻塞聊天</p>
        </div>
        <label class="cap-check"><input id="mem-embedding-enabled" v-model="form.embeddingEnabled" type="checkbox" /><span>启用</span></label>
      </div>
      <div class="memory-form-grid">
        <label class="field memory-span-2">
          <span class="field-label">Base URL（可填 /v1 或完整 /embeddings）</span>
          <input id="mem-embedding-base-url" v-model="form.embeddingBaseURL" type="text" spellcheck="false" placeholder="https://api.example.com/v1" />
        </label>
        <label class="field">
          <span class="field-label">模型名</span>
          <input id="mem-embedding-model" v-model="form.embeddingModel" type="text" spellcheck="false" placeholder="text-embedding-3-small" />
        </label>
        <label class="field">
          <span class="field-label">API Key</span>
          <input id="mem-embedding-api-key" v-model="form.embeddingApiKey" type="password" autocomplete="off" :placeholder="httpKeyPlaceholder(store.config?.embedding.hasApiKey, store.config?.embedding.keyMasked)" />
        </label>
        <label class="field">
          <span class="field-label">超时（ms）</span>
          <input id="mem-embedding-timeout" v-model.number="form.embeddingTimeoutMs" type="number" min="500" max="30000" />
        </label>
        <label class="field">
          <span class="field-label">维度（0=自动）</span>
          <input id="mem-embedding-dimensions" v-model.number="form.embeddingDimensions" type="number" min="0" max="16384" />
        </label>
        <label class="field">
          <span class="field-label">最低相似度</span>
          <input id="mem-embedding-similarity" v-model.number="form.embeddingMinSimilarity" type="number" min="0" max="1" step="0.01" />
        </label>
        <label class="cap-check memory-span-2"><input id="mem-embedding-clear-key" v-model="form.embeddingClearKey" type="checkbox" /><span>清除已保存的 Embedding API Key</span></label>
      </div>
      <p id="mem-embedding-key-state" class="settings-note">{{ embeddingKeyStateText() }}</p>
      <p id="mem-semantic-status" class="settings-note">{{ semanticStatus }}</p>
      <div class="settings-actions memory-config-actions">
        <button id="mem-test-embedding-btn" type="button" class="ghost-btn small" :disabled="testingEmbedding" @click="testEmbedding">测试 Embedding</button>
        <button id="mem-reindex-btn" type="button" class="ghost-btn small" :disabled="reindexing" @click="reindex">重建当前 Agent 索引</button>
      </div>
      <p id="mem-embedding-status" class="settings-status" :class="embeddingStatusKind" role="status" aria-live="polite">{{ embeddingStatusText }}</p>
    </section>
  </div>

  <section class="settings-card memory-manage-card" aria-labelledby="memory-manage-title">
    <div class="memory-card-head memory-manage-head">
      <div>
        <h3 id="memory-manage-title">记忆条目管理</h3>
        <p>列表只显示当前 Agent scope；删除前会二次确认</p>
      </div>
      <div class="memory-manage-actions">
        <button id="mem-export-btn" type="button" class="ghost-btn small" @click="exportMemories">导出本地快照</button>
        <label class="ghost-btn small memory-file-btn" for="mem-import-file">导入本地快照</label>
        <select id="mem-import-mode" v-model="importMode" class="pf-select memory-import-mode" aria-label="导入模式">
          <option value="merge">合并导入</option>
          <option value="replace">替换当前 scope</option>
        </select>
        <input id="mem-import-file" class="hidden" type="file" accept="application/json,.json" @change="importMemories" />
      </div>
    </div>

    <div class="memory-filter-row">
      <label class="field">
        <span class="field-label">Agent 范围</span>
        <select id="mem-profile-filter" v-model="store.profileFilter" class="pf-select" aria-label="记忆所属 Agent 范围" @change="onProfileFilterChange">
          <option value="general">通用 Agent</option>
          <option value="estate">租房 / 房产 Agent</option>
          <option value="job">求职岗位 Agent</option>
        </select>
      </label>
      <label class="field memory-search-field">
        <span class="field-label">筛选当前列表</span>
        <input id="mem-search" v-model="searchQuery" type="search" spellcheck="false" placeholder="按主题、内容或标签筛选" />
      </label>
      <label class="cap-check memory-history-check"><input id="mem-history-toggle" v-model="store.showHistory" type="checkbox" @change="reloadEntries" /><span>显示历史版本</span></label>
    </div>

    <div class="memory-candidate-block">
      <div class="field-label">待确认的自动沉淀</div>
      <div id="mem-candidates-list" class="memories-list">
        <p v-if="!store.candidates.length" class="memories-empty">当前没有待确认的自动沉淀。</p>
        <div v-for="entry in store.candidates" :key="entry.id" class="memory-item candidate">
          <div class="m-body">
            <div class="m-key">{{ entry.key }}</div>
            <div class="m-content">{{ entry.content }}</div>
            <div class="m-meta">{{ candidateMeta(entry) }}</div>
          </div>
          <div class="memory-candidate-actions">
            <button class="p-del candidate-confirm" type="button" @click="confirmCandidate(entry)">确认</button>
            <button class="p-del candidate-reject" type="button" @click="rejectCandidate(entry)">拒绝</button>
          </div>
        </div>
      </div>
    </div>

    <div id="memories-list" class="memories-list">
      <p v-if="!visibleMemories.length" class="memories-empty">
        {{ searchQuery.trim()
          ? "没有符合筛选条件的记忆。"
          : "当前 Agent 范围还没有长期记忆。完成对话后，系统会自动提取可复用的偏好与事实。" }}
      </p>
      <template v-else>
      <div
        v-for="entry in visibleMemories"
        :key="entry.id"
        class="memory-item"
        :class="{ superseded: entry.status === 'superseded' || entry.status === 'archived', candidate: entry.status === 'candidate' }"
      >
        <div class="m-body">
          <div class="m-key">{{ entry.key }}</div>
          <div class="m-content">{{ entry.content }}</div>
          <div class="m-meta">{{ entryMeta(entry) }}</div>
        </div>
        <button class="p-del" type="button" title="删除这条记忆" @click="removeEntry(entry)">删除</button>
      </div>
      </template>
    </div>

    <div id="memories-status" class="settings-status" role="status" aria-live="polite"></div>
  </section>
</template>
