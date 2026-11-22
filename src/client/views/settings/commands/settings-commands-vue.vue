<!--
  settings-commands-vue.vue — 自定义命令双栏管理页（框架迁移 M4 批次 4.1 完整 Vue 化）
  ============================================================
  职责：命令检索、选择、创建、编辑、改名与删除，写回经 stores/commands.ts，
  保存/删除后斜杠菜单缓存同步由 store 内 loadUserCommands 完成。
  契约：DOM 结构与 h() 版一致（#commands-* / #cmd-* id、.command-card 结构、
  aria-label 文案），e2e 零改动迁移。
  立场：
  - 命令只是提示词模板：模板与列表全部用插值文本渲染，无 HTML 注入面；
  - 编辑未保存时切换/关闭必须 uiConfirm 确认（legacy 对话框，e2e 依赖其选择器）；
  - 字段错误就地呈现（.ui-field-error + aria-invalid + aria-describedby 关联）。

  antdv 接入说明：文本字段用 Input、模板用 Input.TextArea（仍是真实 <textarea>，
  光标插入变量依赖的 selectionStart/setSelectionRange 照常工作）、
  新建/保存/取消用 Button。字段错误仍自建 role=alert（FormItem help 无该语义）。
  列表卡片与搜索框保留原结构：.command-card / #commands-search 是 e2e 锚点。
-->
<script setup lang="ts">
import { computed, nextTick, onUnmounted, reactive, ref } from "vue";
import { onMounted } from "vue";
import { Button, Input } from "antdv-next";
import type { UserCommandItem } from "../../../composer/menu.js";
import { useCommandsStore, type CommandPayload } from "../../../stores/settings/commands/commands.js";
import { cmdStatus, registerCommandsReset } from "./settings-commands.js";
import { uiConfirm } from "../../../ui/dialog.js";
import AntdvProvider from "../../../ui/antdv-provider.vue";

/** 与后端 commands 校验一致的本地限制（超过先在本地拦截）。 */
const MAX_TEMPLATE_CHARS = 8_000;
const MAX_NAME_CHARS = 40;
const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i;
const RESERVED_NAMES = new Set(["compact"]);

type EditorMode = "closed" | "create" | "edit";

const store = useCommandsStore();
const searchTerm = ref("");
const editorMode = ref<EditorMode>("closed");
const editingOriginalName = ref("");
const saving = ref(false);
const deletingName = ref<string | null>(null);
const form = reactive({ name: "", title: "", desc: "", template: "" });
const baseline = reactive({ name: "", title: "", desc: "", template: "" });
const errors = reactive({ name: "", template: "" });

/** 进入设置分区时由 refreshCommands 触发 reset 钩子：编辑器回到选择态，不残留上次输入。 */
onMounted(() => registerCommandsReset(resetView));
onUnmounted(() => registerCommandsReset(null));

const visibleCommands = computed<UserCommandItem[]>(() => {
  const query = searchTerm.value.trim().toLowerCase();
  if (!query) return store.commands;
  return store.commands.filter((command) =>
    command.name.toLowerCase().includes(query)
    || (command.title ?? "").toLowerCase().includes(query)
    || (command.description ?? "").toLowerCase().includes(query)
    || command.template.toLowerCase().includes(query),
  );
});

const countText = computed(() => searchTerm.value.trim()
  ? `${visibleCommands.value.length} / ${store.commands.length} 个命令`
  : `${store.commands.length} 个命令`);

const isDirty = computed(() => {
  if (editorMode.value === "closed") return false;
  return form.name !== baseline.name
    || form.title !== baseline.title
    || form.desc !== baseline.desc
    || form.template !== baseline.template;
});

function resetView(): void {
  editorMode.value = "closed";
  editingOriginalName.value = "";
  searchTerm.value = "";
  Object.assign(form, { name: "", title: "", desc: "", template: "" });
  Object.assign(baseline, { name: "", title: "", desc: "", template: "" });
  errors.name = "";
  errors.template = "";
}

async function confirmDiscardIfDirty(): Promise<boolean> {
  if (!isDirty.value) return true;
  const confirmed = await uiConfirm("当前命令有未保存的修改，确定放弃吗？", {
    title: "放弃未保存的修改",
    okText: "放弃修改",
    danger: true,
  });
  return Boolean(confirmed);
}

function fillEditor(command: UserCommandItem | null): void {
  Object.assign(form, {
    name: command?.name ?? "",
    title: command?.title ?? "",
    desc: command?.description ?? "",
    template: command?.template ?? "",
  });
  Object.assign(baseline, form);
  errors.name = "";
  errors.template = "";
}

