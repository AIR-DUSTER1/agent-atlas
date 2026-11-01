/**
 * ============================================================
 * views/settings-routing.ts — 设置页「路由决策」分区
 * ============================================================
 * 职责：读写路由配置（开关 / 后端 / 阈值 / 上限），并提供试跑入口。
 * 设计立场：
 *  - 开关放在最显眼处：路由默认关闭，开启是一条明确的产品决定；
 *  - 阈值用 range + 数字回显，避免手输越界；越界校验仍在服务端做最终裁决；
 *  - 试跑是**用户主动触发**的一次真实调用，所以按钮文案与提示都要写明费用可能；
 *  - 所有文本走 textContent / h()，不拼用户可控 HTML。
 */
import { api } from "../core/api.js";
import { $ } from "../core/dom.js";
import { state } from "../core/state.js";
import { h } from "../ui/h.js";
import type {
  RoutingBackendId, RoutingSnapshot, RoutingTestResult,
} from "../modules/types.js";

let statusTimer: ReturnType<typeof setTimeout> | undefined;

function status(message: string, kind: "ok" | "err" | "" = ""): void {
  const el = $("routing-status");
  if (!el) return;
  el.textContent = message;
  el.className = `settings-status${kind ? ` ${kind}` : ""}`;
  clearTimeout(statusTimer);
  if (message && kind === "ok") {
    statusTimer = setTimeout(() => {
      if (el.textContent === message) status("", "");
    }, 6000);
  }
}

function setValue(id: string, value: number, digits = 2): void {
  const el = $(id);
  if (el) el.textContent = value.toFixed(digits);
}

function readNumber(id: string, fallback: number): number {
  const el = $(id) as HTMLInputElement | null;
  const num = Number(el?.value);
  return Number.isFinite(num) ? num : fallback;
}

function syncRangeLabels(): void {
  setValue("routing-rule-accept-value", readNumber("routing-rule-accept", 0.85));
  setValue("routing-rule-margin-value", readNumber("routing-rule-margin", 0.3));
  setValue("routing-model-confidence-value", readNumber("routing-model-confidence", 0.7));
  setValue("routing-candidate-margin-value", readNumber("routing-candidate-margin", 0.15));
}

function syncBackendFields(): void {
  const backend = ($("routing-backend") as HTMLSelectElement | null)?.value ?? "openai-compat";
  $("routing-llm-fields")?.classList.toggle("hidden", backend !== "openai-compat");
  $("routing-systemone-fields")?.classList.toggle("hidden", backend !== "systemone");
}

function option(value: string, label: string, selected = false): HTMLOptionElement {
  const el = h("option", { value }, label) as HTMLOptionElement;
  el.selected = selected;
  return el;
}

/** 供应商 / 模型下拉：与子代理设置页同一套数据源（state.config）。 */
function populateProviderOptions(selectedProviderId: string | null, selectedModelId: string | null): void {
  const providerSelect = $("routing-llm-provider") as HTMLSelectElement | null;
  const modelSelect = $("routing-llm-model") as HTMLSelectElement | null;
  if (!providerSelect || !modelSelect) return;
  const providers = state.config?.providers ?? [];
  providerSelect.replaceChildren(option("", "沿用当前模型", !selectedProviderId));
  for (const provider of providers) {
    providerSelect.appendChild(option(provider.id, provider.name, provider.id === selectedProviderId));
  }
  populateModelOptions(selectedModelId);
}

function populateModelOptions(selectedModelId: string | null): void {
  const providerSelect = $("routing-llm-provider") as HTMLSelectElement | null;
  const modelSelect = $("routing-llm-model") as HTMLSelectElement | null;
  if (!providerSelect || !modelSelect) return;
  const providerId = providerSelect.value;
  modelSelect.replaceChildren();
  if (!providerId) {
    modelSelect.appendChild(option("", "沿用当前模型", true));
    modelSelect.disabled = true;
    return;
  }
  const provider = (state.config?.providers ?? []).find((item) => item.id === providerId);
  modelSelect.disabled = false;
  modelSelect.appendChild(option("", "沿用该供应商的默认模型", !selectedModelId));
  for (const model of provider?.models ?? []) {
    modelSelect.appendChild(option(model.id, `${model.displayName} · ${model.name}`, model.id === selectedModelId));
  }
}

