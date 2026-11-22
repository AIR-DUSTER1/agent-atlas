<!--
  settings-routing-vue.vue — 路由决策面板（框架迁移 M4 批次 4.2）
  ============================================================
  职责：读写路由配置（开关 / 后端 / 阈值 / 上限）与试跑，全量 DOM 契约
  与 h() 版一致（routing-* id / aria-label / 状态行 / 试跑结果结构）。
  立场：
  - 阈值用 range + 数字回显（computed），避免手输越界；越界校验由服务端终审；
  - 试跑是用户主动触发的真实调用，按钮文案与提示写明费用可能；
  - provider 选项与子代理设置页同一数据源（store.config）。
-->
<script setup lang="ts">
import { Button, Input, InputNumber, Select, Slider, Switch } from "antdv-next";
import AntdvProvider from "../../../ui/antdv-provider.vue";
import { computed, onMounted, reactive, ref } from "vue";
import { useRoutingStore } from "../../../stores/settings/routing/routing.js";
import type { RoutingBackendId } from "../../../modules/types.js";

const store = useRoutingStore();

/** 表单模型：从快照填充；保存时携带快照里的只读字段（vectorAccept 等）。 */
const form = reactive({
  enabled: false,
  backend: "openai-compat" as RoutingBackendId,
  providerId: "",
  modelId: "",
  systemoneBaseURL: "",
  systemoneExpectedModel: "",
  systemoneKey: "",
  ruleAutoAccept: 0.85,
  ruleMargin: 0.3,
  modelConfidence: 0.7,
  candidateMargin: 0.15,
  maxHandoffs: 1,
  hierarchicalAbove: 20,
  maxIntents: 50,
  decideTimeoutMs: 6000,
});

const saving = ref(false);
const testing = ref(false);
const testText = ref("");
const statusText = ref("");
const statusKind = ref<"ok" | "err" | "">("");
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

function fillFromSnapshot(): void {
  const settings = store.snapshot?.settings;
  if (!settings) return;
  form.enabled = settings.enabled;
  form.backend = settings.backend;
  form.providerId = settings.llm.providerId ?? "";
  form.modelId = settings.llm.modelId ?? "";
  form.systemoneBaseURL = settings.systemone.baseURL;
  form.systemoneExpectedModel = settings.systemone.expectedModel;
  form.systemoneKey = "";
  form.ruleAutoAccept = settings.thresholds.ruleAutoAccept;
  form.ruleMargin = settings.thresholds.ruleMargin;
  form.modelConfidence = settings.thresholds.modelConfidence;
  form.candidateMargin = settings.thresholds.candidateMargin;
  form.maxHandoffs = settings.limits.maxHandoffs;
  form.hierarchicalAbove = settings.limits.hierarchicalAbove;
  form.maxIntents = settings.limits.maxIntents;
  form.decideTimeoutMs = settings.decideTimeoutMs;
}

onMounted(async () => {
  status("正在读取路由配置…");
  try {
    await store.load();
    fillFromSnapshot();
    status("");
  } catch (err) {
    status(`✗ ${(err as Error).message}`, "err");
  }
});

const providers = computed(() => store.config?.providers ?? []);
const selectedProvider = computed(() => providers.value.find((item) => item.id === form.providerId));
const modelOptions = computed(() => selectedProvider.value?.models ?? []);

/** 下拉选项：antdv Select 用 options 数组；空值项表达「沿用当前」语义。 */
const BACKEND_OPTIONS = [
  { value: "openai-compat", label: "API 模型（推荐，本机零占用）" },
  { value: "systemone", label: "systemone 决策服务（数据不出本机）" },
  { value: "rules-only", label: "纯规则（完全不调模型）" },
];
const providerOptions = computed(() => [
  { value: "", label: "沿用当前模型" },
  ...providers.value.map((provider) => ({ value: provider.id, label: provider.name })),
]);
const routingModelOptions = computed(() => [
  { value: "", label: form.providerId ? "沿用该供应商的默认模型" : "沿用当前模型" },
  ...modelOptions.value.map((model) => ({ value: model.id, label: `${model.displayName} · ${model.name}` })),
]);
const systemoneKeyPlaceholder = computed(() =>
  store.snapshot?.hasSystemoneKey ? "已设置，留空保持不变" : "未设置（可选）");

const rangeValues = computed(() => ({
  ruleAutoAccept: form.ruleAutoAccept.toFixed(2),
  ruleMargin: form.ruleMargin.toFixed(2),
  modelConfidence: form.modelConfidence.toFixed(2),
  candidateMargin: form.candidateMargin.toFixed(2),
}));

/** 试跑结果派发目标文案（与 h() 版一致）。 */
const testTarget = computed(() => {
  const decision = store.testResult?.decision;
  if (!decision) return "";
  if (decision.kind === "dispatch") {
    return `派发给「${decision.agentName ?? decision.agentId ?? "未知"}」`;
  }
  return decision.kind === "ask" ? "会询问你" : "当前 Agent 处理";
});

