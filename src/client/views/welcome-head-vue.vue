<!--
  welcome-head-vue.vue — 欢迎页标题区与分区标签（框架迁移 M4 批次 4.5）
  ============================================================
  职责：按 section prop 渲染欢迎页的两段文案：
  - section="hero"（默认）：.welcome-hero（logo + #welcome-title +
    #welcome-subtitle）+ #welcome-examples-label「试试这些」；
  - section="cards"：#welcome-cards-label「选择 Agent 或内置示例」。
  为什么拆两段挂载：#example-chips 与 #demo-cards 是夹在它们中间的独立静态
  容器；若把两个标签放进同一个挂载点，「选择 Agent」标签会跑到 chips 之前。
  DOM 契约：#welcome-title / #welcome-subtitle / #welcome-examples-label /
  #welcome-cards-label —— e2e 依赖（无项目时标题变「选择一个 Agent 开始新
  会话」、副标题含「当前还没有添加项目」、示例 chips 隐藏）。
-->
<script setup lang="ts">
import { computed, onMounted, onUnmounted } from "vue";
import { useTopbarStore } from "../stores/topbar.js";

const props = withDefaults(defineProps<{ section?: "hero" | "cards" }>(), { section: "hero" });

const store = useTopbarStore();
const pickingAgent = computed(() => store.pickingAgent);
const isHero = computed(() => props.section === "hero");

const listener = (): void => { store.refresh(); };

onMounted(() => {
  (window.__agentatlasTopbarListeners ??= new Set()).add(listener);
});
onUnmounted(() => {
  window.__agentatlasTopbarListeners?.delete(listener);
});
</script>

<template>
  <template v-if="isHero">
    <div class="welcome-hero">
      <div class="welcome-logo"><i class="ui-icon" data-icon="Zap" aria-hidden="true"></i></div>
      <h1 id="welcome-title">{{ store.welcomeTitle }}</h1>
      <p id="welcome-subtitle">{{ store.welcomeSubtitle }}</p>
    </div>
    <div id="welcome-examples-label" class="examples-label" :class="{ hidden: pickingAgent }">试试这些</div>
  </template>
  <div v-else id="welcome-cards-label" class="examples-label">{{ store.cardsLabel }}</div>
</template>
