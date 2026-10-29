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
let currentConfig: MemorySlotConfig | null = null;

function currentMemoryProfile(): "general" | "estate" {
  const select = $("mem-profile-filter") as HTMLSelectElement | null;
  return select?.value === "estate" ? "estate" : "general";
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
  const history = $("mem-local-history");
  const state = $("mem-local-state");
  if (active) active.textContent = String(status.localStore.activeCount);
  if (history) history.textContent = String(status.localStore.historyCount);
  if (state) state.textContent = stateText(status.localStore.state);
  const detail = $("mem-provider-detail");
  if (detail) {
    const latency = typeof status.health.latencyMs === "number" ? ` · ${status.health.latencyMs}ms` : "";
    const message = status.health.message ? ` · ${status.health.message}` : "";
    detail.textContent = `当前：${status.activeProvider === "http" ? "HTTP 外部记忆" : "内置本地记忆"}${latency}${message}`;
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
  const apiKey = input("mem-http-api-key");
  if (apiKey) {
    apiKey.value = "";
    apiKey.placeholder = config.http.hasApiKey ? `已保存 ${config.http.keyMasked || "••••"}` : "未保存 API Key";
  }
  const keyState = $("mem-http-key-state");
  if (keyState) keyState.textContent = config.http.hasApiKey ? `已保存 ${config.http.keyMasked || "••••"}；留空保持不变` : "尚未保存；留空保持不变";
  const clearKey = input("mem-http-clear-key");
  if (clearKey) clearKey.checked = false;
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
      },
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
    if (!patch.http.banks.general || !patch.http.banks.estate) {
      setHttpStatus("Hindsight 必须分别填写 general / estate bank", "err");
      return false;
    }
    if (patch.http.banks.general === patch.http.banks.estate) {
      setHttpStatus("general 与 estate bank 不能相同", "err");
      return false;
    }
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
  list.innerHTML = "";
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
    row.className = "memory-item" + (entry.status === "superseded" ? " superseded" : "");
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
      const status = entry.status === "superseded" ? " · 历史版本" : "";
      const tags = entry.tags.length ? ` · #${entry.tags.join(" #")}` : "";
      metaEl.textContent = `${sourceLabel(entry.source)} · ${entry.scope.profileId === "estate" ? "租房 Agent" : "通用 Agent"} · 命中 ${entry.useCount ?? 0} 次${status}${tags} · ${when}`;
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

export async function refreshMemories(): Promise<MemoryEntry[]> {
  const profileId = currentMemoryProfile();
  const history = Boolean(input("mem-history-toggle")?.checked);
  const data = await api<{ memories?: MemoryEntry[] }>(
    `/api/memories?profileId=${profileId}${history ? "&history=1" : ""}`
  );
  allMemories = data.memories || [];
  renderMemories();
  return allMemories;
}

export async function refreshMemorySettings(): Promise<void> {
  const [configResult, status] = await Promise.all([
    api<{ config: MemorySlotConfig }>("/api/memory/config"),
    api<MemorySlotStatus>("/api/memory/status"),
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
    const status = await api<MemorySlotStatus>("/api/memory/status");
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
        `替换当前「${currentMemoryProfile() === "estate" ? "租房 Agent" : "通用 Agent"}」scope 的全部本地记忆？另一个 scope 不受影响。`,
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
  select("mem-profile-filter")?.addEventListener("change", () => {
    void refreshMemories().catch((err) => memStatus(`✗ ${(err as Error).message}`, "err"));
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