const testLayerLabel = computed(() => {
  const labels: Record<string, string> = {
    rule: "规则匹配", vector: "向量比对", model: "决策模型", fallback: "降级兜底",
  };
  const decision = store.testResult?.decision;
  if (!decision) return "";
  return labels[decision.layer] ?? decision.layer;
});

const testScores = computed(() => (store.testResult?.ruleScores ?? []).map((item) => ({
  ...item,
  scoreText: item.score.toFixed(2),
  detail: [
    item.hits.length ? `命中：${item.hits.join("、")}` : "",
    item.negatives.length ? `负向：${item.negatives.join("、")}` : "",
  ].filter(Boolean).join("；"),
})));

async function save(): Promise<void> {
  saving.value = true;
  status("正在保存…");
  try {
    const snapshot = store.snapshot;
    await store.save({
      enabled: form.enabled,
      backend: form.backend,
      llm: {
        providerId: form.providerId || null,
        modelId: form.modelId || null,
        temperature: 0,
        structuredOutput: true,
        maxOutputTokens: 300,
      },
      systemone: {
        baseURL: form.systemoneBaseURL.trim(),
        expectedModel: form.systemoneExpectedModel.trim(),
        // 留空 = 保持不变（服务端语义）；空串清除需要用「清除」按钮另外表达。
        apiKey: form.systemoneKey,
      },
      thresholds: {
        ruleAutoAccept: form.ruleAutoAccept,
        ruleMargin: form.ruleMargin,
        vectorAccept: snapshot?.settings.thresholds.vectorAccept ?? 0.62,
        modelConfidence: form.modelConfidence,
        candidateMargin: form.candidateMargin,
      },
      limits: {
        hierarchicalAbove: form.hierarchicalAbove,
        maxIntents: form.maxIntents,
        maxCategories: snapshot?.settings.limits.maxCategories ?? 6,
        maxHandoffs: form.maxHandoffs,
        maxPlanDispatches: snapshot?.settings.limits.maxPlanDispatches ?? 8,
        maxIntentTextChars: snapshot?.settings.limits.maxIntentTextChars ?? 4_000,
      },
      decideTimeoutMs: form.decideTimeoutMs,
    });
    fillFromSnapshot();
    status("✓ 已保存，下一条消息生效", "ok");
  } catch (err) {
    status(`✗ ${(err as Error).message}`, "err");
  } finally {
    saving.value = false;
  }
}

async function runTest(): Promise<void> {
  const text = testText.value.trim();
  if (!text) {
    status("请先填写一段测试文本", "err");
    document.getElementById("routing-test-input")?.focus();
    return;
  }
  testing.value = true;
  try {
    await store.runTest(text);
    status("");
  } catch (err) {
    status(`✗ ${(err as Error).message}`, "err");
  } finally {
    testing.value = false;
  }
}
</script>

