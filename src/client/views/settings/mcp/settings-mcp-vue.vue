<!--
  settings-mcp-vue.vue — MCP Servers 面板（框架迁移 M4 批次 4.2）
  ============================================================
  职责：全局暂停、服务器列表 / 展开、单服务器启停、添加编辑、JSON 导入与
  连接测试。DOM 契约与 h() 版逐 id/类名一致（mcp-* / .mcp-server-row /
  aria-label 文案），mcp.spec.ts 零改动迁移。
  立场：
  - 服务器名、命令、工具名等外部内容全部走插值文本，无 HTML 注入面；
  - 网页编辑走 PATCH，只改可见字段，不覆盖 JSON 导入的 env / cwd；
  - 测试连接前就地给出「测试中」（spawn 握手可达一分钟）。
-->
<script setup lang="ts">
import { Button, Input, Switch, Upload } from "antdv-next";
import AntdvProvider from "../../../ui/antdv-provider.vue";
import { computed, onMounted, onUnmounted, reactive, ref } from "vue";
import { useMcpStore, type McpServerStatus } from "../../../stores/settings/mcp/mcp.js";
import { showMcpStatus, registerMcpEditorOpenHook, registerMcpCloseHook } from "./settings-mcp.js";
import { uiConfirm } from "../../../ui/dialog.js";
import {
  formatMcpCommandLine,
  inferMcpServerId,
  parseMcpCommandLine,
  quoteMcpArg,
} from "../../../modules/mcp-command.js";

const MAX_IMPORT_BYTES = 1_000_000;

const store = useMcpStore();

/** 展开状态：本地 UI 状态，不进 store。 */
const expanded = reactive<Record<string, boolean>>({});
/** 编辑器表单（打开时填充）。 */
const editor = reactive({
  open: false,
  editingId: null as string | null,
  id: "",
  name: "",
  command: "",
  args: "",
  commandLine: "",
  approval: true,
  cwdNote: "",
});
const saving = ref(false);
const testingId = ref<string | null>(null);
/** 正在切换启停的服务器 id（antdv Switch 改为受控，用它做 loading 与禁用）。 */
const togglingId = ref<string | null>(null);
/** 全局开关的切换中标记。 */
const togglingGlobal = ref(false);
const importFileInput = ref<HTMLInputElement | null>(null);
const editorMask = ref<HTMLElement | null>(null);
const editorEl = ref<HTMLElement | null>(null);
let editorReturnFocus: HTMLElement | null = null;

const summaryText = computed(() => {
  const enabledCount = store.servers.filter((server) => server.enabled).length;
  return store.servers.length
    ? `共 ${store.servers.length} 个服务器 · ${enabledCount} 个已启用`
    : "共 0 个服务器";
});

function statusMeta(server: McpServerStatus): { label: string; icon: "CircleCheck" | "CircleAlert" | "CircleX"; tone: string } {
  if (!server.enabled) return { label: "已停用", icon: "CircleX", tone: "muted" };
  if (server.connected) return { label: "已连接", icon: "CircleCheck", tone: "ok" };
  if (server.error) return { label: "连接失败", icon: "CircleAlert", tone: "warn" };
  return { label: "待测试", icon: "CircleAlert", tone: "warn" };
}

function commandText(server: McpServerStatus): string {
  return `$ ${server.command} ${server.args.join(" ")}`.trim();
}

function advancedMeta(server: McpServerStatus): string {
  return [
    server.cwd ? `工作目录：${server.cwd}` : "",
    server.envKeys.length ? `环境变量：${server.envKeys.join("、")}` : "",
  ].filter(Boolean).join(" · ");
}

function toggleExpanded(server: McpServerStatus): void {
  expanded[server.id] = !expanded[server.id];
}

/**
 * 切换单个 MCP 服务器。
 * 改接 antdv Switch 后不再从 `event.target.checked` 取值 —— 组件库的开关是
 * `<button role="switch">`，没有原生 checked；状态一律由 v-model 驱动，
 * handler 只接收目标值。失败时界面靠 togglingId 复位，store 仍是权威状态。
 */
async function toggleServer(server: McpServerStatus, next: boolean): Promise<void> {
  togglingId.value = server.id;
  try {
    await store.toggleServer(server, next);
    showMcpStatus(`${next ? "已启用" : "已停用"} MCP 服务器「${server.name}」`, "ok");
  } catch (err) {
    showMcpStatus(`✗ ${(err as Error).message}`, "err");
  } finally {
    togglingId.value = null;
  }
}

