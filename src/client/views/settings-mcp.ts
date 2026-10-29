/**
 * ============================================================
 * views/settings-mcp.ts — 设置页「MCP Servers」分区
 * ============================================================
 * 职责：全局暂停、服务器列表 / 展开、单服务器启停、添加编辑、JSON 导入与连接测试。
 * 设计立场：
 *  - 使用 h() 构建节点，服务器名、命令、工具名等外部内容全部走 textContent 语义；
 *  - 网页编辑走 PATCH，只改可见字段，不覆盖 JSON 导入的 env / cwd；
 *  - 开关只负责配置，实际工具注入由服务端变更后立即刷新。
 */
import { $ } from "../core/dom.js";
import { api } from "../core/api.js";
import { uiConfirm } from "../ui/dialog.js";
import { h } from "../ui/h.js";
import { icon } from "../ui/icon.js";

interface McpToolInfo {
  name: string;
  description?: string;
}

export interface McpServerStatus {
  id: string;
  name: string;
  command: string;
  args: string[];
  enabled: boolean;
  requireApproval: boolean;
  cwd?: string;
  envKeys: string[];
  connected: boolean;
  tools: McpToolInfo[];
  error?: string;
}

interface McpStateResponse {
  enabled: boolean;
  servers: McpServerStatus[];
}

interface McpImportResponse extends McpStateResponse {
  imported?: string[];
  overwritten?: string[];
  conflicts?: string[];
}

const MAX_IMPORT_BYTES = 1_000_000;
let currentServers: McpServerStatus[] = [];
let globalEnabled = true;
let editingId: string | null = null;
let editorReturnFocus: HTMLElement | null = null;
let statusTimer: ReturnType<typeof setTimeout> | undefined;
const expandedIds = new Set<string>();

export function showMcpStatus(text: string, cls = "", editor = false): void {
  const el = $(editor ? "mcp-editor-status" : "mcp-status");
  if (!el) return;
  el.textContent = text;
  el.className = "settings-status" + (cls ? " " + cls : "");
  if (editor) return;
  clearTimeout(statusTimer);
  if (text) {
    statusTimer = setTimeout(() => {
      if (el.textContent === text) { el.textContent = ""; el.className = "settings-status"; }
    }, 4500);
  }
}

function inputValue(id: string): string {
  return (($(id) as HTMLInputElement | null)?.value || "");
}

function setInput(id: string, value: string): void {
  const el = $(id) as HTMLInputElement | null;
  if (el) el.value = value;
}

function statusMeta(server: McpServerStatus): { label: string; icon: "CircleCheck" | "CircleAlert" | "CircleX"; tone: string } {
  if (!server.enabled) return { label: "已停用", icon: "CircleX", tone: "muted" };
  if (server.connected) return { label: "已连接", icon: "CircleCheck", tone: "ok" };
  if (server.error) return { label: "连接失败", icon: "CircleAlert", tone: "warn" };
  return { label: "待测试", icon: "CircleAlert", tone: "warn" };
}

function updateGlobalControls(): void {
  const toggle = $("mcp-global-enabled") as HTMLInputElement | null;
  if (toggle) { toggle.checked = globalEnabled; toggle.disabled = false; }
  const state = $("mcp-global-state");
  if (state) {
    state.textContent = globalEnabled ? "已启用" : "已暂停";
    state.className = "mcp-state-pill" + (globalEnabled ? " ok" : " muted");
  }
  const enabledCount = currentServers.filter((server) => server.enabled).length;
  const summary = $("mcp-summary");
  if (summary) {
    summary.textContent = currentServers.length
      ? `共 ${currentServers.length} 个服务器 · ${enabledCount} 个已启用`
      : "共 0 个服务器";
  }
  $("mcp-list")?.classList.toggle("global-paused", !globalEnabled);
}

