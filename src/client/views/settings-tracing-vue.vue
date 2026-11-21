<!--
  settings-tracing-vue.vue — LangSmith 链路追踪分区（框架迁移 M4 批次 4.2；antdv 接入批次改控件）
  ============================================================
  职责：追踪开关、项目 / endpoint / Agent 标识、掩码 API Key 与脱敏开关。
  DOM 契约与 h() 版逐 id / aria-label 一致（tracing-* 全部锚点、
  routing-* 版式类），设置页 e2e 与 settings-page 单测依赖这些锚点。
  立场：
  - 默认 off；开启必须在界面上看到数据出网警示（#tracing-warning 是 live region）；
  - Key 不回填明文：留空 = 保持，勾选「清除」才移除；
  - 开关与后端下拉是同一状态的两个视图，双向同步由 computed 统一收口。

  antdv 接入说明（含两处**刻意不换**）：
  - 文本输入用 Input、Key 用 Input.Password、两个勾选用 Checkbox、
    保存用 Button、出网警示用 Alert（自带 role=alert）。
  - `#tracing-enabled` 保留原生 checkbox+role=switch：e2e 用
    `toBeChecked()` / `uncheck()` 断言，而 antdv Switch 渲染的是 <button>，
    换掉会直接废掉那条 e2e。原生 checkbox 已满足 role=switch 的可访问语义。
  - `#tracing-backend` 保留原生 <select>：e2e 用 `selectOption("langsmith")`，
    antdv Select 渲染 input[role=combobox]+浮层，换成它同样等于废掉断言。
-->
<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { Alert, Button, Checkbox, Input } from "antdv-next";
import { useTracingStore } from "../stores/tracing.js";
import type { TraceBackend } from "../modules/types-api.js";
import AntdvProvider from "../ui/antdv-provider.vue";

const store = useTracingStore();

const form = reactive({
  backend: "off" as TraceBackend,
  project: "",
  endpoint: "",
  agentId: "",
  agentEnvironment: "",
  apiKey: "",
  clearKey: false,
  anonymize: true,
});

const saving = ref(false);
const statusText = ref("");
const statusKind = ref<"ok" | "err" | "">("");
const warningText = ref("");
let statusTimer: ReturnType<typeof setTimeout> | undefined;

function status(message: string, kind: "ok" | "err" | "" = ""): void {
  statusText.value = message;
  statusKind.value = kind;
  clearTimeout(statusTimer);
  if (message && kind === "ok") {
    statusTimer = setTimeout(() => {
      if (statusText.value === message) status("", "");
    }, 6000);
  }
}

/** 开关 = 「后端是否为 langsmith」的视图，读写都走这一个来源。 */
const enabled = computed({
  get: () => form.backend === "langsmith",
  set: (value: boolean) => { form.backend = value ? "langsmith" : "off"; },
});

const keyPlaceholder = computed(() => {
  const snapshot = store.snapshot;
  if (!snapshot) return "输入 LangSmith API Key";
  return snapshot.hasApiKey
    ? `已配置：${snapshot.keyMasked}；留空保持不变`
    : "输入 LangSmith API Key";
});

const keyStateLabel = computed(() => (store.snapshot?.hasApiKey ? "已配置" : "未配置"));

/** 出网警示的类型：开启时是 warning，关闭时是 info。 */
const warningType = computed<"warning" | "info">(() => (enabled.value ? "warning" : "info"));

/** 切开关时的即时警示（不写入 config，只提示保存后生效）。 */
function warnFor(active: boolean): void {
  warningText.value = active
    ? "保存后开始向 LangSmith 上报；开启前请确认对话数据可以出网。"
    : "追踪当前关闭。开启后对话内容会发送到 LangSmith，请先确认数据边界。";
}

function fillFromSnapshot(): void {
  const snapshot = store.snapshot;
  if (!snapshot) return;
  form.backend = snapshot.backend;
  form.project = snapshot.project;
  form.endpoint = snapshot.endpoint;
  form.agentId = snapshot.agentId;
  form.agentEnvironment = snapshot.agentEnvironment;
  form.anonymize = snapshot.anonymize;
  form.apiKey = "";
  form.clearKey = false;
  warningText.value = snapshot.warning ?? (snapshot.effective
    ? "追踪已开启：每轮 Agent 的节点、工具和模型调用会异步上报。"
    : "追踪当前关闭。开启后对话内容会发送到 LangSmith，请先确认数据边界。");
}

onMounted(async () => {
  status("正在读取追踪配置…");
  try {
    await store.load();
    fillFromSnapshot();
    status("");
  } catch (err) {
    status(`✗ ${(err as Error).message}`, "err");
    warningText.value = "追踪配置读取失败，请查看服务端日志后重试。";
  }
});

/** 勾选「清除」时禁用输入框（避免两处语义冲突）。 */
function onClearKeyChange(): void {
  if (form.clearKey) form.apiKey = "";
}

