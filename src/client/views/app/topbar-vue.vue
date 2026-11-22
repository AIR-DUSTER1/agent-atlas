<!--
  topbar-vue.vue — 顶栏会话头（框架迁移 M4 批次 4.5）
  ============================================================
  职责：#topbar 内的会话标题 / 面包屑 / 示例徽标。挂载容器是
  #topbar-head-mount（位于静态顶栏中）。

  DOM 契约与静态版逐 id 一致：breadcrumb-project / session-title /
  demo-badge，e2e 与 main-ui 单测依赖这些锚点。

  立场：
  - 顶栏其余部分（侧栏开关、主题按钮、状态灯、模拟模式徽标）保持静态：
    它们由 main.ts 事件绑定与 setStatus 直接驱动，迁移收益低、风险高；
  - 欢迎页标题/副标题在 #welcome 内，由 welcome-head-vue.vue 单独挂载
    （两个 DOM 位置不能共用一个 mount 点）。
-->
<script setup lang="ts">
import { computed, onMounted, onUnmounted } from "vue";
import { useTopbarStore } from "../../stores/app/topbar.js";

const store = useTopbarStore();

const badgeHidden = computed(() => !store.badgeVisible);

const listener = (): void => { store.refresh(); };

onMounted(() => {
  (window.__agentatlasTopbarListeners ??= new Set()).add(listener);
});
onUnmounted(() => {
  window.__agentatlasTopbarListeners?.delete(listener);
});
</script>

<template>
  <div class="topbar-breadcrumb" aria-label="当前位置">
    <span id="breadcrumb-project">{{ store.breadcrumb }}</span>
    <i class="ui-icon" data-icon="ChevronRight" aria-hidden="true"></i>
    <span id="session-title">{{ store.sessionTitle }}</span>
  </div>
  <span id="demo-badge" class="badge" :class="{ hidden: badgeHidden }">{{ store.badgeText }}</span>
</template>
