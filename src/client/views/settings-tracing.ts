/**
 * ============================================================
 * views/settings-tracing.ts — 设置页 LangSmith 链路追踪分区
 * ============================================================
 * 职责：读写追踪开关、项目、endpoint 和掩码 Key；提交前不做静默修补，
 * 服务端会再次校验 endpoint 与 Key 语义。
 *
 * 设计立场：
 *  - 默认 off；开启必须在界面上看到数据出网警示；
 *  - Key 输入不回填明文，清空输入表示保持，勾选“清除”才移除；
 *  - 所有文本走 textContent，不拼用户可控 HTML。
 */
import { api } from "../core/api.js";
import { $ } from "../core/dom.js";
import type { TraceBackend, TraceSettingsSnapshot } from "../modules/types-api.js";

let statusTimer: ReturnType<typeof setTimeout> | undefined;

function status(message: string, kind: "ok" | "err" | "" = ""): void {
  const el = $("tracing-status");
  if (!el) return;
  el.textContent = message;
  el.className = `settings-status${kind ? ` ${kind}` : ""}`;
  clearTimeout(statusTimer);
  if (message && kind === "ok") {
    statusTimer = setTimeout(() => {
      if (el.textContent === message) status("", "");
    }, 6_000);
  }
}

function setWarning(message: string): void {
  const el = $("tracing-warning");
  if (el) el.textContent = message;
}

function currentBackend(): TraceBackend {
  return (($("tracing-backend") as HTMLSelectElement | null)?.value === "langsmith") ? "langsmith" : "off";
}

function syncSwitch(): void {
  const enabled = $("tracing-enabled") as HTMLInputElement | null;
  const label = $("tracing-enabled-label");
  if (enabled) enabled.checked = currentBackend() === "langsmith";
  if (label) label.textContent = currentBackend() === "langsmith" ? "已启用" : "已停用";
}

/** 把服务端脱敏快照填入表单。 */
export function renderTracingSettings(snapshot: TraceSettingsSnapshot): void {
  const backend = $("tracing-backend") as HTMLSelectElement | null;
  const project = $("tracing-project") as HTMLInputElement | null;
  const endpoint = $("tracing-endpoint") as HTMLInputElement | null;
  const key = $("tracing-api-key") as HTMLInputElement | null;
  const agentId = $("tracing-agent-id") as HTMLInputElement | null;
  const agentEnvironment = $("tracing-agent-environment") as HTMLInputElement | null;
  const anonymize = $("tracing-anonymize") as HTMLInputElement | null;
  const clearKey = $("tracing-clear-key") as HTMLInputElement | null;
  const keyState = $("tracing-key-state");
  if (backend) backend.value = snapshot.backend;
  if (project) project.value = snapshot.project;
  if (endpoint) endpoint.value = snapshot.endpoint;
  if (agentId) agentId.value = snapshot.agentId;
  if (agentEnvironment) agentEnvironment.value = snapshot.agentEnvironment;
  if (anonymize) anonymize.checked = snapshot.anonymize;
  if (clearKey) clearKey.checked = false;
  if (key) {
    key.value = "";
    key.disabled = false;
    key.placeholder = snapshot.hasApiKey
      ? `已配置：${snapshot.keyMasked}；留空保持不变`
      : "输入 LangSmith API Key";
  }
  if (keyState) keyState.textContent = snapshot.hasApiKey ? "已配置" : "未配置";
  syncSwitch();
  setWarning(snapshot.warning ?? (snapshot.effective
    ? "追踪已开启：每轮 Agent 的节点、工具和模型调用会异步上报。"
    : "追踪当前关闭。开启后对话内容会发送到 LangSmith，请先确认数据边界。"));
}

/** 惰性加载：只有切到链路追踪分区时才请求配置。 */
export async function refreshTracing(): Promise<void> {
  status("正在读取追踪配置…");
  try {
    renderTracingSettings(await api<TraceSettingsSnapshot>("/api/tracing"));
    status("");
  } catch (err) {
    status(`✗ ${(err as Error).message}`, "err");
    setWarning("追踪配置读取失败，请查看服务端日志后重试。");
  }
}

async function saveTracing(): Promise<void> {
  const backend = currentBackend();
  const project = ($("tracing-project") as HTMLInputElement | null)?.value.trim() ?? "";
  const endpoint = ($("tracing-endpoint") as HTMLInputElement | null)?.value.trim() ?? "";
  const keyInput = ($("tracing-api-key") as HTMLInputElement | null)?.value.trim() ?? "";
  const clearKey = ($("tracing-clear-key") as HTMLInputElement | null)?.checked === true;
  const agentId = ($("tracing-agent-id") as HTMLInputElement | null)?.value.trim() ?? "agentatlas";
  const agentEnvironment = ($("tracing-agent-environment") as HTMLInputElement | null)?.value.trim() ?? "local";
  const anonymize = ($("tracing-anonymize") as HTMLInputElement | null)?.checked !== false;
  const payload: Record<string, unknown> = { backend, project, endpoint, agentId, agentEnvironment, anonymize };
  if (clearKey) payload.apiKey = "";
  else if (keyInput) payload.apiKey = keyInput;

  const button = $("tracing-save-btn") as HTMLButtonElement | null;
  if (button) button.disabled = true;
  status("正在保存追踪配置…");
  try {
    const snapshot = await api<TraceSettingsSnapshot>("/api/tracing", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    renderTracingSettings(snapshot);
    status("✓ 追踪配置已保存，下一条消息生效", "ok");
  } catch (err) {
    status(`✗ ${(err as Error).message}`, "err");
  } finally {
    if (button) button.disabled = false;
  }
}

/** 绑定开关、表单和保存按钮；设置页打开/关闭时重复调用也不会重复绑定事件。 */
export function bindTracingSettings(): void {
  const enabled = $("tracing-enabled") as HTMLInputElement | null;
  const backend = $("tracing-backend") as HTMLSelectElement | null;
  const key = $("tracing-api-key") as HTMLInputElement | null;
  const clearKey = $("tracing-clear-key") as HTMLInputElement | null;
  if (enabled) {
    enabled.addEventListener("change", () => {
      if (backend) backend.value = enabled.checked ? "langsmith" : "off";
      syncSwitch();
      setWarning(enabled.checked
        ? "保存后开始向 LangSmith 上报；开启前请确认对话数据可以出网。"
        : "追踪当前关闭。开启后对话内容会发送到 LangSmith，请先确认数据边界。");
    });
  }
  if (backend) {
    backend.addEventListener("change", () => {
      if (enabled) enabled.checked = backend.value === "langsmith";
      syncSwitch();
      setWarning(backend.value === "langsmith"
        ? "保存后开始向 LangSmith 上报；开启前请确认对话数据可以出网。"
        : "追踪当前关闭。开启后对话内容会发送到 LangSmith，请先确认数据边界。");
    });
  }
  if (key && clearKey) {
    clearKey.addEventListener("change", () => {
      key.disabled = clearKey.checked;
      if (clearKey.checked) key.value = "";
    });
  }
  $("tracing-save-btn")?.addEventListener("click", () => { void saveTracing(); });
}