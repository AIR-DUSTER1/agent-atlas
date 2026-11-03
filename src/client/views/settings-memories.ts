/**
 * ============================================================
 * views/settings-memories.ts — 长期记忆插槽设置与条目管理
 * ============================================================
 * 职责：本地 / HTTP Provider 配置、连接测试、状态展示、scope 列表、导入导出。
 * 设计立场：
 *  - 所有动态正文用 textContent，配置 URL / bank / Key 不拼进 innerHTML；
 *  - 配置保存和连接测试使用同一份表单快照，避免“测 A 存 B”；
 *  - HTTP 不可用只显示 warning，不打断聊天与其他设置。
 */
import { $ } from "../core/dom.js";
import { api, authFetch } from "../core/api.js";
import { uiConfirm } from "../ui/dialog.js";
import { clearFieldError, setFieldError } from "../ui/field.js";
import type {
  MemoryEntry,
  MemoryProviderHealth,
  MemorySlotConfig,
  MemorySlotStatus,
} from "../modules/types.js";

let memStatusTimer: ReturnType<typeof setTimeout> | undefined;
let allMemories: MemoryEntry[] = [];
let allCandidates: MemoryEntry[] = [];
let currentConfig: MemorySlotConfig | null = null;

function currentMemoryProfile(): "general" | "estate" | "job" {
  const select = $("mem-profile-filter") as HTMLSelectElement | null;
  if (select?.value === "estate") return "estate";
  if (select?.value === "job") return "job";
  return "general";
}

/** 记忆 scope 的中文名：三个 Agent 各自隔离，文案也要能区分。 */
function memoryProfileLabel(profile: "general" | "estate" | "job"): string {
  return profile === "estate" ? "租房 Agent" : profile === "job" ? "求职 Agent" : "通用 Agent";
}

function input(id: string): HTMLInputElement | null {
  return $(id) as HTMLInputElement | null;
}

function select(id: string): HTMLSelectElement | null {
  return $(id) as HTMLSelectElement | null;
}

function stateText(state: string): string {
  if (state === "ok") return "正常";
  if (state === "migrated") return "已迁移";
  if (state === "missing") return "待创建";
  if (state === "corrupt") return "已隔离坏文件";
  if (state === "future") return "版本过新";
  if (state === "degraded") return "部分降级";
  return "异常";
}

export function memStatus(text: string, cls: string): void {
  const el = $("memories-status");
  if (!el) return;
  el.textContent = text;
  el.className = "settings-status" + (cls ? " " + cls : "");
  clearTimeout(memStatusTimer);
  if (text) {
    memStatusTimer = setTimeout(() => {
      if (el.textContent === text) { el.textContent = ""; el.className = "settings-status"; }
    }, 5000);
  }
}

function setHttpStatus(text: string, kind: "ok" | "warn" | "err" | "" = ""): void {
  const el = $("mem-http-status");
  if (!el) return;
  el.textContent = text;
  el.className = "settings-status" + (kind ? " " + kind : "");
}

function setHealthBadge(health: MemoryProviderHealth): void {
  const badge = $("mem-health-badge");
  if (!badge) return;
  const label = health.status === "ok" ? "可用" : health.status === "degraded" ? "降级" : "不可用";
  badge.textContent = label;
  badge.className = `memory-health-badge ${health.status}`;
  badge.title = health.message || `provider=${health.providerId}`;
}

