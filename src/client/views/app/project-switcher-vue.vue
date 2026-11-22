<!--
  project-switcher-vue.vue — 侧栏项目切换器（框架迁移 M4 批次 4.4）
  ============================================================
  职责：#project-btn 按钮内容与 #project-menu 菜单项的声明式渲染。
  DOM 契约与 h() 版逐 id / 类 / role 一致：project-btn / project-btn-icon /
  project-btn-text / project-menu / .pm-*；菜单项保持 role=menuitem 与
  「添加本地文件夹（系统选择）」等无障碍名称（e2e 用 getByRole 命中）。
  立场：
  - 菜单开合仍由 ui/menu.ts 浮动控制器负责（它把菜单挂到 body 做 fixed
    定位，并切 .hidden）；组件不绑定 class，否则重渲染会打回控制器状态；
  - 选中 / 添加 / 删除 / 刷新云端的所有副作用（API、确认框、core state
    写入）留在 views/projects.ts，组件只经命令面发意图。
-->
<script setup lang="ts">
import { Button } from "antdv-next";
import AntdvProvider from "../../ui/antdv-provider.vue";
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useProjectsStore } from "../../stores/app/projects.js";

/** legacy 桥注册的命令面（避免组件静态依赖 views/projects.ts）。 */
export interface ProjectSwitcherCommands {
  choose?: (view: string) => void;
  addLocal?: () => void;
  addCloud?: () => void;
  refreshCloud?: (id: string) => void;
  remove?: (id: string) => void;
}

const store = useProjectsStore();
const commands = ref<ProjectSwitcherCommands>({});

const allActive = computed(() => store.isAllView);
const noneActive = computed(() => store.isNoneView);

const listener = (): void => { store.sync(); };

onMounted(() => {
  store.sync();
  commands.value = window.__agentatlasProjectCommands ?? {};
  (window.__agentatlasProjectListeners ??= new Set()).add(listener);
});
onUnmounted(() => {
  window.__agentatlasProjectListeners?.delete(listener);
});
</script>

<template>
  <AntdvProvider>
  <Button id="project-btn" class="project-btn" title="选择项目文件夹（本地 / 云端）">
    <span id="project-btn-icon" class="ui-icon-host">
      <i class="ui-icon" :data-icon="store.buttonIcon" aria-hidden="true"></i>
    </span>
    <span id="project-btn-text">{{ store.buttonText }}</span>
    <i class="ui-icon chevron-down" data-icon="ChevronDown" aria-hidden="true"></i>
  </Button>

  <div id="project-menu" class="project-menu hidden" role="menu">
    <Button role="menuitem" class="pm-item" :class="{ active: allActive }" @click="commands.choose?.('all')">
      <span class="pm-ic"><i class="ui-icon" data-icon="FolderTree" aria-hidden="true"></i></span>
      <span class="pm-name">全部项目</span>
      <span class="pm-check">{{ allActive ? "✓" : "" }}</span>
    </Button>

    <Button role="menuitem" class="pm-item" :class="{ active: noneActive }" title="创建会话时不绑定任何项目" @click="commands.choose?.('__none__')">
      <span class="pm-ic"><i class="ui-icon" data-icon="Folder" aria-hidden="true"></i></span>
      <span class="pm-name">不选择项目</span>
      <span class="pm-sub none">无项目上下文</span>
      <span class="pm-check">{{ noneActive ? "✓" : "" }}</span>
    </Button>

    <div v-for="item in store.items" :key="item.id" class="pm-item pm-item-complex" :class="{ active: item.active }">
      <Button role="menuitem" class="pm-select" :title="item.name" @click="commands.choose?.(item.id)">
        <span class="pm-ic"><i class="ui-icon" :data-icon="item.type === 'cloud' ? 'Globe' : 'Folder'" aria-hidden="true"></i></span>
        <span class="pm-name">{{ item.name }}</span>
        <span class="pm-sub" :class="item.type">{{ item.type === "cloud" ? "云端" : "本地" }}</span>
      </Button>
      <Button v-if="item.type === 'cloud'" class="pm-x pm-refresh" title="git pull 刷新缓存" :aria-label="`刷新 ${item.name}`" @click.stop="commands.refreshCloud?.(item.id)">
        <i class="ui-icon" data-icon="RefreshCw" aria-hidden="true"></i>
      </Button>
      <Button v-if="!item.builtin" class="pm-x pm-del" title="删除项目" :aria-label="`删除 ${item.name}`" @click.stop="commands.remove?.(item.id)">
        <i class="ui-icon" data-icon="X" aria-hidden="true"></i>
      </Button>
      <span class="pm-check">{{ item.active ? "✓" : "" }}</span>
    </div>

    <div class="pm-divider"></div>
    <Button role="menuitem" class="pm-item pm-manage" @click="commands.addLocal?.()">
      <i class="ui-icon" data-icon="FolderOpen" aria-hidden="true"></i><span>添加本地文件夹（系统选择）</span>
    </Button>
    <Button role="menuitem" class="pm-item pm-manage" @click="commands.addCloud?.()">
      <i class="ui-icon" data-icon="Globe" aria-hidden="true"></i><span>添加云端文件夹（Git 仓库）</span>
    </Button>
  </div>
  </AntdvProvider>
</template>