function focusName(): void {
  void nextTick(() => document.getElementById("cmd-name")?.focus());
}

async function openCreateEditor(): Promise<void> {
  if (saving.value) return;
  if (!(await confirmDiscardIfDirty())) return;
  editorMode.value = "create";
  editingOriginalName.value = "";
  fillEditor(null);
  cmdStatus("", "");
  focusName();
}

async function openEditEditor(command: UserCommandItem): Promise<void> {
  if (saving.value) return;
  if (editorMode.value === "edit" && editingOriginalName.value === command.name) {
    focusName();
    return;
  }
  if (!(await confirmDiscardIfDirty())) return;
  editorMode.value = "edit";
  editingOriginalName.value = command.name;
  fillEditor(command);
  cmdStatus("", "");
  focusName();
}

function collapseEditor(): void {
  resetView();
}

async function closeEditor(): Promise<void> {
  if (editorMode.value === "closed" || saving.value) return;
  if (!(await confirmDiscardIfDirty())) return;
  collapseEditor();
  document.getElementById("cmd-new-btn")?.focus();
}

function validateForm(): boolean {
  const name = form.name.trim();
  const template = form.template;
  errors.name = "";
  errors.template = "";
  let firstInvalidId = "";

  if (!name) {
    errors.name = "命令名不能为空";
    firstInvalidId = "cmd-name";
  } else if (name.length > MAX_NAME_CHARS) {
    errors.name = `命令名不能超过 ${MAX_NAME_CHARS} 个字符`;
    firstInvalidId = "cmd-name";
  } else if (!NAME_RE.test(name)) {
    errors.name = "命令名只能用字母、数字、下划线和短横线，且以字母或数字开头";
    firstInvalidId = "cmd-name";
  } else if (RESERVED_NAMES.has(name.toLowerCase())) {
    errors.name = `「${name}」是内置命令名，请换一个`;
    firstInvalidId = "cmd-name";
  } else if (store.commands.some((command) =>
    command.name === name && (editorMode.value === "create" || command.name !== editingOriginalName.value),
  )) {
    errors.name = `命令「${name}」已存在，请直接编辑现有命令或换一个名字`;
    firstInvalidId = "cmd-name";
  }

  if (!template.trim()) {
    errors.template = "提示词模板不能为空";
    if (!firstInvalidId) firstInvalidId = "cmd-template";
  } else if (template.length > MAX_TEMPLATE_CHARS) {
    errors.template = `提示词模板不能超过 ${MAX_TEMPLATE_CHARS} 个字符`;
    if (!firstInvalidId) firstInvalidId = "cmd-template";
  }

  if (firstInvalidId) {
    cmdStatus("请先修正表单中的错误", "err");
    void nextTick(() => document.getElementById(firstInvalidId)?.focus());
    return false;
  }
  return true;
}

async function saveCommand(): Promise<void> {
  if (editorMode.value === "closed" || saving.value || !validateForm()) return;
  const originalName = editingOriginalName.value;
  const wasEditing = editorMode.value === "create" ? undefined : originalName;
  const payload: CommandPayload = {
    name: form.name.trim(),
    title: form.title.trim() || undefined,
    description: form.desc.trim() || undefined,
    template: form.template,
  };
  saving.value = true;
  try {
    const command = await store.save(payload, wasEditing);
    editorMode.value = "edit";
    editingOriginalName.value = command.name;
    searchTerm.value = "";
    fillEditor(command);
    cmdStatus(
      wasEditing ? `已保存 /${command.name}` : `已创建 /${command.name}，输入框敲 / 即可选到`,
      "ok",
    );
  } catch (err) {
    cmdStatus(`保存失败：${(err as Error).message}`, "err");
  } finally {
    saving.value = false;
  }
}

async function deleteCommand(command: UserCommandItem): Promise<void> {
  if (saving.value || deletingName.value) return;
  const editingThisCommand = editorMode.value === "edit" && editingOriginalName.value === command.name;
  const discardWarning = editingThisCommand && isDirty.value ? "\n当前未保存的修改也会丢失。" : "";
  const confirmed = await uiConfirm(`删除命令「/${command.name}」？${discardWarning}`, {
    title: "删除命令",
    okText: "删除",
    danger: true,
  });
  if (!confirmed) return;
  deletingName.value = command.name;
  try {
    await store.remove(command.name);
    if (editingThisCommand) collapseEditor();
    cmdStatus(`已删除 /${command.name}`, "ok");
  } catch (err) {
    cmdStatus(`删除失败：${(err as Error).message}`, "err");
  } finally {
    deletingName.value = null;
  }
}