function renderServerDetails(server: McpServerStatus): HTMLElement {
  const command = `$ ${server.command} ${server.args.join(" ")}`.trim();
  const toolList = server.tools.length
    ? h("div", { class: "mcp-tool-chips" },
        ...server.tools.map((tool) => h("span", {
          class: "mcp-tool-chip",
          title: tool.description || tool.name,
        }, tool.name)))
    : h("p", { class: "mcp-detail-empty" }, server.error || "尚未测试连接，暂无远端工具信息。");

  const advanced = [
    server.cwd ? `工作目录：${server.cwd}` : "",
    server.envKeys.length ? `环境变量：${server.envKeys.join("、")}` : "",
  ].filter(Boolean).join(" · ");

  const testButton = h("button", {
    type: "button",
    class: "ghost-btn small",
    "aria-label": `测试 MCP 服务器 ${server.name}`,
  }, icon("RefreshCw", { size: 13 }), "测试连接");
  testButton.addEventListener("click", () => { void testServer(server, testButton); });

  return h("div", { class: "mcp-server-details" },
    h("div", { class: "mcp-command-row" },
      h("span", { class: "mcp-detail-label" }, "启动命令"),
      h("code", { class: "mcp-command" }, command),
    ),
    h("div", { class: "mcp-detail-grid" },
      h("div", null,
        h("span", { class: "mcp-detail-label" }, `远端工具${server.tools.length ? ` · ${server.tools.length}` : ""}`),
        toolList,
      ),
      h("div", null,
        h("span", { class: "mcp-detail-label" }, "运行策略"),
        h("p", { class: "mcp-policy" },
          `${server.requireApproval ? "调用前审批" : "免审批直接执行"} · ${server.connected ? "连接可用" : "尚无活跃连接"}`),
        advanced ? h("p", { class: "mcp-advanced-meta" }, advanced) : null,
      ),
    ),
    h("div", { class: "mcp-detail-actions" }, testButton),
  );
}

function createServerRow(server: McpServerStatus, index: number): HTMLElement {
  const expanded = expandedIds.has(server.id);
  const meta = statusMeta(server);
  const row = h("article", {
    class: "mcp-server-row"
      + (server.enabled ? "" : " disabled")
      + (globalEnabled ? "" : " globally-paused"),
    dataset: { mcpId: server.id },
  });

  const expandButton = h("button", {
    type: "button",
    class: "mcp-expand-btn",
    "aria-label": `${expanded ? "收起" : "展开"} MCP 服务器 ${server.name}`,
    "aria-expanded": String(expanded),
  }, icon(expanded ? "ChevronDown" : "ChevronRight", { size: 15 }));

  const title = h("div", { class: "mcp-server-title-row" },
    h("strong", { class: "mcp-server-name" }, server.name),
    h("span", { class: "mcp-server-status " + meta.tone }, icon(meta.icon, { size: 13 }), meta.label),
  );
  const subtitle = h("div", { class: "mcp-server-subtitle" },
    h("span", null, server.id),
    h("span", null, server.tools.length ? `${server.tools.length} 个工具` : server.connected ? "暂无工具" : "未连接"),
  );

  const settingsButton = h("button", {
    type: "button",
    class: "mcp-icon-btn",
    "aria-label": `编辑 MCP 服务器 ${server.name}`,
    title: "编辑服务器",
  }, icon("Settings", { size: 15 }));
  settingsButton.addEventListener("click", (event) => {
    event.stopPropagation();
    openMcpEditor(server);
  });

  const toggle = h("input", {
    type: "checkbox",
    "aria-label": `启用 MCP 服务器 ${server.name}`,
  }) as HTMLInputElement;
  toggle.checked = server.enabled;
  toggle.addEventListener("change", () => { void toggleServer(server, toggle); });
  const toggleLabel = h("label", { class: "mcp-switch", title: "启用或停用服务器" },
    toggle,
    h("span", { class: "mcp-switch-track", "aria-hidden": "true" }),
  );

  const tone = `tone-${index % 5}`;
  row.append(
    expandButton,
    h("span", { class: "mcp-server-icon " + tone, "aria-hidden": "true" }, server.name.slice(0, 1).toUpperCase() || "M"),
    h("div", { class: "mcp-server-main" }, title, subtitle),
    h("div", { class: "mcp-server-actions" }, settingsButton, toggleLabel),
  );

  const details = renderServerDetails(server);
  details.classList.toggle("hidden", !expanded);
  row.append(details);
  expandButton.addEventListener("click", () => {
    const next = !expandedIds.has(server.id);
    if (next) expandedIds.add(server.id);
    else expandedIds.delete(server.id);
    details.classList.toggle("hidden", !next);
    expandButton.setAttribute("aria-expanded", String(next));
    expandButton.setAttribute("aria-label", `${next ? "收起" : "展开"} MCP 服务器 ${server.name}`);
    expandButton.replaceChildren(icon(next ? "ChevronDown" : "ChevronRight", { size: 15 }));
  });
  return row;
}