<template>
  <AntdvProvider>
  <div class="routing-head">
    <div>
      <span class="routing-kicker"><i class="ui-icon" data-icon="Waypoints" aria-hidden="true"></i> Agent routing</span>
      <h2 id="routing-title"><i class="ui-icon" data-icon="Waypoints" aria-hidden="true"></i> 路由决策</h2>
    </div>
    <!-- antdv Switch 自带轨道，不需要旧的 .routing-switch-track 自绘层 -->
    <span class="routing-switch" title="启用路由决策">
      <Switch id="routing-enabled" v-model:checked="form.enabled" aria-label="启用路由决策" />
      <span class="routing-switch-label" id="routing-enabled-label">{{ form.enabled ? "已启用" : "已停用" }}</span>
    </span>
  </div>

  <div class="routing-grid">
    <section class="routing-card">
      <h3>决策后端</h3>
      <p class="routing-card-sub">三层里只有第三层需要模型。默认复用你已配置的「供应商 × 模型」，本机零内存占用。</p>
      <label class="routing-field">
        <span>后端</span>
        <Select id="routing-backend" v-model:value="form.backend" :options="BACKEND_OPTIONS" aria-label="决策后端" />
      </label>
      <div v-if="form.backend === 'openai-compat'" id="routing-llm-fields">
        <label class="routing-field">
          <span>路由供应商</span>
          <Select id="routing-llm-provider" v-model:value="form.providerId" :options="providerOptions" aria-label="路由供应商" />
        </label>
        <label class="routing-field">
          <span>路由模型</span>
          <Select id="routing-llm-model" v-model:value="form.modelId" :options="routingModelOptions" aria-label="路由模型" :disabled="!form.providerId" />
        </label>
        <p class="routing-hint">两者都选「沿用当前模型」时，使用聊天当前启用的供应商与模型。</p>
      </div>
      <div v-if="form.backend === 'systemone'" id="routing-systemone-fields">
        <label class="routing-field">
          <span>决策服务地址</span>
          <Input id="routing-systemone-url" v-model:value="form.systemoneBaseURL" type="url" placeholder="http://127.0.0.1:8765" aria-label="决策服务地址" />
        </label>
        <label class="routing-field">
          <span>期望模型名</span>
          <Input id="routing-systemone-model" v-model:value="form.systemoneExpectedModel" type="text" placeholder="可选：校验服务跑的是哪个模型" aria-label="期望模型名" />
        </label>
        <label class="routing-field">
          <span>访问 Key</span>
          <Input.Password id="routing-systemone-key" v-model:value="form.systemoneKey" autocomplete="off" :placeholder="systemoneKeyPlaceholder" aria-label="决策服务访问 Key" />
        </label>
      </div>
    </section>

    <section class="routing-card">
      <h3>阈值</h3>
      <p class="routing-card-sub">分数低于阈值、或两个候选太接近时，会转成一张选项卡问你，而不是猜。</p>
      <label class="routing-field">
        <span>规则直接派发 <b id="routing-rule-accept-value">{{ rangeValues.ruleAutoAccept }}</b></span>
        <Slider id="routing-rule-accept" v-model:value="form.ruleAutoAccept" :min="0.5" :max="1" :step="0.01" aria-label="规则自动派发阈值" />
      </label>
      <label class="routing-field">
        <span>规则领先幅度 <b id="routing-rule-margin-value">{{ rangeValues.ruleMargin }}</b></span>
        <Slider id="routing-rule-margin" v-model:value="form.ruleMargin" :min="0" :max="0.8" :step="0.01" aria-label="规则分差阈值" />
      </label>
      <label class="routing-field">
        <span>模型置信度 <b id="routing-model-confidence-value">{{ rangeValues.modelConfidence }}</b></span>
        <Slider id="routing-model-confidence" v-model:value="form.modelConfidence" :min="0" :max="1" :step="0.01" aria-label="模型置信度阈值" />
      </label>
      <label class="routing-field">
        <span>候选分差 <b id="routing-candidate-margin-value">{{ rangeValues.candidateMargin }}</b></span>
        <Slider id="routing-candidate-margin" v-model:value="form.candidateMargin" :min="0" :max="0.8" :step="0.01" aria-label="候选分差阈值" />
      </label>
    </section>

    <section class="routing-card">
      <h3>上限</h3>
      <p class="routing-card-sub">批量请求与转回都需要硬边界，避免一次消息触发几十次模型调用。</p>
      <label class="routing-field">
        <span>转回次数上限</span>
        <InputNumber id="routing-max-handoffs" v-model:value="form.maxHandoffs" :min="0" :max="3" :step="1" aria-label="最大转回次数" />
      </label>
      <label class="routing-field">
        <span>分层触发意图数</span>
        <InputNumber id="routing-hierarchical-above" v-model:value="form.hierarchicalAbove" :min="1" :max="200" :step="1" aria-label="分层触发意图数" />
      </label>
      <label class="routing-field">
        <span>意图数上限</span>
        <InputNumber id="routing-max-intents" v-model:value="form.maxIntents" :min="5" :max="200" :step="1" aria-label="意图上限" />
      </label>
      <label class="routing-field">
        <span>决策超时（毫秒）</span>
        <InputNumber id="routing-timeout" v-model:value="form.decideTimeoutMs" :min="500" :max="120000" :step="100" aria-label="决策超时" />
      </label>
    </section>
  </div>

  <section class="routing-card routing-test-card">
    <h3>试跑</h3>
    <p class="routing-card-sub">用一段样例请求看它会派给谁。注意：选了 API 后端时会真的调用一次模型（可能有少量费用）。</p>
    <div class="routing-test-row">
      <Input id="routing-test-input" v-model:value="testText" type="text" placeholder="例如：帮我找北京朝阳区两居室，预算 6000" aria-label="路由测试文本" @keydown.enter="runTest" />
      <Button id="routing-test-btn" class="ui-button" :disabled="testing" @click="runTest">{{ testing ? "试跑中…" : "试跑一次" }}</Button>
    </div>
    <div id="routing-test-result" class="routing-test-result" role="status" aria-live="polite">
      <template v-if="store.testResult">
        <p class="routing-test-head">{{ testTarget }} · 来自{{ testLayerLabel }} · 置信度 {{ store.testResult.decision.confidence.toFixed(2) }}</p>
        <p class="routing-test-reason">{{ store.testResult.decision.reason }}</p>
        <div v-if="testScores.length" class="routing-test-scores">
          <div v-for="item in testScores" :key="item.agentId" class="routing-test-score">
            <span class="routing-test-score-name">{{ item.name }}</span>
            <span class="routing-test-score-value">{{ item.scoreText }}</span>
            <span v-if="item.detail" class="routing-test-score-detail">{{ item.detail }}</span>
          </div>
        </div>
        <p v-if="!store.testResult.candidateCount" class="routing-test-warn">
          没有可参与路由的子代理：请到「设置 → 子代理 → 配置」填写路由关键词或类别。
        </p>
      </template>
    </div>
  </section>

  <div class="routing-actions">
    <div id="routing-status" class="settings-status" :class="statusKind" role="status" aria-live="polite">{{ statusText }}</div>
    <Button id="routing-save-btn" :disabled="saving" @click="save" type="primary">保存路由配置</Button>
  </div>
  </AntdvProvider>
</template>