/** 在光标处插入 {{token}} 并保持焦点（v-model 经 input 事件同步）。 */
function insertTemplateToken(token: string): void {
  const target = document.getElementById("cmd-template");
  if (!(target instanceof HTMLTextAreaElement)) return;
  const insert = `{{${token}}}`;
  const start = target.selectionStart ?? target.value.length;
  const end = target.selectionEnd ?? start;
  form.template = target.value.slice(0, start) + insert + target.value.slice(end);
  void nextTick(() => {
    target.setSelectionRange(start + insert.length, start + insert.length);
    target.focus();
  });
}

function onFormKeydown(event: KeyboardEvent): void {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    void saveCommand();
  } else if (event.key === "Escape") {
    event.preventDefault();
    void closeEditor();
  }
}
</script>

<template>
  <AntdvProvider>
  <div class="commands-page-head">
    <div class="commands-page-copy">
      <h2 id="commands-title"><i class="ui-icon" data-icon="Command" aria-hidden="true"></i> 自定义命令</h2>
    </div>
    <Button id="cmd-new-btn" class="ui-button ui-button-primary commands-new-btn" @click="openCreateEditor">
      <i class="ui-icon" data-icon="Plus" aria-hidden="true"></i> 新建命令
    </Button>
  </div>

  <div id="commands-status" class="settings-status" role="status" aria-live="polite"></div>

  <div class="commands-workspace">
    <aside class="commands-list-panel" aria-label="命令列表">
      <div class="commands-list-head">
        <label class="commands-search-box">
          <i class="ui-icon" data-icon="Search" aria-hidden="true"></i>
          <input
            id="commands-search"
            v-model="searchTerm"
            type="search"
            aria-label="搜索命令"
            placeholder="搜索命令、标题或说明"
            autocomplete="off"
          />
        </label>
        <span id="commands-count" class="commands-count">{{ countText }}</span>
      </div>
      <div id="commands-list" class="commands-list" aria-live="polite">
        <div v-if="!visibleCommands.length" class="commands-empty-state">
          <i
            class="ui-icon"
            :data-icon="store.commands.length > 0 ? 'Search' : 'Command'"
            aria-hidden="true"
            style="--icon-size: 26px"
          ></i>
          <h3>{{ store.commands.length > 0 ? "没有匹配的命令" : "还没有自定义命令" }}</h3>
          <p>{{ store.commands.length > 0
            ? "调整搜索词，或清空搜索查看全部命令。"
            : "把常用提示词保存成斜杠命令，之后在输入框敲 / 就能快速填入。" }}</p>
          <Button v-if="!store.commands.length" class="ghost-btn small" @click="openCreateEditor">新建第一条命令</Button>
        </div>
        <template v-else>
          <article
            v-for="command in visibleCommands"
            :key="command.name"
            class="command-card"
            :class="{ active: editorMode === 'edit' && editingOriginalName === command.name }"
          >
          <Button class="command-card-main" :aria-label="`打开命令 /${command.name}`" @click="openEditEditor(command)">
            <span class="command-card-syntax">/{{ command.name }}</span>
            <span class="command-card-title">{{ command.title || "未设置菜单显示名" }}</span>
            <span class="command-card-desc">{{ command.description || "未填写命令说明" }}</span>
            <span class="command-card-meta">{{ command.template.length }} 字符</span>
          </Button>
          <div class="command-card-actions">
            <Button class="command-card-action" :title="`编辑 /${command.name}`" :aria-label="`编辑命令 /${command.name}`" @click="openEditEditor(command)">
              <i class="ui-icon" data-icon="Pencil" aria-hidden="true" style="--icon-size: 14px"></i>
            </Button>
            <Button class="command-card-action delete" :title="`删除 /${command.name}`" :aria-label="`删除命令 /${command.name}`" :disabled="deletingName === command.name" @click="deleteCommand(command)">
              <i class="ui-icon" data-icon="Trash2" aria-hidden="true" style="--icon-size: 14px"></i>
            </Button>
          </div>
        </article>
        </template>
      </div>
    </aside>

    <section id="commands-editor" class="commands-editor-card" aria-label="命令编辑器">
      <div v-if="editorMode === 'closed'" id="commands-editor-empty" class="commands-editor-empty">
        <span class="commands-empty-icon"><i class="ui-icon" data-icon="Command" aria-hidden="true"></i></span>
        <h3>管理你的斜杠命令</h3>
        <p>从左侧选择一条命令进行编辑，或创建一个新的提示词模板。</p>
        <Button id="cmd-empty-new-btn" class="ghost-btn small" @click="openCreateEditor">新建命令</Button>
      </div>

      <form
        v-else
        id="command-form"
        class="command-form"
        novalidate
        :aria-busy="String(saving)"
        @submit.prevent="saveCommand"
        @keydown="onFormKeydown"
      >
        <div class="command-editor-head">
          <div>
            <div id="cmd-editor-mode" class="command-editor-eyebrow">{{ editorMode === 'create' ? "新建命令" : "编辑命令" }}</div>
            <h3 id="cmd-editor-title">{{ editorMode === 'create' ? "命令详情" : `/${editingOriginalName}` }}</h3>
          </div>
          <Button id="cmd-editor-close" class="commands-icon-btn" aria-label="关闭命令编辑器" title="关闭编辑器" :disabled="saving" @click="closeEditor">
            <i class="ui-icon" data-icon="X" aria-hidden="true"></i>
          </Button>
        </div>

        <div class="command-form-grid">
          <label class="field">
            <span class="field-label">命令名 <em class="key-state">必填</em></span>
            <Input
              id="cmd-name"
              v-model:value="form.name"
              type="text"
              spellcheck="false"
              :maxlength="40"
              autocomplete="off"
              aria-label="命令名"
              placeholder="例如 review"
              :aria-invalid="errors.name ? 'true' : undefined"
              :aria-describedby="errors.name ? 'cmd-name-hint cmd-name-vue-error' : 'cmd-name-hint'"
              @input="errors.name = ''"
            />
            <span id="cmd-name-hint" class="command-field-hint">用于输入框 / 菜单，只能包含字母、数字、_ 和 -。</span>
            <span
              v-if="errors.name"
              id="cmd-name-vue-error"
              class="ui-field-error"
              role="alert"
              aria-live="polite"
            >{{ errors.name }}</span>
          </label>
          <label class="field">
            <span class="field-label">菜单显示名</span>
            <Input
              id="cmd-title"
              v-model:value="form.title"
              type="text"
              spellcheck="false"
              :maxlength="80"
              autocomplete="off"
              aria-label="菜单显示名"
              placeholder="例如 审查改动（留空则显示命令名）"
            />
          </label>
        </div>

        <label class="field">
          <span class="field-label">一句话说明</span>
          <Input
            id="cmd-desc"
            v-model:value="form.desc"
            type="text"
            spellcheck="false"
            :maxlength="200"
            autocomplete="off"
            placeholder="告诉用户这条命令适合什么场景，例如：审查本次改动并指出风险"
          />
        </label>

        <label class="field command-template-field">
          <span class="field-label">提示词模板 <em class="key-state">必填</em></span>
          <Input.TextArea
            id="cmd-template"
            v-model:value="form.template"
            spellcheck="false"
            :maxlength="MAX_TEMPLATE_CHARS"
            :rows="9"
            aria-label="命令模板"
            placeholder="例如：请审查以下改动并指出风险：&#10;{{selection}}"
            :aria-invalid="errors.template ? 'true' : undefined"
            :aria-describedby="errors.template ? 'cmd-template-vue-error' : undefined"
            @input="errors.template = ''"
          />
          <span
            v-if="errors.template"
            id="cmd-template-vue-error"
            class="ui-field-error"
            role="alert"
            aria-live="polite"
          >{{ errors.template }}</span>
        </label>
        <div class="command-template-footer">
          <span class="command-token-label">插入变量</span>
          <Button class="command-token-btn" data-command-token="selection" v-text="'{{selection}} · 当前输入'" @click="insertTemplateToken('selection')"></Button>
          <Button class="command-token-btn" data-command-token="date" v-text="'{{date}} · 今天日期'" @click="insertTemplateToken('date')"></Button>
          <span id="cmd-template-count" class="command-template-count">{{ form.template.length }} / {{ MAX_TEMPLATE_CHARS }}</span>
        </div>

        <div class="command-editor-actions">
          <Button id="cmd-editor-cancel" :disabled="saving" @click="closeEditor">取消</Button>
          <Button id="cmd-save-btn" type="primary" html-type="submit" :loading="saving">
            {{ saving ? "保存中…" : (editorMode === "create" ? "创建命令" : "保存修改") }}
          </Button>
        </div>
      </form>
    </section>
  </div>
  </AntdvProvider>
</template>