/** 把服务端快照填进表单。 */
export function renderRoutingSettings(snapshot: RoutingSnapshot): void {
  const settings = snapshot.settings;
  const enabled = $("routing-enabled") as HTMLInputElement | null;
  if (enabled) enabled.checked = settings.enabled;
  const label = $("routing-enabled-label");
  if (label) label.textContent = settings.enabled ? "已启用" : "已停用";

  const backend = $("routing-backend") as HTMLSelectElement | null;
  if (backend) backend.value = settings.backend satisfies RoutingBackendId;
  populateProviderOptions(settings.llm.providerId, settings.llm.modelId);

  const url = $("routing-systemone-url") as HTMLInputElement | null;
  if (url) url.value = settings.systemone.baseURL;
  const expected = $("routing-systemone-model") as HTMLInputElement | null;
  if (expected) expected.value = settings.systemone.expectedModel;
  const key = $("routing-systemone-key") as HTMLInputElement | null;
  if (key) {
    key.value = "";
    key.placeholder = snapshot.hasSystemoneKey ? "已设置，留空保持不变" : "未设置（可选）";
  }

  const ruleAccept = $("routing-rule-accept") as HTMLInputElement | null;
  if (ruleAccept) ruleAccept.value = String(settings.thresholds.ruleAutoAccept);
  const ruleMargin = $("routing-rule-margin") as HTMLInputElement | null;
  if (ruleMargin) ruleMargin.value = String(settings.thresholds.ruleMargin);
  const modelConfidence = $("routing-model-confidence") as HTMLInputElement | null;
  if (modelConfidence) modelConfidence.value = String(settings.thresholds.modelConfidence);
  const candidateMargin = $("routing-candidate-margin") as HTMLInputElement | null;
  if (candidateMargin) candidateMargin.value = String(settings.thresholds.candidateMargin);

  const handoffs = $("routing-max-handoffs") as HTMLInputElement | null;
  if (handoffs) handoffs.value = String(settings.limits.maxHandoffs);
  const hierarchical = $("routing-hierarchical-above") as HTMLInputElement | null;
  if (hierarchical) hierarchical.value = String(settings.limits.hierarchicalAbove);
  const maxIntents = $("routing-max-intents") as HTMLInputElement | null;
  if (maxIntents) maxIntents.value = String(settings.limits.maxIntents);
  const timeout = $("routing-timeout") as HTMLInputElement | null;
  if (timeout) timeout.value = String(settings.decideTimeoutMs);

  syncRangeLabels();
  syncBackendFields();
}

async function loadAndRender(): Promise<void> {
  const [snapshot, config] = await Promise.allSettled([
    api<RoutingSnapshot>("/api/routing"),
    api<import("../modules/types.js").AppConfig>("/api/config"),
  ]);
  if (config.status === "fulfilled") state.config = config.value;
  if (snapshot.status !== "fulfilled") throw snapshot.reason;
  state.routing = snapshot.value;
  renderRoutingSettings(snapshot.value);
  status("");
}

function collectPayload(): Record<string, unknown> {
  const enabled = ($("routing-enabled") as HTMLInputElement | null)?.checked ?? false;
  const backend = ($("routing-backend") as HTMLSelectElement | null)?.value ?? "openai-compat";
  const providerId = ($("routing-llm-provider") as HTMLSelectElement | null)?.value ?? "";
  const modelId = ($("routing-llm-model") as HTMLSelectElement | null)?.value ?? "";
  return {
    enabled,
    backend,
    llm: {
      providerId: providerId || null,
      modelId: modelId || null,
      temperature: 0,
      structuredOutput: true,
      maxOutputTokens: 300,
    },
    systemone: {
      baseURL: ($("routing-systemone-url") as HTMLInputElement | null)?.value.trim() ?? "",
      expectedModel: ($("routing-systemone-model") as HTMLInputElement | null)?.value.trim() ?? "",
      // 留空 = 保持不变（服务端语义）；空串清除需要用「清除」按钮另外表达。
      apiKey: ($("routing-systemone-key") as HTMLInputElement | null)?.value ?? "",
    },
    thresholds: {
      ruleAutoAccept: readNumber("routing-rule-accept", 0.85),
      ruleMargin: readNumber("routing-rule-margin", 0.3),
      vectorAccept: state.routing?.settings.thresholds.vectorAccept ?? 0.62,
      modelConfidence: readNumber("routing-model-confidence", 0.7),
      candidateMargin: readNumber("routing-candidate-margin", 0.15),
    },
    limits: {
      hierarchicalAbove: readNumber("routing-hierarchical-above", 20),
      maxIntents: readNumber("routing-max-intents", 50),
      maxCategories: state.routing?.settings.limits.maxCategories ?? 6,
      maxHandoffs: readNumber("routing-max-handoffs", 1),
      maxPlanDispatches: state.routing?.settings.limits.maxPlanDispatches ?? 8,
      maxIntentTextChars: state.routing?.settings.limits.maxIntentTextChars ?? 4_000,
    },
    decideTimeoutMs: readNumber("routing-timeout", 6_000),
  };
}

