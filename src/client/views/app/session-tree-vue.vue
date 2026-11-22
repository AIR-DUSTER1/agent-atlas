<!--
  session-tree-vue.vue — 侧栏会话树（框架迁移 M4 批次 4.5）
  ============================================================
  职责：#session-list 内的分组头、时间分隔行与会话项的声明式渲染。
  DOM 契约与 h() 版逐类名 / role / aria 一致：.proj-group-head（含 .cloud /
  .collapsed / .static、role=button、aria-expanded、aria-label）、.g-caret /
  .g-icon / .g-name / .g-count / .p-type-tag、.session-time-head、.session-item
  （含 .active / .stale、role=button）、.s-title / .s-meta / .s-demo /
  .s-running / .s-pending / .s-actions / .s-export / .s-del。e2e 用
  `#session-list .session-item` 与会话文本定位。
  立场：
  - 数据全部来自 stores/sessions.ts（core state 非响应式，靠 revision 触发）；
  - 切换/导出/删除/折叠都经 window 命令面回 legacy 桥，组件不做副作用；
  - 搜索输入框仍由 main.ts 写值，组件通过 store.term 读取并同步。
-->
<script setup lang="ts">
import { Button } from "antdv-next";
import AntdvProvider from "../../ui/antdv-provider.vue";
import { computed, onMounted, onUnmounted } from "vue";
import { useSessionsStore } from "../../stores/app/sessions.js";
import type { SessionTreeNode } from "../../stores/app/sessions.js";

const store = useSessionsStore();

const nodes = computed<SessionTreeNode[]>(() => store.tree);
const items = computed(() => store.items);

/** 侧栏搜索输入框的引用：v-model 若直接绑 store.term，main.ts 的既有
 *  input 监听会与之打架；这里由组件独占绑定，外部只经 store.setTerm 同步。 */
let searchEl: HTMLInputElement | null = null;

function commands() {
  return window.__agentatlasSessionCommands ?? {};
}

function onGroupClick(node: Extract<SessionTreeNode, { kind: "group" }>): void {
  if (!node.interactive) return;
  commands().toggleGroup?.(node.key);
}

function onGroupKeydown(event: KeyboardEvent, node: Extract<SessionTreeNode, { kind: "group" }>): void {
  if (!node.interactive) return;
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    commands().toggleGroup?.(node.key);
  }
}

function selectSession(id: string): void {
  commands().select?.(id);
}

function onSessionKeydown(event: KeyboardEvent, id: string): void {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    selectSession(id);
  }
}

function exportSession(event: MouseEvent, id: string): void {
  event.stopPropagation();
  commands().exportSession?.(id);
}

function removeSession(event: MouseEvent, id: string): void {
  event.stopPropagation();
  commands().removeSession?.(id);
}

/** 侧栏搜索框的值变化（input 事件在 main.ts 绑定）经此同步进 store。 */
const onSearchInput = (event: Event): void => {
  store.setTerm((event.target as HTMLInputElement).value ?? "");
};

const onExternal = (): void => {
  store.refresh();
  if (searchEl && searchEl.value !== store.term) searchEl.value = store.term;
};

onMounted(() => {
  store.refresh();
  searchEl = document.getElementById("session-search") as HTMLInputElement | null;
  searchEl?.addEventListener("input", onSearchInput);
  (window.__agentatlasSessionListeners ??= new Set()).add(onExternal);
});
onUnmounted(() => {
  window.__agentatlasSessionListeners?.delete(onExternal);
  searchEl?.removeEventListener("input", onSearchInput);
  searchEl = null;
});
</script>

<template>
  <AntdvProvider>
  <template v-for="node in nodes" :key="node.key">
    <div
      v-if="node.kind === 'group'"
      class="proj-group-head"
      :class="[node.cloud ? 'cloud' : '', node.collapsed ? 'collapsed' : '', node.interactive ? '' : 'static']"
      :role="node.interactive ? 'button' : undefined"
      :tabindex="node.interactive ? '0' : undefined"
      :aria-expanded="node.interactive ? String(!node.collapsed) : undefined"
      :aria-label="node.interactive ? `${node.name}，${node.count} 个会话，${node.collapsed ? '已收起' : '已展开'}` : undefined"
      :title="node.interactive ? (node.collapsed ? '展开该项目会话' : '收起该项目会话') : ''"
      @click="onGroupClick(node)"
      @keydown="onGroupKeydown($event, node)"
    >
      <span class="g-caret"><i class="ui-icon" data-icon="ChevronRight" aria-hidden="true"></i></span>
      <span class="g-icon"><i class="ui-icon" :data-icon="node.cloud ? 'Globe' : 'Folder'" aria-hidden="true"></i></span>
      <span class="g-name">{{ node.name }}</span>
      <span class="g-count">{{ node.count }}</span>
      <span class="p-type-tag">{{ node.typeTag }}</span>
    </div>

    <div v-else-if="node.kind === 'day'" class="session-time-head">{{ node.label }}</div>

    <div
      v-else
      class="session-item"
      :class="{ active: items[node.key]?.active, stale: items[node.key]?.stale }"
      :title="items[node.key]?.stale ? '服务已重启，该会话仅可查看历史记录' : ''"
      role="button"
      tabindex="0"
      @click="selectSession(node.key)"
      @keydown="onSessionKeydown($event, node.key)"
    >
      <div class="s-title">{{ items[node.key]?.title }}</div>
      <div class="s-meta">
        <span class="s-demo">{{ items[node.key]?.tag }}</span>
        <span>{{ items[node.key]?.time }}</span>
        <span v-if="items[node.key]?.running" class="s-running" title="该会话正在后台生成回复">
          <i class="ui-icon" data-icon="LoaderCircle" aria-hidden="true"></i>生成中
        </span>
        <span v-if="items[node.key]?.pending" class="s-pending">
          <i class="ui-icon" data-icon="Clock" aria-hidden="true"></i>待审批
        </span>
      </div>
      <div class="s-actions">
        <Button class="s-action s-export" title="导出为 Markdown" aria-label="导出当前会话为 Markdown" @click="exportSession($event, node.key)">
          <i class="ui-icon" data-icon="Download" aria-hidden="true"></i>
        </Button>
        <Button class="s-action s-del" title="删除会话" aria-label="删除当前会话" @click="removeSession($event, node.key)">
          <i class="ui-icon" data-icon="X" aria-hidden="true"></i>
        </Button>
      </div>
    </div>
  </template>

  <div v-if="store.isEmpty" class="fs-empty">{{ store.emptyText }}</div>
  </AntdvProvider>
</template>