function renderStatus(status: MemorySlotStatus): void {
  setHealthBadge(status.health);
  const active = $("mem-local-active");
  const candidates = $("mem-local-candidates");
  const history = $("mem-local-history");
  const state = $("mem-local-state");
  if (active) active.textContent = String(status.localStore.activeCount);
  if (candidates) candidates.textContent = String(status.localStore.candidateCount);
  if (history) history.textContent = String(status.localStore.historyCount);
  if (state) state.textContent = status.semantic.enabled
    ? `${status.semantic.indexed} 条`
    : stateText(status.localStore.state);
  const detail = $("mem-provider-detail");
  if (detail) {
    const latency = typeof status.health.latencyMs === "number" ? ` · ${status.health.latencyMs}ms` : "";
    const message = status.health.message ? ` · ${status.health.message}` : "";
    const size = typeof status.localStore.bytes === "number" ? ` · ${(status.localStore.bytes / 1024).toFixed(1)}KB` : "";
    detail.textContent = `当前：${status.activeProvider === "http" ? "HTTP 外部记忆" : "内置本地记忆"}${latency}${message}${size}`;
  }
  const semantic = $("mem-semantic-status");
  if (semantic) {
    semantic.textContent = status.semantic.enabled
      ? `语义索引：${status.semantic.model || "未命名模型"} · ${status.semantic.indexed} 条 · ${status.semantic.dimensions || "自动"} 维${status.semantic.message ? ` · ${status.semantic.message}` : ""}`
      : "语义召回未启用，当前使用零依赖词法召回";
  }
}

function applyConfig(config: MemorySlotConfig): void {
  currentConfig = config;
  const active = select("mem-active-provider");
  if (active) active.value = config.activeProvider;
  const allowPii = input("mem-allow-pii");
  if (allowPii) allowPii.checked = config.local.allowPII;

  const enabled = input("mem-http-enabled");
  if (enabled) enabled.checked = config.http.enabled;
  const preset = select("mem-http-preset");
  if (preset) preset.value = config.http.preset;
  const authMode = select("mem-http-auth-mode");
  if (authMode) authMode.value = config.http.authMode;
  const baseURL = input("mem-http-base-url");
  if (baseURL) baseURL.value = config.http.baseURL;
  const timeout = input("mem-http-timeout");
  if (timeout) timeout.value = String(config.http.timeoutMs);
  const limit = input("mem-http-limit");
  if (limit) limit.value = String(config.http.searchLimit);
  const write = input("mem-http-write");
  if (write) write.checked = config.http.writeEnabled;
  const bankGeneral = input("mem-http-bank-general");
  if (bankGeneral) bankGeneral.value = config.http.banks.general;
  const bankEstate = input("mem-http-bank-estate");
  if (bankEstate) bankEstate.value = config.http.banks.estate;
  const bankJob = input("mem-http-bank-job");
  if (bankJob) bankJob.value = config.http.banks.job;
  const apiKey = input("mem-http-api-key");
  if (apiKey) {
    apiKey.value = "";
    apiKey.placeholder = config.http.hasApiKey ? `已保存 ${config.http.keyMasked || "••••"}` : "未保存 API Key";
  }
  const keyState = $("mem-http-key-state");
  if (keyState) keyState.textContent = config.http.hasApiKey ? `已保存 ${config.http.keyMasked || "••••"}；留空保持不变` : "尚未保存；留空保持不变";
  const clearKey = input("mem-http-clear-key");
  if (clearKey) clearKey.checked = false;

  if (select("mem-distill-mode")) select("mem-distill-mode")!.value = config.distillation.mode;
  if (input("mem-distill-max-turn")) input("mem-distill-max-turn")!.value = String(config.distillation.maxPerTurn);
  if (input("mem-distill-hourly")) input("mem-distill-hourly")!.value = String(config.distillation.hourlyLimit);
  if (input("mem-stale-grace-days")) input("mem-stale-grace-days")!.value = String(config.retention.staleGraceDays);
  if (input("mem-preference-days")) input("mem-preference-days")!.value = String(config.retention.preferenceDays);
  if (input("mem-project-days")) input("mem-project-days")!.value = String(config.retention.projectFactDays);
  if (input("mem-correction-days")) input("mem-correction-days")!.value = String(config.retention.correctionDays);
  if (input("mem-identity-days")) input("mem-identity-days")!.value = String(config.retention.identityDays);
  if (input("mem-retention-active")) input("mem-retention-active")!.value = String(config.retention.activePerScope);
  if (input("mem-retention-history")) input("mem-retention-history")!.value = String(config.retention.historyPerScope);

  if (input("mem-embedding-enabled")) input("mem-embedding-enabled")!.checked = config.embedding.enabled;
  if (input("mem-embedding-base-url")) input("mem-embedding-base-url")!.value = config.embedding.baseURL;
  if (input("mem-embedding-model")) input("mem-embedding-model")!.value = config.embedding.model;
  if (input("mem-embedding-timeout")) input("mem-embedding-timeout")!.value = String(config.embedding.timeoutMs);
  if (input("mem-embedding-dimensions")) input("mem-embedding-dimensions")!.value = String(config.embedding.dimensions);
  if (input("mem-embedding-similarity")) input("mem-embedding-similarity")!.value = String(config.embedding.minSimilarity);
  const embeddingKey = input("mem-embedding-api-key");
  if (embeddingKey) {
    embeddingKey.value = "";
    embeddingKey.placeholder = config.embedding.hasApiKey ? `已保存 ${config.embedding.keyMasked || "••••"}` : "未保存 API Key";
  }
  const embeddingKeyState = $("mem-embedding-key-state");
  if (embeddingKeyState) {
    embeddingKeyState.textContent = config.embedding.hasApiKey
      ? `已保存 ${config.embedding.keyMasked || "••••"}；留空保持不变`
      : "尚未保存 Embedding API Key；留空保持不变";
  }
  if (input("mem-embedding-clear-key")) input("mem-embedding-clear-key")!.checked = false;
  toggleHttpFields();
}

