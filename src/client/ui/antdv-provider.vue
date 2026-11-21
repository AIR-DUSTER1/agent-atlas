<!--
  antdv-provider.vue — antdv 主题容器（antdv 接入基线）
  ============================================================
  职责：把 antdv 的 ConfigProvider 接到项目主题上 —— 深/浅切换时重算
  algorithm 与种子色，并统一中文 locale。

  为什么需要这层而不是每处直接写 ConfigProvider：
  - 项目有三个主题来源（html[data-theme]、localStorage、Electron overlay），
    每个面板各自读一遍必然漂移；
  - antdv 的默认 locale 是英文（分页 "Previous/Next"、Select 空态 "No data"
    等），必须在唯一入口注入 zh_CN，否则中文界面里冒英文；
  - 种子色必须与 styles/tokens.css 同源（纯数据在 ui/antdv-theme.ts）；
  - `theme.darkAlgorithm` 只能在组件库边界取（它不在顶层具名导出里，
    且组件库 import 一律限定在 .vue 内）。

  用法：受控面板模板最外层包一层 <AntdvProvider>…</AntdvProvider>。
  它不产生任何包裹元素（ConfigProvider 是纯上下文组件），DOM 契约不受影响。
-->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { ConfigProvider, theme } from "antdv-next";
import zhCN from "antdv-next/locale/zh_CN";
import { currentTheme } from "../core/dom.js";
import { ANTDV_DARK_SEEDS, ANTDV_LIGHT_SEEDS, ANTDV_SHARED_TOKEN } from "./antdv-theme.js";

/** 当前主题；由 themechange 事件驱动重算（core/dom.ts 的 toggleTheme 广播）。 */
const themeName = ref<"light" | "dark">("dark");

const config = computed(() => {
  const light = themeName.value === "light";
  return {
    algorithm: light ? theme.defaultAlgorithm : theme.darkAlgorithm,
    token: { ...ANTDV_SHARED_TOKEN, ...(light ? ANTDV_LIGHT_SEEDS : ANTDV_DARK_SEEDS) },
  };
});

function sync(): void {
  themeName.value = currentTheme();
}

onMounted(() => {
  sync();
  window.addEventListener("themechange", sync);
});
onUnmounted(() => window.removeEventListener("themechange", sync));
</script>

<template>
  <ConfigProvider :theme="config" :locale="zhCN" component-size="middle">
    <slot />
  </ConfigProvider>
</template>