async function toggleGlobal(next: boolean): Promise<void> {
  togglingGlobal.value = true;
  try {
    await store.toggleGlobal(next);
    showMcpStatus(next ? "MCP 工具已恢复" : "MCP 工具已暂停，配置保持不变", "ok");
  } catch (err) {
    showMcpStatus(`✗ ${(err as Error).message}`, "err");
  } finally {
    togglingGlobal.value = false;
  }
}

async function testServer(server: McpServerStatus): Promise<void> {
  testingId.value = server.id;
  store.testFeedback[server.id] = { tone: "pending", text: "正在测试连接…" };
  showMcpStatus(`正在测试「${server.name}」连接…`);
  try {
    const status = await store.testServer(server);
    store.testFeedback[server.id] = status.connected
      ? { tone: "ok", text: `✓ 测试通过 · ${status.tools.length} 个工具` }
      : { tone: "err", text: `✗ 测试失败：${status.error || "未知原因"}` };
    if (status.connected) {
      expanded[server.id] = true;
      showMcpStatus(`✓ 「${server.name}」连接成功，发现 ${status.tools.length} 个工具`, "ok");
    } else {
      showMcpStatus(`✗ 「${server.name}」连接失败：${status.error || "未知原因"}`, "err");
    }
  } catch (err) {
    const message = (err as Error).message;
    store.testFeedback[server.id] = { tone: "err", text: `✗ 测试失败：${message}` };
    showMcpStatus(`✗ ${message}`, "err");
  } finally {
    testingId.value = null;
  }
}

// ---------------------------------------------------------------------------
// 编辑器：快速命令解析 / 手动字段 / 保存 / 删除
// ---------------------------------------------------------------------------

const commandPreview = computed(() => {
  if (!editor.command.trim()) return "";
  try {
    return formatMcpCommandLine(editor.command.trim(), parseArgs(editor.args.trim())).trim();
  } catch {
    return "";
  }
});

/** 引号感知的参数拆分（与 h() 版 parseArgs 同语义）。 */
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

function applyQuickCommandLine(raw: string, quiet = false): boolean {
  if (!raw.trim()) {
    if (!quiet) showMcpStatus("请先粘贴完整启动命令", "err", true);
    return false;
  }
  try {
    const parsed = parseMcpCommandLine(raw);
    editor.command = parsed.command;
    editor.args = parsed.args.map(quoteMcpArg).join(" ");
    const inferredId = inferMcpServerId(parsed.command, parsed.args);
    if (!editor.editingId && !editor.id.trim()) editor.id = inferredId;
    if (!editor.name.trim()) editor.name = editor.id.trim() || inferredId;
    editor.commandLine = formatMcpCommandLine(parsed.command, parsed.args);
    if (!quiet) showMcpStatus(`已解析：${parsed.command} · ${parsed.args.length} 个参数`, "ok", true);
    return true;
  } catch (err) {
    if (!quiet) showMcpStatus(`解析失败：${(err as Error).message}`, "err", true);
    return false;
  }
}

function onCommandLinePaste(): void {
  setTimeout(() => {
    if (editor.commandLine.trim()) applyQuickCommandLine(editor.commandLine, true);
  }, 0);
}

function onCommandLineBlur(): void {
  if (editor.commandLine.trim() && !editor.command.trim()) {
    applyQuickCommandLine(editor.commandLine, true);
  }
}

function syncCommandLineFromFields(): void {
  if (!editor.command.trim()) return;
  try {
    const args = parseArgs(editor.args.trim());
    editor.commandLine = formatMcpCommandLine(editor.command, args);
  } catch {
    /* 拆分失败：预览清空由 computed 兜底 */
  }
}

function openEditor(server: McpServerStatus | null = null): void {
  editorReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  editor.editingId = server?.id ?? null;
  editor.id = server?.id ?? "";
  editor.name = server && server.name !== server.id ? server.name : "";
  editor.command = server?.command ?? "";
  editor.args = server?.args.join(" ") ?? "";
  editor.commandLine = server ? `$ ${formatMcpCommandLine(server.command, server.args)}` : "";
  editor.approval = server?.requireApproval !== false;
  editor.cwdNote = server
    ? [server.cwd ? `工作目录 ${server.cwd}` : "", server.envKeys.length ? `环境变量 ${server.envKeys.join("、")}` : ""]
        .filter(Boolean).join(" · ")
    : "";
  showMcpStatus("", "", true);
  editor.open = true;
  requestAnimationFrame(() => (server ? document.getElementById("mcp-name") : document.getElementById("mcp-command-line"))?.focus());
}