function toggleHttpFields(): void {
  const enabled = Boolean(input("mem-http-enabled")?.checked);
  const fields = $("memory-http-fields") as HTMLFieldSetElement | null;
  if (fields) fields.disabled = !enabled;
  const banks = $("mem-http-banks");
  if (banks) banks.classList.toggle("hidden", select("mem-http-preset")?.value !== "hindsight");
}

function formPatch() {
  const httpEnabled = Boolean(input("mem-http-enabled")?.checked);
  const apiKey = input("mem-http-api-key")?.value.trim() || "";
  const embeddingKey = input("mem-embedding-api-key")?.value.trim() || "";
  return {
    activeProvider: select("mem-active-provider")?.value === "http" ? "http" : "local",
    local: { allowPII: Boolean(input("mem-allow-pii")?.checked) },
    http: {
      enabled: httpEnabled,
      preset: select("mem-http-preset")?.value === "hindsight" ? "hindsight" : "generic",
      baseURL: input("mem-http-base-url")?.value.trim() || "",
      authMode: select("mem-http-auth-mode")?.value === "none" ? "none" : "bearer",
      ...(apiKey ? { apiKey } : {}),
      clearApiKey: Boolean(input("mem-http-clear-key")?.checked),
      timeoutMs: Number(input("mem-http-timeout")?.value || 8000),
      searchLimit: Number(input("mem-http-limit")?.value || 8),
      writeEnabled: Boolean(input("mem-http-write")?.checked),
      banks: {
        general: input("mem-http-bank-general")?.value.trim() || "",
        estate: input("mem-http-bank-estate")?.value.trim() || "",
        job: input("mem-http-bank-job")?.value.trim() || "",
      },
    },
    distillation: {
      mode: select("mem-distill-mode")?.value === "off" || select("mem-distill-mode")?.value === "confirm"
        ? select("mem-distill-mode")!.value
        : "smart",
      maxPerTurn: Number(input("mem-distill-max-turn")?.value || 3),
      hourlyLimit: Number(input("mem-distill-hourly")?.value || 20),
    },
    embedding: {
      enabled: Boolean(input("mem-embedding-enabled")?.checked),
      baseURL: input("mem-embedding-base-url")?.value.trim() || "",
      model: input("mem-embedding-model")?.value.trim() || "",
      ...(embeddingKey ? { apiKey: embeddingKey } : {}),
      clearApiKey: Boolean(input("mem-embedding-clear-key")?.checked),
      timeoutMs: Number(input("mem-embedding-timeout")?.value || 8000),
      dimensions: Number(input("mem-embedding-dimensions")?.value || 0),
      minSimilarity: Number(input("mem-embedding-similarity")?.value || 0.25),
    },
    retention: {
      activePerScope: Number(input("mem-retention-active")?.value || 2000),
      historyPerScope: Number(input("mem-retention-history")?.value || 5000),
      staleGraceDays: Number(input("mem-stale-grace-days")?.value || 30),
      preferenceDays: Number(input("mem-preference-days")?.value || 180),
      projectFactDays: Number(input("mem-project-days")?.value || 120),
      correctionDays: Number(input("mem-correction-days")?.value || 365),
      identityDays: Number(input("mem-identity-days")?.value || 365),
    },
  };
}