async function save(): Promise<void> {
  saving.value = true;
  status("正在保存追踪配置…");
  const payload = {
    backend: form.backend,
    project: form.project.trim(),
    endpoint: form.endpoint.trim(),
    agentId: form.agentId.trim() || "agentatlas",
    agentEnvironment: form.agentEnvironment.trim() || "local",
    anonymize: form.anonymize,
    // 勾选清除 → 空串（服务端语义为删除）；否则留空表示保持。
    ...(form.clearKey ? { apiKey: "" } : form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
  };
  try {
    await store.save(payload);
    fillFromSnapshot();
    status("✓ 追踪配置已保存，下一条消息生效", "ok");
  } catch (err) {
    status(`✗ ${(err as Error).message}`, "err");
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <AntdvProvider>
    <div class="routing-head">
      <div>
        <span class="routing-kicker"><i class="ui-icon" data-icon="Activity" aria-hidden="true"></i> Observability</span>
        <h2 id="tracing-title"><i class="ui-icon" data-icon="Activity" aria-hidden="true"></i> 链路追踪</h2>
      </div>
      <!-- 原生 checkbox + role=switch：e2e 依赖 toBeChecked()/uncheck() -->
      <label class="routing-switch" title="启用 LangSmith 链路追踪">
        <input
          id="tracing-enabled"
          v-model="enabled"
          type="checkbox"
          role="switch"
          aria-label="启用 LangSmith 链路追踪"
          @change="warnFor(enabled)"
        />
        <span class="routing-switch-track" aria-hidden="true"></span>
        <span class="routing-switch-label" id="tracing-enabled-label">{{ enabled ? "已启用" : "已停用" }}</span>
      </label>
    </div>

    <div class="routing-grid">
      <section class="routing-card">
        <h3>LangSmith 配置</h3>
        <p class="routing-card-sub">开启后，每轮 Agent 的节点、工具和模型调用会异步上报到 LangSmith 云端。默认关闭，开启前请确认数据出网边界。</p>
        <label class="routing-field">
          <span>上报后端</span>
          <!-- 原生 select：e2e 用 selectOption("langsmith") 断言 -->
          <select id="tracing-backend" v-model="form.backend" aria-label="追踪后端" @change="warnFor(enabled)">
            <option value="off">关闭（默认）</option>
            <option value="langsmith">LangSmith 云端</option>
          </select>
        </label>
        <label class="routing-field">
          <span>项目名</span>
          <Input id="tracing-project" v-model:value="form.project" :maxlength="120" spellcheck="false" placeholder="agentatlas" aria-label="LangSmith 项目名" />
        </label>
        <label class="routing-field">
          <span>Endpoint</span>
          <Input id="tracing-endpoint" v-model:value="form.endpoint" type="url" :maxlength="400" spellcheck="false" placeholder="https://api.smith.langchain.com" aria-label="LangSmith Endpoint" />
        </label>
        <label class="routing-field">
          <span>Agent ID</span>
          <Input id="tracing-agent-id" v-model:value="form.agentId" :maxlength="120" spellcheck="false" placeholder="agentatlas" aria-label="LangSmith Agent ID" />
        </label>
        <label class="routing-field">
          <span>Agent 环境</span>
          <Input id="tracing-agent-environment" v-model:value="form.agentEnvironment" :maxlength="80" spellcheck="false" placeholder="local" aria-label="LangSmith Agent 环境" />
        </label>
        <label class="routing-field">
          <span>API Key <em id="tracing-key-state" class="key-state">{{ keyStateLabel }}</em></span>
          <Input.Password
            id="tracing-api-key"
            v-model:value="form.apiKey"
            autocomplete="new-password"
            :placeholder="keyPlaceholder"
            :disabled="form.clearKey"
            aria-label="LangSmith API Key"
          />
        </label>
        <label class="routing-field tracing-check-row">
          <Checkbox id="tracing-clear-key" v-model:checked="form.clearKey" aria-label="清除已保存的 LangSmith API Key" @change="onClearKeyChange">清除已保存的 API Key</Checkbox>
        </label>
      </section>

      <section class="routing-card">
        <h3>隐私与脱敏</h3>
        <p class="routing-card-sub">脱敏只作用于上报副本，不改变模型实际收到的内容、对话记录或 SSE 输出。</p>
        <label class="routing-field tracing-check-row">
          <Checkbox id="tracing-anonymize" v-model:checked="form.anonymize" aria-label="上报前脱敏敏感信息">上报前脱敏手机号、身份证、银行卡和常见凭据</Checkbox>
        </label>
        <Alert
          id="tracing-warning"
          class="settings-note tracing-warning"
          :type="warningType"
          :message="warningText"
          role="status"
          aria-live="polite"
        />
        <p class="routing-hint">开启即表示允许对话内容发送到 LangSmith。脱敏是护栏，不是数据不出网的保证；生产多租户环境建议保持关闭，或使用隔离的 LangSmith workspace。</p>
      </section>
    </div>

    <div class="routing-actions">
      <div id="tracing-status" class="settings-status" :class="statusKind" role="status" aria-live="polite">{{ statusText }}</div>
      <Button id="tracing-save-btn" type="primary" :loading="saving" @click="save">保存追踪配置</Button>
    </div>
  </AntdvProvider>
</template>
