<!--
  perm-chip-vue.vue — 会话权限 chip（框架迁移 M4 批次 4.5）
  ============================================================
  职责：#perm-group 内 #cm-perm 按钮与 #cm-perm-menu 容器的渲染。
  DOM 契约：e2e 断言 `#cm-perm .cm-text` 为「权限·权限名」（点开后变「只读」），
  并检查 #perm-group 可见性；`.cm-chip` 的 on 态与菜单显隐由 main.ts 的
  toggleCmMenu 直接切类（本组件只给 hidden 初值，不接管开合）。
  立场：
  - 可用性判定与文案由 stores/topbar.ts 统一派生（共享 session-kind 谓词）；
  - 菜单条目由 renderPermMenu 命令式写入（它要复用 composer 菜单的既有样式与
    点击逻辑），本组件只提供空的 #cm-perm-menu 容器。
-->
<script setup lang="ts">
import { computed, onMounted, onUnmounted } from "vue";
import { useTopbarStore } from "../stores/topbar.js";

const store = useTopbarStore();
const visible = computed(() => store.permVisible);

const listener = (): void => { store.refresh(); };

onMounted(() => {
  (window.__agentatlasTopbarListeners ??= new Set()).add(listener);
});
onUnmounted(() => {
  window.__agentatlasTopbarListeners?.delete(listener);
});
</script>

<template>
  <div id="perm-group" class="cm-group" :class="{ hidden: !visible }">
    <button id="cm-perm" class="cm-chip" type="button" :title="store.permTitle">
      <span class="cm-ic"><i class="ui-icon" data-icon="ShieldCheck" aria-hidden="true"></i></span><span class="cm-text">{{ store.permText }}</span><i class="ui-icon cm-arr" data-icon="ChevronDown" aria-hidden="true"></i>
    </button>
    <div id="cm-perm-menu" class="cm-menu hidden"></div>
  </div>
</template>