function closeEditor(): void {
  editor.open = false;
  editor.editingId = null;
  showMcpStatus("", "", true);
  const target = editorReturnFocus;
  editorReturnFocus = null;
  if (target?.isConnected) target.focus();
  else (document.getElementById("mcp-add-btn") as HTMLButtonElement | null)?.focus();
}

function trapEditorFocus(event: KeyboardEvent): void {
  if (event.key !== "Tab" || !editor.open) return;
  const container = editorEl.value;
  if (!container) return;
  const focusable = [...container.querySelectorAll<HTMLElement>(
    "button:not([disabled]), input:not([disabled]):not([readonly]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])",
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

async function saveEditor(): Promise<void> {
  const wasEditing = Boolean(editor.editingId);
  if (editor.commandLine.trim()) {
    if (!applyQuickCommandLine(editor.commandLine, false)) return;
  }
  const id = editor.id.trim();
  const command = editor.command.trim();
  if (!id) { showMcpStatus("服务器标识不能为空", "err", true); return; }
  if (!command) { showMcpStatus("启动命令不能为空", "err", true); return; }
  let args: string[];
  try { args = parseArgs(editor.args.trim()); }
  catch (err) { showMcpStatus(`✗ ${(err as Error).message}`, "err", true); return; }
  saving.value = true;
  try {
    const server = await store.save({
      // 新建时 id 取自表单标识输入框（editingId 只在编辑已有服务器时有值）
      ...(editor.editingId ? {} : { id }),
      name: editor.name.trim(),
      command,
      args,
      requireApproval: editor.approval !== false,
    }, editor.editingId ?? undefined);
    closeEditor();
    showMcpStatus(`✓ 已${wasEditing ? "更新" : "添加"} MCP 服务器「${server.name}」`, "ok");
  } catch (err) {
    showMcpStatus(`✗ ${(err as Error).message}`, "err", true);
  } finally {
    saving.value = false;
  }
}

async function deleteFromEditor(): Promise<void> {
  const server = store.servers.find((item) => item.id === editor.editingId);
  if (!server) { showMcpStatus("请先选择要删除的服务器", "err", true); return; }
  if (!(await uiConfirm(`删除 MCP server「${server.name}」？其工具会从 Agent 中移除。`, {
    title: "删除 MCP server", okText: "删除", danger: true,
  }))) return;
  try {
    await store.remove(server.id);
    closeEditor();
    showMcpStatus(`已删除 MCP 服务器「${server.name}」`, "ok");
  } catch (err) {
    showMcpStatus(`✗ ${(err as Error).message}`, "err", true);
  }
}

function pickImportFile(): void {
  document.getElementById("mcp-import-file")?.click();
}

/**
 * antdv Upload 的 beforeUpload：返回 false 表示「不上传」，只做本地解析。
 * 与原 @change 版本的区别只是文件来源 —— 不再从 DOM 读 input.files。
 */
function beforeImportUpload(file: File): boolean {
  void importFromFile(file);
  return false;
}

async function importFromFile(file: File): Promise<void> {
  if (!file) return;
  try {
    if (file.size > MAX_IMPORT_BYTES) throw new Error("JSON 文件超过 1MB");
    const raw = JSON.parse(await file.text()) as unknown;
    let result = await store.importConfig(raw, false);
    if (result.conflicts?.length) {
      const overwrite = await uiConfirm(`以下 MCP server 已存在，是否覆盖？\n${result.conflicts.join("、")}`, {
        title: "覆盖 MCP 配置", okText: "覆盖", danger: true,
      });
      if (!overwrite) {
        showMcpStatus("已取消导入，现有配置未修改", "");
        return;
      }
      result = await store.importConfig(raw, true);
    }
    showMcpStatus(`✓ 已导入 ${result.imported?.length || 0} 个，覆盖 ${result.overwritten?.length || 0} 个 MCP server`, "ok");
  } catch (err) {
    showMcpStatus(`✗ ${(err as Error).message}`, "err");
  }
}

// 壳级 Esc 分流依赖编辑器开关状态与外部关闭（main.ts）
onMounted(() => {
  registerMcpEditorOpenHook(() => editor.open);
  registerMcpCloseHook(closeEditor);
  // 进入分区时拉取服务器目录（与 h() 版 refreshMcp 同语义）
  void store.refresh().catch((err: Error) => showMcpStatus(`✗ ${err.message}`, "err"));
});
onUnmounted(() => {
  registerMcpEditorOpenHook(null);
  registerMcpCloseHook(null);
});
</script>

<template>
  <AntdvProvider>
  <div class="mcp-page-head">
    <div>
      <h2 id="mcp-title"><i class="ui-icon" data-icon="Server" aria-hidden="true"></i> MCP Servers</h2>
    </div>
    <span id="mcp-summary" class="mcp-summary">{{ summaryText }}</span>
  </div>

  <div class="field-label mcp-section-label">导入设置</div>
  <section class="mcp-import-card" aria-labelledby="mcp-import-title">
    <div class="mcp-import-copy">
      <div class="mcp-import-title-row">
        <h3 id="mcp-import-title">启用 MCP 工具</h3>
        <span id="mcp-global-state" class="mcp-state-pill" :class="store.enabled ? 'ok' : 'muted'">{{ store.enabled ? "已启用" : "已暂停" }}</span>
      </div>
      <p>关闭后暂停所有 MCP 连接和工具注入，但保留服务器配置，便于故障时快速止损。</p>
    </div>
    <div class="mcp-import-actions">
      <Button id="mcp-import-btn" class="ghost-btn small" @click="pickImportFile">
        <i class="ui-icon" data-icon="Upload" aria-hidden="true"></i> 导入 .mcp.json
      </Button>
      <Switch
        id="mcp-global-enabled"
        aria-label="启用 MCP 工具"
        :checked="store.enabled"
        :loading="togglingGlobal"
        @update:checked="toggleGlobal"
      />
    </div>
  </section>
  <!-- antdv Upload 不透传 class/id 到根元素：用外层 div 隐藏，
       触发靠 pickImportFile() 点内部 input[type=file] -->
  <div class="hidden">
    <Upload
      id="mcp-import-file"
      accept=".json,application/json"
      :show-upload-list="false"
      :before-upload="beforeImportUpload"
      aria-label="选择 MCP JSON 配置"
    />
  </div>

  <div class="field-label mcp-section-label">已配置的 MCP Servers</div>
  <section class="mcp-server-panel" aria-labelledby="mcp-servers-title">
    <div class="mcp-server-head">
      <div>
        <h3 id="mcp-servers-title">MCP Servers 管理</h3>
        <p>查看连接状态、测试工具，并为每个服务器单独启停。</p>
      </div>
      <div class="mcp-server-actions">
        <Button id="mcp-refresh-btn" class="mcp-icon-btn" aria-label="刷新 MCP 服务器" title="刷新 MCP 服务器" @click="store.refresh().catch((err: Error) => showMcpStatus(`✗ ${err.message}`, 'err'))"
        >
          <i class="ui-icon" data-icon="RefreshCw" aria-hidden="true"></i>
        </Button>
        <Button id="mcp-add-btn" class="ghost-btn small mcp-add-btn" @click="openEditor()">
          <i class="ui-icon" data-icon="Plus" aria-hidden="true"></i> 添加
        </Button>
      </div>
    </div>
    <div id="mcp-list" class="mcp-server-list" :class="{ 'global-paused': !store.enabled }">
      <div v-if="!store.servers.length" class="mcp-empty-state">
        <i class="ui-icon" data-icon="Server" aria-hidden="true" style="--icon-size: 28px"></i>
        <h3>还没有 MCP Servers</h3>
        <p>添加一个 stdio MCP server，或导入现成的 .mcp.json 配置。</p>
        <div class="mcp-empty-actions">
          <Button class="ghost-btn small mcp-add-btn" @click="openEditor()">
            <i class="ui-icon" data-icon="Plus" aria-hidden="true" style="--icon-size: 14px"></i> 添加第一个服务器
          </Button>
        </div>
      </div>
      <template v-else>
        <article
          v-for="(server, index) in store.servers"
          :key="server.id"
          class="mcp-server-row"
          :class="{ disabled: !server.enabled, 'globally-paused': !store.enabled }"
          :data-mcp-id="server.id"
        >
          <Button class="mcp-expand-btn" :aria-label="`${expanded[server.id] ? '收起' : '展开'} MCP 服务器 ${server.name}`" :aria-expanded="String(Boolean(expanded[server.id]))" @click="toggleExpanded(server)">
            <i class="ui-icon" :data-icon="expanded[server.id] ? 'ChevronDown' : 'ChevronRight'" aria-hidden="true" style="--icon-size: 15px"></i>
          </Button>
          <span class="mcp-server-icon" :class="`tone-${index % 5}`" aria-hidden="true">{{ server.name.slice(0, 1).toUpperCase() || "M" }}</span>
          <div class="mcp-server-main">
            <div class="mcp-server-title-row">
              <strong class="mcp-server-name">{{ server.name }}</strong>
              <span class="mcp-server-status" :class="statusMeta(server).tone">
                <i class="ui-icon" :data-icon="statusMeta(server).icon" aria-hidden="true" style="--icon-size: 13px"></i>{{ statusMeta(server).label }}
              </span>
            </div>
            <div class="mcp-server-subtitle">
              <span>{{ server.id }}</span>
              <span>{{ server.tools.length ? `${server.tools.length} 个工具` : server.connected ? "暂无工具" : "未连接" }}</span>
            </div>
          </div>
          <div class="mcp-server-actions">
            <Button class="mcp-icon-btn" :aria-label="`编辑 MCP 服务器 ${server.name}`" title="编辑服务器" @click.stop="openEditor(server)">
              <i class="ui-icon" data-icon="Settings" aria-hidden="true" style="--icon-size: 15px"></i>
            </Button>
            <Switch
              :aria-label="`启用 MCP 服务器 ${server.name}`"
              :checked="server.enabled"
              :loading="togglingId === server.id"
              @update:checked="(next: boolean) => toggleServer(server, next)"
            />
          </div>
          <div class="mcp-server-details" :class="{ hidden: !expanded[server.id] }">
            <div class="mcp-command-row">
              <span class="mcp-detail-label">启动命令</span>
              <code class="mcp-command">{{ commandText(server) }}</code>
            </div>
            <div class="mcp-detail-grid">
              <div>
                <span class="mcp-detail-label">远端工具{{ server.tools.length ? ` · ${server.tools.length}` : "" }}</span>
                <div v-if="server.tools.length" class="mcp-tool-chips">
                  <span v-for="tool in server.tools" :key="tool.name" class="mcp-tool-chip" :title="tool.description || tool.name">{{ tool.name }}</span>
                </div>
                <p v-else class="mcp-detail-empty">{{ server.error || "尚未测试连接，暂无远端工具信息。" }}</p>
              </div>
              <div>
                <span class="mcp-detail-label">运行策略</span>
                <p class="mcp-policy">{{ `${server.requireApproval ? "调用前审批" : "免审批直接执行"} · ${server.connected ? "连接可用" : "尚无活跃连接"}` }}</p>
                <p v-if="advancedMeta(server)" class="mcp-advanced-meta">{{ advancedMeta(server) }}</p>
              </div>
            </div>
            <div class="mcp-detail-actions">
              <span
                v-if="store.testFeedback[server.id]"
                class="mcp-test-result"
                :class="store.testFeedback[server.id]?.tone"
              >{{ store.testFeedback[server.id]?.text }}</span>
              <Button class="ghost-btn small" :aria-label="`测试 MCP 服务器 ${server.name}`" :disabled="testingId === server.id" :aria-busy="testingId === server.id ? 'true' : undefined" :class="{ 'is-busy': testingId === server.id }" @click="testServer(server)">
                <i class="ui-icon" data-icon="RefreshCw" aria-hidden="true" style="--icon-size: 13px"></i>
                <span class="mcp-test-label">{{ testingId === server.id ? "测试中…" : "测试连接" }}</span>
              </Button>
            </div>
          </div>
        </article>
      </template>
    </div>
  </section>
  <div id="mcp-status" class="settings-status" role="status" aria-live="polite"></div>

  <div
    id="mcp-editor-mask"
    ref="editorMask"
    class="mcp-editor-mask"
    :class="{ hidden: !editor.open }"
    @click.self="closeEditor"
    @keydown="trapEditorFocus"
  >
    <div id="mcp-editor" ref="editorEl" class="mcp-editor" role="dialog" aria-modal="true" aria-labelledby="mcp-editor-title">
      <div class="mcp-editor-head">
        <div>
          <h2 id="mcp-editor-title">{{ editor.editingId ? "编辑 MCP Server" : "添加 MCP Server" }}</h2>
          <p id="mcp-editor-sub">{{ editor.editingId
            ? "只更新当前可见字段；通过 JSON 导入的 env / cwd 会原样保留。"
            : "优先粘贴完整启动命令，自动拆分后保存；也可在下方手动调整。" }}</p>
        </div>
        <Button id="mcp-editor-close" class="mcp-icon-btn" aria-label="关闭 MCP 编辑器" title="关闭" @click="closeEditor">
          <i class="ui-icon" data-icon="X" aria-hidden="true"></i>
        </Button>
      </div>

      <section class="mcp-quick-command" aria-labelledby="mcp-quick-command-label">
        <label class="field">
          <span id="mcp-quick-command-label" class="field-label">完整启动命令 <em class="key-state">粘贴后自动拆分，支持 $ 前缀与引号</em></span>
          <div class="mcp-command-parse-row">
            <Input
              id="mcp-command-line"
              v-model:value="editor.commandLine"
              aria-label="完整 MCP 启动命令"
              type="text"
              spellcheck="false"
              autocomplete="off"
              placeholder="$ npx -y @modelcontextprotocol/server-postgres postgresql://user:pass@host:5432/db"
              @keydown.enter.prevent="applyQuickCommandLine(editor.commandLine, false)"
              @paste="onCommandLinePaste"
              @blur="onCommandLineBlur"
            />
            <Button id="mcp-command-parse" class="ghost-btn small" @click="applyQuickCommandLine(editor.commandLine, false)">解析</Button>
          </div>
          <small class="mcp-command-hint">只做命令与参数拆分，不执行命令；Windows 下 npx/npm/pnpm 会自动兼容 .cmd。</small>
        </label>
        <div id="mcp-command-preview" class="mcp-command-preview" :class="{ hidden: !commandPreview }">
          <span>解析结果</span>
          <code id="mcp-command-preview-text">{{ commandPreview ? `$ ${commandPreview}` : "" }}</code>
        </div>
      </section>
      <div class="mcp-form-divider"><span>或手动编辑</span></div>

      <div class="mcp-form-grid">
        <label class="field">
          <span class="field-label">服务器标识</span>
          <Input id="mcp-id" v-model:value="editor.id" :readonly="Boolean(editor.editingId)" aria-label="MCP 服务器标识" type="text" spellcheck="false" placeholder="例如 filesystem" @keydown.enter.prevent="saveEditor" />
        </label>
        <label class="field">
          <span class="field-label">显示名称</span>
          <Input id="mcp-name" v-model:value="editor.name" aria-label="MCP 服务器名称" type="text" spellcheck="false" placeholder="留空则使用标识" @keydown.enter.prevent="saveEditor" />
        </label>
      </div>
      <label class="field">
        <span class="field-label">可执行命令</span>
        <Input id="mcp-command" v-model:value="editor.command" aria-label="MCP 启动命令" type="text" spellcheck="false" placeholder="例如 npx、node、uvx" @keydown.enter.prevent="saveEditor" @change="syncCommandLineFromFields" />
      </label>
      <label class="field">
        <span class="field-label">命令参数 <em class="key-state">空格分隔；含空格的参数请用双引号包住</em></span>
        <Input id="mcp-args" v-model:value="editor.args" aria-label="MCP 启动参数" type="text" spellcheck="false" placeholder='例如 -y @modelcontextprotocol/server-filesystem "D:\data"' @keydown.enter.prevent="saveEditor" @change="syncCommandLineFromFields" />
      </label>
      <div id="mcp-cwd-note" class="mcp-advanced-note" :class="{ hidden: !editor.cwdNote }">高级配置：{{ editor.cwdNote }}。网页编辑不会修改这些字段。</div>
      <label class="mcp-approval-row">
        <span>
          <strong>调用前需要审批</strong>
          <small>推荐开启。关闭后该服务器的工具会直接执行，风险由你承担。</small>
        </span>
        <Switch id="mcp-approval" v-model:checked="editor.approval" aria-label="MCP 调用前需要审批" />
      </label>
      <div id="mcp-editor-status" class="settings-status" role="status" aria-live="polite"></div>
      <div class="mcp-editor-actions">
        <Button id="mcp-editor-delete" size="small" danger :class="{ hidden: !editor.editingId }" @click="deleteFromEditor">删除服务器</Button>
        <span class="mcp-editor-spacer"></span>
        <Button id="mcp-editor-cancel" size="small" @click="closeEditor">取消</Button>
        <Button id="mcp-editor-save" size="small" type="primary" :loading="saving" @click="saveEditor">保存服务器</Button>
      </div>
    </div>
  </div>
  </AntdvProvider>
</template>
