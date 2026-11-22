<!--
  context-meter-vue.vue — 上下文容量条（框架迁移 M4 批次 4.6）
  ============================================================
  职责：渲染 #context-bar（填充 / 主文案 / 输出均速 / 缓存占比 / title / aria-label）。
  DOM 契约与 h() 版逐 id / 类名一致（ctx-fill / ctx-text / ctx-speed / ctx-cache），
  e2e 依赖「↑ ↓ / 输出均速 / tok/s / title 含模型窗口 / 会话切换隐藏」这些行为。
-->
<script setup lang="ts">
import { onMounted, onUnmounted } from "vue";
import { useContextMeterStore } from "../../stores/chat/context-meter.js";

const store = useContextMeterStore();

/** 启动时先取一次快照（组件挂载晚于首次 usage），再订阅后续变更。 */
function sync(): void {
  store.apply(window.__agentatlasContextMeter ?? null);
}

const listener = (): void => sync();

onMounted(() => {
  sync();
  (window.__agentatlasContextMeterListeners ??= new Set()).add(listener);
});
onUnmounted(() => {
  window.__agentatlasContextMeterListeners?.delete(listener);
});
</script>

<template>
  <div
    id="context-bar"
    class="context-bar"
    :class="{ hidden: !store.visible }"
    :title="store.title"
    :aria-label="store.ariaLabel"
  >
    <div class="ctx-track"><div id="ctx-fill" class="ctx-fill" :class="store.tone" :style="{ width: store.fillWidth }"></div></div>
    <div class="ctx-meta">
      <span id="ctx-text">{{ store.text }}</span>
      <span id="ctx-speed" class="ctx-speed" :class="{ hidden: !store.speedVisible }">{{ store.speedText }}</span>
      <span id="ctx-cache" class="ctx-cache" :class="{ hidden: !store.cacheVisible }">{{ store.cacheText }}</span>
    </div>
  </div>
</template>