function validateConfigForm(): boolean {
  const patch = formPatch();
  if (patch.activeProvider === "http" && !patch.http.enabled) {
    setHttpStatus("切换到 HTTP 前请先勾选“启用”", "err");
    return false;
  }
  if (patch.http.enabled && !patch.http.baseURL) {
    setHttpStatus("启用 HTTP 记忆必须填写 Base URL", "err");
    return false;
  }
  if (patch.http.enabled && patch.http.preset === "hindsight") {
    const banks = patch.http.banks;
    if (!banks.general || !banks.estate || !banks.job) {
      setHttpStatus("Hindsight 必须分别填写 general / estate / job bank", "err");
      return false;
    }
    if (new Set([banks.general, banks.estate, banks.job]).size !== 3) {
      setHttpStatus("general / estate / job bank 必须互不相同", "err");
      return false;
    }
  }
  if (patch.embedding.enabled && (!patch.embedding.baseURL || !patch.embedding.model)) {
    const el = $("mem-embedding-status");
    if (el) { el.textContent = "启用语义召回必须填写 Embedding Base URL 和模型名"; el.className = "settings-status err"; }
    return false;
  }
  if (patch.retention.historyPerScope < patch.retention.activePerScope) {
    const el = $("mem-embedding-status");
    if (el) { el.textContent = "历史保留上限不能小于 active 上限"; el.className = "settings-status err"; }
    return false;
  }
  return true;
}

function sourceLabel(source: MemoryEntry["source"]): string {
  if (source === "agent") return "Agent 保存";
  if (source === "import") return "导入";
  return "手动添加";
}

function renderMemories(): void {
  const list = $("memories-list");
  if (!list) return;
  const query = (input("mem-search")?.value || "").trim().toLocaleLowerCase();
  const visible = allMemories.filter((entry) => {
    if (!query) return true;
    return `${entry.key}\n${entry.content}\n${entry.tags.join(" ")}`.toLocaleLowerCase().includes(query);
  });
  list.replaceChildren();
  if (!visible.length) {
    const empty = document.createElement("p");
    empty.className = "memories-empty";
    empty.textContent = query
      ? "没有符合筛选条件的记忆。"
      : "当前 Agent 范围还没有长期记忆。可以在对话里说「记住：…」或用下面表单手动添加。";
    list.appendChild(empty);
    return;
  }
  for (const entry of visible) {
    const row = document.createElement("div");
    row.className = "memory-item" + (entry.status === "superseded" || entry.status === "archived" ? " superseded" : entry.status === "candidate" ? " candidate" : "");
    row.innerHTML = `
      <div class="m-body">
        <div class="m-key"></div>
        <div class="m-content"></div>
        <div class="m-meta"></div>
      </div>
      <button class="p-del" type="button" title="删除这条记忆">删除</button>`;
    const keyEl = row.querySelector(".m-key");
    if (keyEl) keyEl.textContent = entry.key;
    const contentEl = row.querySelector(".m-content");
    if (contentEl) contentEl.textContent = entry.content;
    const when = new Date(entry.updatedAt).toLocaleString();
    const metaEl = row.querySelector(".m-meta");
    if (metaEl) {
      const statusLabel = entry.status === "candidate" ? " · 待确认"
        : entry.status === "stale" ? " · 已过期待确认"
          : entry.status === "superseded" ? " · 历史版本"
            : entry.status === "archived" ? " · 已归档"
              : "";
      const tags = entry.tags.length ? ` · #${entry.tags.join(" #")}` : "";
      const confidence = typeof entry.confidence === "number" && entry.confidence < 1 ? ` · 置信度 ${(entry.confidence * 100).toFixed(0)}%` : "";
      const expiry = entry.expiresAt ? ` · 到期 ${new Date(entry.expiresAt).toLocaleDateString()}` : "";
      metaEl.textContent = `${sourceLabel(entry.source)} · ${(entry.scope.profileId === "estate" ? "租房 Agent" : entry.scope.profileId === "job" ? "求职 Agent" : "通用 Agent")} · 命中 ${entry.useCount ?? 0} 次${statusLabel}${confidence}${expiry}${tags} · ${when}`;
    }
    row.querySelector(".p-del")?.addEventListener("click", async () => {
      if (!(await uiConfirm(`删除记忆「${entry.key}」？删除后无法恢复。`, { title: "删除记忆", okText: "删除", danger: true }))) return;
      try {
        await api(`/api/memories/${encodeURIComponent(entry.id)}?profileId=${currentMemoryProfile()}`, { method: "DELETE" });
        await refreshMemories();
        memStatus("已删除", "ok");
      } catch (err) {
        memStatus(`✗ ${(err as Error).message}`, "err");
      }
    });
    list.appendChild(row);
  }
}

