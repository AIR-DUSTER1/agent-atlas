<!--
  example-chips-vue.vue — 欢迎页示例 chips（框架迁移 M4 批次 4.5）
  ============================================================
  职责：渲染 #example-chips 内的 .ex-chip 按钮。点击即用该文本预填并
  创建通用 Agent 会话（与 h() 版行为一致）。
-->
<script setup lang="ts">
import { Button } from "antdv-next";
import AntdvProvider from "../../ui/antdv-provider.vue";
import { useShellStore } from "../../stores/shell.js";

const store = useShellStore();

function pick(text: string): void {
  window.__agentatlasShellCommands?.create?.("agent", null, text);
}
</script>

<template>
  <AntdvProvider>
  <Button v-for="text in store.examples" :key="text" class="ex-chip" @click="pick(text)">{{ text }}</Button>
  </AntdvProvider>
</template>
