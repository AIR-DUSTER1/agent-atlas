<!--
  browser-dock-vue.vue — Browser Use 右侧实时画面（框架迁移 M4 批次 4.4）
  ============================================================
  职责：#browser-dock 面板的声明式渲染（标题 / 状态胶囊 / URL / 截图 / 空态 /
  关闭按钮）。DOM 契约与 h() 版逐 id 一致：browser-dock / -title / -state /
  -url / -close / -screen / -empty / -meta，e2e 依赖这些锚点与
  `#main.browser-open` 的联动。
  立场：
  - 数据从 window 快照通道来（bundle 与 1:1 副本是两个 pinia 实例）；
  - 轮询、会话隔离判定、关闭 API 都仍由 views/browser-use.ts 负责；
  - 截图 img 的 ready 类由 load/error 事件驱动（CSS 用 display 控制可见性）。
-->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useBrowserDockStore } from "../../stores/browser-dock.js";

const store = useBrowserDockStore();
const screenReady = ref(false);

const snapshot = computed(() => store.snapshot);
const visible = computed(() => store.visible);
const title = computed(() => snapshot.value?.title ?? "等待网页");
const url = computed(() => snapshot.value?.url ?? "about:blank");
const stateText = computed(() => snapshot.value?.stateText ?? "未连接");
const meta = computed(() => snapshot.value?.meta ?? "会话隔离 · 空闲 10 分钟自动关闭");

/** 画面地址变化即重置 ready（不等 load 事件回来）。 */
const screenshotSrc = computed(() => snapshot.value?.screenshotSrc ?? "");

function onLoad(): void {
  screenReady.value = true;
}

function onError(): void {
  screenReady.value = false;
}

function close(): void {
  window.__agentatlasBrowserDockCommands?.close?.();
}

const listener = (): void => {
  store.apply(window.__agentatlasBrowserDock ?? null);
  screenReady.value = false;
};

onMounted(() => {
  store.apply(window.__agentatlasBrowserDock ?? null);
  (window.__agentatlasBrowserDockListeners ??= new Set()).add(listener);
});
onUnmounted(() => {
  window.__agentatlasBrowserDockListeners?.delete(listener);
});
</script>

<template>
  <aside
    v-show="visible"
    id="browser-dock"
    :class="{ hidden: !visible }"
    aria-label="Browser Use 浏览器画面"
  >
    <header class="browser-dock-head">
      <div class="browser-dock-heading">
        <span class="browser-dock-icon"><i class="ui-icon" data-icon="Globe" aria-hidden="true"></i></span>
        <div class="browser-dock-copy">
          <strong>Browser Use</strong>
          <span id="browser-dock-title">{{ title }}</span>
        </div>
      </div>
      <span id="browser-dock-state" class="browser-dock-state" :class="store.stateTone" role="status" aria-live="polite">{{ stateText }}</span>
      <button id="browser-dock-close" type="button" class="browser-dock-close" aria-label="关闭 Browser Use 浏览器" title="关闭浏览器" @click="close">
        <i class="ui-icon" data-icon="X" aria-hidden="true"></i>
      </button>
    </header>
    <div class="browser-dock-toolbar">
      <span class="browser-dock-dot" aria-hidden="true"></span>
      <span id="browser-dock-url" class="browser-dock-url">{{ url }}</span>
      <span class="browser-dock-owner">AI 控制</span>
    </div>
    <div class="browser-dock-canvas">
      <img
        id="browser-dock-screen"
        :class="{ ready: screenReady }"
        :src="screenshotSrc || undefined"
        alt="Browser Use 当前页面画面"
        @load="onLoad"
        @error="onError"
      />
      <div id="browser-dock-empty" class="browser-dock-empty" :style="{ visibility: snapshot?.emptyVisible === false ? 'hidden' : 'visible' }">
        <i class="ui-icon" data-icon="Globe" aria-hidden="true"></i>
        <strong>{{ snapshot?.emptyTitle ?? '等待 Agent 打开网页' }}</strong>
        <span>{{ snapshot?.emptyDetail ?? '浏览器画面会在这里实时更新' }}</span>
      </div>
    </div>
    <footer class="browser-dock-foot">
      <span id="browser-dock-meta">{{ meta }}</span>
      <span>Chrome / Edge</span>
    </footer>
  </aside>
</template>