function renderCandidates(): void {
  const list = $("mem-candidates-list");
  if (!list) return;
  list.replaceChildren();
  if (!allCandidates.length) {
    const empty = document.createElement("p");
    empty.className = "memories-empty";
    empty.textContent = "当前没有待确认的自动沉淀。";
    list.appendChild(empty);
    return;
  }
  for (const entry of allCandidates) {
    const row = document.createElement("div");
    row.className = "memory-item candidate";
    const body = document.createElement("div");
    body.className = "m-body";
    const keyEl = document.createElement("div");
    keyEl.className = "m-key";
    keyEl.textContent = entry.key;
    const contentEl = document.createElement("div");
    contentEl.className = "m-content";
    contentEl.textContent = entry.content;
    const metaEl = document.createElement("div");
    metaEl.className = "m-meta";
    const confidence = typeof entry.confidence === "number" ? `${(entry.confidence * 100).toFixed(0)}%` : "未知";
    metaEl.textContent = `自动沉淀 · 置信度 ${confidence}${entry.category ? ` · ${entry.category}` : ""} · ${new Date(entry.updatedAt).toLocaleString()}`;
    body.append(keyEl, contentEl, metaEl);
    const actions = document.createElement("div");
    actions.className = "memory-candidate-actions";
    const confirmButton = document.createElement("button");
    confirmButton.className = "p-del candidate-confirm";
    confirmButton.type = "button";
    confirmButton.textContent = "确认";
    const rejectButton = document.createElement("button");
    rejectButton.className = "p-del candidate-reject";
    rejectButton.type = "button";
    rejectButton.textContent = "拒绝";
    actions.append(confirmButton, rejectButton);
    row.append(body, actions);
    confirmButton.addEventListener("click", async () => {
      try {
        await api(`/api/memories/${encodeURIComponent(entry.id)}/confirm?profileId=${currentMemoryProfile()}`, { method: "POST" });
        await refreshMemories();
        memStatus("候选记忆已确认并生效", "ok");
      } catch (err) {
        memStatus(`✗ ${(err as Error).message}`, "err");
      }
    });
    rejectButton.addEventListener("click", async () => {
      try {
        await api(`/api/memories/${encodeURIComponent(entry.id)}/reject?profileId=${currentMemoryProfile()}`, { method: "POST" });
        await refreshMemories();
        memStatus("候选记忆已拒绝", "ok");
      } catch (err) {
        memStatus(`✗ ${(err as Error).message}`, "err");
      }
    });
    list.appendChild(row);
  }
}

export async function refreshMemories(): Promise<MemoryEntry[]> {
  const profileId = currentMemoryProfile();
  const history = Boolean(input("mem-history-toggle")?.checked);
  const data = await api<{ memories?: MemoryEntry[] }>(
    `/api/memories?profileId=${profileId}${history ? "&history=1" : ""}`
  );
  allMemories = data.memories || [];
  const candidateData = await api<{ memories?: MemoryEntry[] }>(`/api/memories/candidates?profileId=${profileId}`);
  allCandidates = candidateData.memories || [];
  renderMemories();
  renderCandidates();
  return allMemories;
}