function renderMcpList(): void {
  const list = $("mcp-list");
  if (!list) return;
  list.replaceChildren();
  updateGlobalControls();
  if (!currentServers.length) {
    const add = h("button", { type: "button", class: "ghost-btn small mcp-add-btn" }, icon("Plus", { size: 14 }), "添加第一个服务器");
    add.addEventListener("click", () => openMcpEditor());
    list.appendChild(h("div", { class: "mcp-empty-state" },
      icon("Server", { size: 28 }),
      h("h3", null, "还没有 MCP Servers"),
      h("p", null, "添加一个 stdio MCP server，或导入现成的 .mcp.json 配置。"),
      h("div", { class: "mcp-empty-actions" }, add),
    ));
    return;
  }
  currentServers.forEach((server, index) => list.appendChild(createServerRow(server, index)));
}

function applyState(data: Partial<McpStateResponse>): void {
  if (typeof data.enabled === "boolean") globalEnabled = data.enabled;
  if (Array.isArray(data.servers)) {
    currentServers = data.servers.map((server) => ({
      ...server,
      args: Array.isArray(server.args) ? server.args : [],
      envKeys: Array.isArray(server.envKeys) ? server.envKeys : [],
      tools: Array.isArray(server.tools) ? server.tools : [],
    }));
  }
  renderMcpList();
}

