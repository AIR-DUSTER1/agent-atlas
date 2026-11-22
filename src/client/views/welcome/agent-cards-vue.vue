<!--
  agent-cards-vue.vue — Agent / 示例卡片列表（框架迁移 M4 批次 4.5）
  ============================================================
  职责：渲染 .demo-card 列表（欢迎页 #demo-cards 与新会话弹窗 #modal-cards
  共用同一组件）。DOM 契约与 h() 版一致：.demo-card / .d-head / .d-num /
  .d-name / .d-default / .d-desc / .d-eg，卡片文案固定前缀「示例：」。
  立场：
  - 文案全部来自 AGENT_PROFILES 与内置 demos（stores/shell.ts 单一来源）；
  - 点击只经 window 命令面请求创建会话，失败提示在 legacy 桥；
  - 组件可多处挂载（同一 pinia，各自 mount 实例）。
-->
<script setup lang="ts">
import { computed, onMounted, onUnmounted } from "vue";
import { useShellStore } from "../../stores/shell.js";
import type { AgentCardModel } from "../../stores/shell.js";
import type { SessionKind } from "../../modules/types.js";

const store = useShellStore();
const cards = computed<AgentCardModel[]>(() => store.cards);

const listener = (): void => { store.refresh(); };

onMounted(() => {
  store.refresh();
  (window.__agentatlasShellListeners ??= new Set()).add(listener);
});
onUnmounted(() => {
  window.__agentatlasShellListeners?.delete(listener);
});

function create(card: AgentCardModel): void {
  window.__agentatlasShellCommands?.create?.(card.kind as SessionKind | null, card.demo, card.prefill);
}
</script>

<template>
  <button v-for="card in cards" :key="card.key" type="button" class="demo-card" @click="create(card)">
    <div class="d-head">
      <span class="d-num">{{ card.icon }}</span>
      <span class="d-name">{{ card.name }}<span v-if="card.badge" class="d-default">{{ card.badge }}</span></span>
    </div>
    <div class="d-desc">{{ card.description }}</div>
    <div class="d-eg">示例：{{ card.example }}</div>
  </button>
</template>