export async function refreshMemorySettings(): Promise<void> {
  const [configResult, status] = await Promise.all([
    api<{ config: MemorySlotConfig }>("/api/memory/config"),
    api<MemorySlotStatus>(`/api/memory/status?profileId=${currentMemoryProfile()}`),
  ]);
  applyConfig(configResult.config);
  renderStatus(status);
  await refreshMemories();
}

export async function saveMemoryConfigFromForm(): Promise<void> {
  if (!validateConfigForm()) return;
  const button = $("mem-save-config-btn") as HTMLButtonElement | null;
  if (button) button.disabled = true;
  try {
    const result = await api<{ config: MemorySlotConfig; providerId: "local" | "http" }>("/api/memory/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(formPatch()),
    });
    applyConfig(result.config);
    const status = await api<MemorySlotStatus>(`/api/memory/status?profileId=${currentMemoryProfile()}`);
    renderStatus(status);
    await refreshMemories();
    setHttpStatus(`已保存，当前 Provider：${result.providerId}`, "ok");
  } catch (err) {
    setHttpStatus(`✗ ${(err as Error).message}`, "err");
  } finally {
    if (button) button.disabled = false;
  }
}

export async function testMemoryHttpFromForm(): Promise<void> {
  if (!validateConfigForm()) return;
  const button = $("mem-test-http-btn") as HTMLButtonElement | null;
  if (button) button.disabled = true;
  setHttpStatus("正在连接外部记忆服务…", "");
  try {
    const result = await api<{ ok: boolean; health: MemoryProviderHealth }>("/api/memory/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(formPatch()),
    });
    const latency = typeof result.health.latencyMs === "number" ? `，${result.health.latencyMs}ms` : "";
    const detail = result.health.message ? `：${result.health.message}` : "";
    setHttpStatus(result.ok ? `连接成功${latency}` : `连接失败${latency}${detail}`, result.ok ? "ok" : "err");
  } catch (err) {
    setHttpStatus(`✗ ${(err as Error).message}`, "err");
  } finally {
    if (button) button.disabled = false;
  }
}

export async function testMemoryEmbeddingFromForm(): Promise<void> {
  if (!validateConfigForm()) return;
  const button = $("mem-test-embedding-btn") as HTMLButtonElement | null;
  const status = $("mem-embedding-status");
  if (button) button.disabled = true;
  if (status) { status.textContent = "正在测试 Embedding 服务…"; status.className = "settings-status"; }
  try {
    const result = await api<{ ok: boolean; dimensions: number; model: string }>("/api/memory/embedding/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(formPatch()),
    });
    if (status) {
      status.textContent = `Embedding 可用：${result.model} · ${result.dimensions} 维`;
      status.className = "settings-status ok";
    }
  } catch (err) {
    if (status) {
      status.textContent = `✗ ${(err as Error).message}`;
      status.className = "settings-status err";
    }
  } finally {
    if (button) button.disabled = false;
  }
}

export async function reindexMemoryFromForm(): Promise<void> {
  const button = $("mem-reindex-btn") as HTMLButtonElement | null;
  const status = $("mem-embedding-status");
  if (button) button.disabled = true;
  if (status) { status.textContent = "正在重建当前 Agent 向量索引…"; status.className = "settings-status"; }
  try {
    const result = await api<{ ok: boolean; status: { indexed: number; model: string } }>("/api/memory/reindex", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: currentMemoryProfile() }),
    });
    if (status) {
      status.textContent = `索引已重建：${result.status.indexed} 条 · ${result.status.model}`;
      status.className = "settings-status ok";
    }
    const latest = await api<MemorySlotStatus>(`/api/memory/status?profileId=${currentMemoryProfile()}`);
    renderStatus(latest);
  } catch (err) {
    if (status) {
      status.textContent = `✗ ${(err as Error).message}`;
      status.className = "settings-status err";
    }
  } finally {
    if (button) button.disabled = false;
  }
}