async function toggleServer(server: McpServerStatus, toggle: HTMLInputElement): Promise<void> {
  const next = toggle.checked;
  toggle.disabled = true;
  try {
    const data = await api<McpStateResponse & { server?: McpServerStatus }>(
      `/api/mcp/${encodeURIComponent(server.id)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      },
    );
    applyState(data);
    showMcpStatus(`${next ? "已启用" : "已停用"} MCP 服务器「${server.name}」`, "ok");
  } catch (err) {
    toggle.checked = !next;
    toggle.disabled = false;
    showMcpStatus(`✗ ${(err as Error).message}`, "err");
  }
}

async function toggleGlobal(toggle: HTMLInputElement): Promise<void> {
  const next = toggle.checked;
  toggle.disabled = true;
  try {
    const data = await api<McpStateResponse>("/api/mcp", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: next }),
    });
    applyState(data);
    showMcpStatus(next ? "MCP 工具已恢复" : "MCP 工具已暂停，配置保持不变", "ok");
  } catch (err) {
    toggle.checked = !next;
    toggle.disabled = false;
    showMcpStatus(`✗ ${(err as Error).message}`, "err");
  }
}

async function testServer(server: McpServerStatus, button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  try {
    const result = await api<{ status: McpServerStatus }>(`/api/mcp/${encodeURIComponent(server.id)}/test`, { method: "POST" });
    const index = currentServers.findIndex((item) => item.id === server.id);
    if (index >= 0) currentServers[index] = result.status;
    if (result.status.connected) {
      expandedIds.add(server.id);
      showMcpStatus(`✓ 「${server.name}」连接成功，发现 ${result.status.tools.length} 个工具`, "ok");
    } else {
      showMcpStatus(`✗ 「${server.name}」连接失败：${result.status.error || "未知原因"}`, "err");
    }
    renderMcpList();
  } catch (err) {
    showMcpStatus(`✗ ${(err as Error).message}`, "err");
  } finally {
    button.disabled = false;
  }
}

export async function refreshMcp(): Promise<McpServerStatus[]> {
  const refresh = $("mcp-refresh-btn") as HTMLButtonElement | null;
  if (refresh) refresh.disabled = true;
  try {
    const data = await api<McpStateResponse>("/api/mcp");
    applyState(data);
    return currentServers;
  } finally {
    if (refresh) refresh.disabled = false;
  }
}

function parseArgs(raw: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote = "";
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (quote) {
      if (char === quote) quote = "";
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (/\s/.test(char)) {
      if (current) { args.push(current); current = ""; }
      continue;
    }
    current += char;
  }
  if (quote) throw new Error("启动参数中的引号没有闭合");
  if (current) args.push(current);
  return args;
}

export function openMcpEditor(server: McpServerStatus | null = null): void {
  editorReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  editingId = server?.id ?? null;
  setInput("mcp-id", server?.id ?? "");
  setInput("mcp-name", server && server.name !== server.id ? server.name : "");
  setInput("mcp-command", server?.command ?? "");
  setInput("mcp-args", server?.args.join(" ") ?? "");
  const idInput = $("mcp-id") as HTMLInputElement | null;
  if (idInput) idInput.readOnly = Boolean(server);
  const approval = $("mcp-approval") as HTMLInputElement | null;
  if (approval) approval.checked = server?.requireApproval !== false;
  const title = $("mcp-editor-title");
  if (title) title.textContent = server ? "编辑 MCP Server" : "添加 MCP Server";
  const sub = $("mcp-editor-sub");
  if (sub) {
    sub.textContent = server
      ? "只更新当前可见字段；通过 JSON 导入的 env / cwd 会原样保留。"
      : "配置本机 stdio 启动命令；保存后可展开服务器测试连接并查看远端工具。";
  }
  const note = $("mcp-cwd-note");
  if (note) {
    const details = server
      ? [server.cwd ? `工作目录 ${server.cwd}` : "", server.envKeys.length ? `环境变量 ${server.envKeys.join("、")}` : ""].filter(Boolean).join(" · ")
      : "";
    note.textContent = details ? `高级配置：${details}。网页编辑不会修改这些字段。` : "";
    note.classList.toggle("hidden", !details);
  }
  $("mcp-editor-delete")?.classList.toggle("hidden", !server);
  showMcpStatus("", "", true);
  $("mcp-editor-mask")?.classList.remove("hidden");
  requestAnimationFrame(() => (server ? $("mcp-name") : $("mcp-id"))?.focus());
}

export function closeMcpEditor(): void {
  $("mcp-editor-mask")?.classList.add("hidden");
  editingId = null;
  showMcpStatus("", "", true);
  const target = editorReturnFocus;
  editorReturnFocus = null;
  if (target?.isConnected) target.focus();
  else ($("mcp-add-btn") as HTMLButtonElement | null)?.focus();
}

function trapEditorFocus(event: KeyboardEvent): void {
  if (event.key !== "Tab" || !isMcpEditorOpen()) return;
  const editor = $("mcp-editor");
  if (!editor) return;
  const focusable = [...editor.querySelectorAll<HTMLElement>(
    "button:not([disabled]), input:not([disabled]):not([readonly]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])"
  )].filter((element) => !element.classList.contains("hidden") && element.offsetParent !== null);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable.at(-1) as HTMLElement;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
export function isMcpEditorOpen(): boolean {
  return !$("mcp-editor-mask")?.classList.contains("hidden");
}

export async function saveMcpFromForm(): Promise<void> {
  const wasEditing = Boolean(editingId);
  const id = inputValue("mcp-id").trim();
  const command = inputValue("mcp-command").trim();
  if (!id) { showMcpStatus("服务器标识不能为空", "err", true); return; }
  if (!command) { showMcpStatus("启动命令不能为空", "err", true); return; }
  let args: string[];
  try { args = parseArgs(inputValue("mcp-args").trim()); }
  catch (err) { showMcpStatus(`✗ ${(err as Error).message}`, "err", true); return; }
  const body = {
    name: inputValue("mcp-name").trim(),
    command,
    args,
    requireApproval: ($("mcp-approval") as HTMLInputElement | null)?.checked !== false,
  };
  const save = $("mcp-editor-save") as HTMLButtonElement | null;
  if (save) save.disabled = true;
  try {
    const data = editingId
      ? await api<McpStateResponse & { server: McpServerStatus }>(`/api/mcp/${encodeURIComponent(editingId)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
      : await api<McpStateResponse & { server: McpServerStatus; created?: boolean }>("/api/mcp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, ...body }),
        });
    applyState(data);
    closeMcpEditor();
    showMcpStatus(`✓ 已${wasEditing ? "更新" : "添加"} MCP 服务器「${data.server.name}」`, "ok");
  } catch (err) {
    showMcpStatus(`✗ ${(err as Error).message}`, "err", true);
  } finally {
    if (save) save.disabled = false;
  }
}

export async function deleteMcpFromEditor(): Promise<void> {
  const server = currentServers.find((item) => item.id === editingId);
  if (!server) { showMcpStatus("请先选择要删除的服务器", "err", true); return; }
  if (!(await uiConfirm(`删除 MCP server「${server.name}」？其工具会从 Agent 中移除。`, {
    title: "删除 MCP server", okText: "删除", danger: true,
  }))) return;
  try {
    const data = await api<McpStateResponse>(`/api/mcp/${encodeURIComponent(server.id)}`, { method: "DELETE" });
    applyState(data);
    closeMcpEditor();
    showMcpStatus(`已删除 MCP 服务器「${server.name}」`, "ok");
  } catch (err) {
    showMcpStatus(`✗ ${(err as Error).message}`, "err", true);
  }
}

export async function importMcpFromFile(files: FileList | null): Promise<void> {
  const input = $("mcp-import-file") as HTMLInputElement | null;
  const file = files?.[0];
  if (!file) return;
  try {
    if (file.size > MAX_IMPORT_BYTES) throw new Error("JSON 文件超过 1MB");
    const raw = JSON.parse(await file.text()) as unknown;
    let data = await api<McpImportResponse>("/api/mcp/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: raw, overwrite: false }),
    });
    if (data.conflicts?.length) {
      const overwrite = await uiConfirm(`以下 MCP server 已存在，是否覆盖？\n${data.conflicts.join("、")}`, {
        title: "覆盖 MCP 配置", okText: "覆盖", danger: true,
      });
      if (!overwrite) {
        showMcpStatus("已取消导入，现有配置未修改", "");
        return;
      }
      data = await api<McpImportResponse>("/api/mcp/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: raw, overwrite: true }),
      });
    }
    applyState(data);
    showMcpStatus(`✓ 已导入 ${data.imported?.length || 0} 个，覆盖 ${data.overwritten?.length || 0} 个 MCP server`, "ok");
  } catch (err) {
    showMcpStatus(`✗ ${(err as Error).message}`, "err");
  } finally {
    if (input) input.value = "";
  }
}