async function save(): Promise<void> {
  const button = $("routing-save-btn") as HTMLButtonElement | null;
  if (button) button.disabled = true;
  status("正在保存…");
  try {
    const snapshot = await api<RoutingSnapshot>("/api/routing", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(collectPayload()),
    });
    state.routing = snapshot;
    renderRoutingSettings(snapshot);
    status("✓ 已保存，下一条消息生效", "ok");
  } catch (err) {
    status(`✗ ${(err as Error).message}`, "err");
  } finally {
    if (button) button.disabled = false;
  }
}

function renderTestResult(result: RoutingTestResult): void {
  const box = $("routing-test-result");
  if (!box) return;
  box.replaceChildren();
  const decision = result.decision;
  const target = decision.kind === "dispatch"
    ? `派发给「${decision.agentName ?? decision.agentId ?? "未知"}」`
    : decision.kind === "ask" ? "会询问你" : "当前 Agent 处理";
  const layerLabel: Record<string, string> = {
    rule: "规则匹配", vector: "向量比对", model: "决策模型", fallback: "降级兜底",
  };
  box.appendChild(h("p", { class: "routing-test-head" },
    `${target} · 来自${layerLabel[decision.layer] ?? decision.layer} · 置信度 ${decision.confidence.toFixed(2)}`));
  box.appendChild(h("p", { class: "routing-test-reason" }, decision.reason));

  if (result.ruleScores.length) {
    const list = h("div", { class: "routing-test-scores" });
    for (const item of result.ruleScores) {
      const detail = [
        item.hits.length ? `命中：${item.hits.join("、")}` : "",
        item.negatives.length ? `负向：${item.negatives.join("、")}` : "",
      ].filter(Boolean).join("；");
      list.appendChild(h("div", { class: "routing-test-score" },
        h("span", { class: "routing-test-score-name" }, item.name),
        h("span", { class: "routing-test-score-value" }, item.score.toFixed(2)),
        detail ? h("span", { class: "routing-test-score-detail" }, detail) : null,
      ));
    }
    box.appendChild(list);
  }
  if (!result.candidateCount) {
    box.appendChild(h("p", { class: "routing-test-warn" },
      "没有可参与路由的子代理：请到「设置 → 子代理 → 配置」填写路由关键词或类别。"));
  }
}

async function runTest(): Promise<void> {
  const input = $("routing-test-input") as HTMLInputElement | null;
  const button = $("routing-test-btn") as HTMLButtonElement | null;
  const text = input?.value.trim() ?? "";
  if (!text) {
    status("请先填写一段测试文本", "err");
    input?.focus();
    return;
  }
  if (button) { button.disabled = true; button.textContent = "试跑中…"; }
  try {
    const result = await api<RoutingTestResult>("/api/routing/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    renderTestResult(result);
    status("");
  } catch (err) {
    status(`✗ ${(err as Error).message}`, "err");
  } finally {
    if (button) { button.disabled = false; button.textContent = "试跑一次"; }
  }
}

export async function refreshRouting(): Promise<void> {
  status("正在读取路由配置…");
  await loadAndRender();
}

export function bindRoutingSettings(): void {
  $("routing-save-btn")?.addEventListener("click", () => { void save(); });
  $("routing-test-btn")?.addEventListener("click", () => { void runTest(); });
  $("routing-test-input")?.addEventListener("keydown", (event) => {
    if ((event as KeyboardEvent).key === "Enter") { void runTest(); }
  });
  $("routing-backend")?.addEventListener("change", () => {
    syncBackendFields();
    status("");
  });
  $("routing-llm-provider")?.addEventListener("change", () => populateModelOptions(null));
  $("routing-enabled")?.addEventListener("change", () => {
    const enabled = ($("routing-enabled") as HTMLInputElement | null)?.checked ?? false;
    const label = $("routing-enabled-label");
    if (label) label.textContent = enabled ? "已启用" : "已停用";
  });
  for (const id of ["routing-rule-accept", "routing-rule-margin", "routing-model-confidence", "routing-candidate-margin"]) {
    $(id)?.addEventListener("input", syncRangeLabels);
  }
}