export async function saveMemoryFromForm(): Promise<void> {
  const keyEl = input("mem-key");
  const contentEl = $("mem-content") as HTMLTextAreaElement | null;
  const key = (keyEl?.value || "").trim();
  const content = (contentEl?.value || "").trim();
  clearFieldError("mem-key");
  clearFieldError("mem-content");
  if (!key) setFieldError("mem-key", "请填写记忆主题");
  if (!content) setFieldError("mem-content", "请填写记忆内容");
  if (!key || !content) { memStatus("请先修正表单中的必填项", "err"); return; }
  try {
    await api("/api/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: currentMemoryProfile(), key, content }),
    });
    if (keyEl) keyEl.value = "";
    if (contentEl) contentEl.value = "";
    await refreshMemories();
    memStatus("已保存（下轮对话即生效）", "ok");
  } catch (err) {
    memStatus(`✗ ${(err as Error).message}`, "err");
  }
}

async function exportMemories(): Promise<void> {
  try {
    const profileId = currentMemoryProfile();
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

async function importMemories(file: File): Promise<void> {
  try {
    if (file.size > 1_500_000) throw new Error("导入文件过大（上限 1.5MB）");
    const snapshot = JSON.parse(await file.text());
    const mode = select("mem-import-mode")?.value === "replace" ? "replace" : "merge";
    if (mode === "replace") {
      const confirmed = await uiConfirm(
        `替换当前「${memoryProfileLabel(currentMemoryProfile())}」scope 的全部本地记忆？其他 scope 不受影响。`,
        { title: "替换记忆", okText: "替换导入", danger: true }
      );
      if (!confirmed) return;
    }
    const result = await api<{ imported: number }>("/api/memories/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: currentMemoryProfile(), mode, snapshot }),
    });
    await refreshMemories();
    memStatus(`已导入 ${result.imported} 条`, "ok");
  } catch (err) {
    memStatus(`✗ ${(err as Error).message}`, "err");
  }
}

/** 绑定设置页交互；重复调用安全。 */
export function bindMemorySettings(): void {
  const root = $("memories-modal");
  if (!root || root.dataset.bound === "1") return;
  root.dataset.bound = "1";

  $("mem-refresh-btn")?.addEventListener("click", () => {
    void refreshMemorySettings().catch((err) => memStatus(`✗ ${(err as Error).message}`, "err"));
  });
  $("mem-active-provider")?.addEventListener("change", () => {
    if (select("mem-active-provider")?.value === "http" && !input("mem-http-enabled")?.checked) {
      setHttpStatus("HTTP Provider 尚未启用；勾选启用并保存后才会切换", "warn");
    }
  });
  input("mem-http-enabled")?.addEventListener("change", toggleHttpFields);
  select("mem-http-preset")?.addEventListener("change", toggleHttpFields);
  $("mem-save-config-btn")?.addEventListener("click", () => { void saveMemoryConfigFromForm(); });
  $("mem-test-http-btn")?.addEventListener("click", () => { void testMemoryHttpFromForm(); });
  $("mem-test-embedding-btn")?.addEventListener("click", () => { void testMemoryEmbeddingFromForm(); });
  $("mem-reindex-btn")?.addEventListener("click", () => { void reindexMemoryFromForm(); });
  select("mem-profile-filter")?.addEventListener("change", () => {
    void refreshMemorySettings().catch((err) => memStatus(`✗ ${(err as Error).message}`, "err"));
  });
  input("mem-search")?.addEventListener("input", renderMemories);
  input("mem-history-toggle")?.addEventListener("change", () => {
    void refreshMemories().catch((err) => memStatus(`✗ ${(err as Error).message}`, "err"));
  });
  $("mem-export-btn")?.addEventListener("click", () => { void exportMemories(); });
  input("mem-import-file")?.addEventListener("change", (event) => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file) void importMemories(file);
    (event.target as HTMLInputElement).value = "";
  });
}