export function bindMcpSettings(): void {
  const globalToggle = $("mcp-global-enabled") as HTMLInputElement | null;
  globalToggle?.addEventListener("change", () => { void toggleGlobal(globalToggle); });
  $("mcp-add-btn")?.addEventListener("click", () => openMcpEditor());
  $("mcp-import-btn")?.addEventListener("click", () => ($("mcp-import-file") as HTMLInputElement | null)?.click());
  $("mcp-import-file")?.addEventListener("change", (event) => {
    void importMcpFromFile((event.currentTarget as HTMLInputElement | null)?.files ?? null);
  });
  $("mcp-refresh-btn")?.addEventListener("click", () => { void refreshMcp().catch((err) => showMcpStatus(`✗ ${(err as Error).message}`, "err")); });
  $("mcp-editor-close")?.addEventListener("click", closeMcpEditor);
  $("mcp-editor-cancel")?.addEventListener("click", closeMcpEditor);
  $("mcp-editor-save")?.addEventListener("click", () => { void saveMcpFromForm(); });
  $("mcp-editor-delete")?.addEventListener("click", () => { void deleteMcpFromEditor(); });
  $("mcp-editor-mask")?.addEventListener("click", (event) => {
    if (event.target === $("mcp-editor-mask")) closeMcpEditor();
  });
  $("mcp-editor-mask")?.addEventListener("keydown", (event) => trapEditorFocus(event as KeyboardEvent));

  for (const id of ["mcp-id", "mcp-name", "mcp-command", "mcp-args"]) {
    $(id)?.addEventListener("keydown", (event) => {
      if ((event as KeyboardEvent).key === "Enter") {
        event.preventDefault();
        void saveMcpFromForm();
      }
    });
  }
}