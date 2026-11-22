<!--
  settings-nav-vue.vue — 设置壳导航（框架迁移 M4 批次 4.5）
  ============================================================
  职责：分区导航（分组 + 搜索 + 键盘 / 聚焦）的唯一渲染者。
  DOM 契约与静态版逐字对齐：.settings-nav-group / .settings-nav-item /
  data-settings-view / role=tab / aria-selected / aria-controls，
  e2e 与 settings-page 单测依赖这些锚点。
  立场：
  - 过渡期分区内容仍是 include 的 legacy 片段：本组件只切 active 态与显隐；
  - 分区懒加载入口留在 views/settings.ts（refreshXxx 桥），组件不直接调面板。
-->
<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useSettingsStore } from "../../stores/settings.js";
import { showSettingsView, isSettingsPageOpen } from "./settings.js";

const store = useSettingsStore();
const searchInput = ref<HTMLInputElement | null>(null);

const searchTerm = computed({
  get: () => store.search,
  set: (value: string) => { store.search = value; },
});

function activate(view: string): void {
  showSettingsView(view);
}

function onSearchKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape" && searchTerm.value) {
    searchTerm.value = "";
    event.preventDefault();
    event.stopPropagation();
  } else if (event.key === "Enter") {
    const first = store.filteredGroups[0]?.items[0];
    if (first) {
      activate(first.view);
      nextTick(() => {
        document.querySelector<HTMLElement>(`.settings-nav-item[data-settings-view="${first.view}"]`)?.focus();
      });
    }
    event.preventDefault();
  }
}

/** 全局 `/` 聚焦搜索（非输入框内时）。 */
function onDocKeydown(event: KeyboardEvent): void {
  if (event.key !== "/" || !isSettingsPageOpen()) return;
  const target = event.target as HTMLElement | null;
  if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
  event.preventDefault();
  searchInput.value?.focus();
  searchInput.value?.select();
}

onMounted(() => document.addEventListener("keydown", onDocKeydown));
watch(() => store.current, () => { /* 分区切换由 showSettingsView 处理面板显隐 */ });
</script>

<template>
  <nav class="settings-nav" aria-label="设置分类">
    <label class="settings-search">
      <i class="ui-icon" data-icon="Search" aria-hidden="true"></i>
      <input
        id="settings-search"
        ref="searchInput"
        v-model="searchTerm"
        type="search"
        placeholder="搜索设置项"
        autocomplete="off"
        spellcheck="false"
        @keydown="onSearchKeydown"
      />
      <kbd>/</kbd>
    </label>
    <div class="settings-nav-scroll" role="tablist" aria-label="设置分区">
      <div v-for="group in store.filteredGroups" :key="group.id" class="settings-nav-group" :data-settings-group="group.id">
        <div class="settings-nav-group-title">{{ group.title }}</div>
        <button
          v-for="item in group.items"
          :key="item.view"
          type="button"
          class="settings-nav-item"
          :class="{ active: store.current === item.view, 'search-hit': item.hit }"
          :data-settings-view="item.view"
          role="tab"
          :aria-selected="String(store.current === item.view)"
          :aria-controls="`settings-view-${item.view}`"
          @click="activate(item.view)"
        >
          <span class="sn-icon"><i class="ui-icon" :data-icon="item.icon" aria-hidden="true"></i></span>
          <span class="sn-copy"><strong>{{ item.title }}</strong><small>{{ item.description }}</small></span>
        </button>
      </div>
    </div>
  </nav>
</template>
