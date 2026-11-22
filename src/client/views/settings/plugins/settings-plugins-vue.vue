<!--
  settings-plugins-vue.vue — 插件面板（框架迁移 M4 批次 4.1 完整 Vue 化）
  ============================================================
  职责：渲染插件目录卡片并提交启停写回（PATCH /api/plugins/:id 经 store）。
  契约：DOM 结构与 h() 版完全一致（data-plugin-id / .plugin-switch input /
  role=switch / aria-label / 卡片状态文案），e2e 与 a11y 断言零改动迁移。
  立场：
  - 多根模板：卡片必须是 #plugin-list 的直接子节点（.plugin-list 是网格容器）；
  - 开关是 antdv Switch（受控组件）：状态只看 store，失败时不会残留半途状态；
  - 「管理」入口沿用 legacy 对话框（RAG/贝壳/求职面板与 uiAlert 尚未 Vue 化）。
-->
<script setup lang="ts">
import { Button, Switch } from "antdv-next";
import { computed, ref } from "vue";
import AntdvProvider from "../../../ui/antdv-provider.vue";
import { BUILTIN_PLUGINS, pluginTransportMeta, type BuiltinPlugin } from "../../../modules/plugin-registry.js";
import { usePluginsStore } from "../../../stores/plugins.js";
import { openPluginManage, pluginStatus } from "./settings-plugins.js";
import { refreshAgentCards } from "../../welcome/shell.js";

const store = usePluginsStore();
/** 正在写回中的插件 id：写回期间禁用该开关，防止重复提交。 */
const togglingId = ref<string | null>(null);

interface PluginRow {
  plugin: BuiltinPlugin;
  transport: { id: string; label: string };
  enabled: boolean;
  ready: { ready: boolean; label: string };
  supported: boolean;
}

const pluginRows = computed<PluginRow[]>(() =>
  BUILTIN_PLUGINS.map((plugin) => {
    const transport = pluginTransportMeta(plugin.transport);
    return {
      plugin,
      transport,
      enabled: store.plugins?.enabled[plugin.id] ?? plugin.defaultEnabled,
      ready: readinessOf(plugin),
      supported: plugin.id !== "computer" || !store.plugins || store.plugins.platform === "win32",
    };
  }),
);

function readinessOf(plugin: BuiltinPlugin): { ready: boolean; label: string } {
  if (plugin.id === "rag") {
    const ready = Boolean(store.rag?.configured);
    return { ready, label: ready ? "已配置" : "未配置" };
  }
  if (plugin.id === "estate") {
    const ready = Boolean(store.estate?.installed);
    return {
      ready,
      label: ready
        ? `已安装${store.estate?.version ? ` ${store.estate.version}` : ""}`
        : "未安装",
    };
  }
  if (plugin.id === "job") {
    const status = store.job;
    if (!status) return { ready: false, label: "未检测" };
    if (!status.browserOK) return { ready: false, label: "未找到浏览器" };
    return { ready: true, label: `就绪 · ${status.lastRunJobs} 条岗位` };
  }
  if (plugin.id === "browser") {
    const status = store.browser;
    if (!status) return { ready: false, label: "未检测" };
    return {
      ready: status.available,
      label: status.available
        ? `${status.browserName}${status.activeSessions ? ` · ${status.activeSessions}/${status.maxSessions} 会话` : ""}`
        : "未找到 Chrome / Edge",
    };
  }
  const available = !store.plugins || store.plugins.platform === "win32";
  return { ready: available, label: available ? "Windows 可用" : "仅支持 Windows" };
}

async function onToggle(plugin: BuiltinPlugin, next: boolean): Promise<void> {
  togglingId.value = plugin.id;
  try {
    await store.toggle(plugin.id, next);
    refreshAgentCards();
    pluginStatus(`✓ ${plugin.name}已${next ? "启用" : "停用"}，下一条消息生效`, "ok");
  } catch (err) {
    pluginStatus(`✗ ${(err as Error).message}`, "err");
  } finally {
    togglingId.value = null;
  }
}
</script>

<template>
  <AntdvProvider>
  <article
    v-for="row in pluginRows"
    :key="row.plugin.id"
    class="plugin-card"
    :class="{ disabled: !row.enabled }"
    :data-plugin-id="row.plugin.id"
    :data-transport="row.transport.id"
  >
    <div class="plugin-main">
      <div class="plugin-icon" aria-hidden="true">{{ row.plugin.icon }}</div>
      <div class="plugin-copy">
        <div class="plugin-title-row">
          <h3>{{ row.plugin.name }}</h3>
          <span :class="`plugin-kind kind-${row.transport.id}`">{{ row.transport.label }}</span>
        </div>
        <p class="plugin-desc">{{ row.plugin.description }}</p>
        <div class="plugin-runtime-row">
          <span class="plugin-runtime">{{ row.plugin.runtime }}</span>
          <span class="plugin-status" :class="{ ready: row.ready.ready }">{{ row.ready.label }}</span>
          <span class="plugin-enabled-state" :class="{ on: row.enabled }">{{ row.enabled ? "已启用" : "已停用" }}</span>
        </div>
      </div>
    </div>
    <div class="plugin-actions">
      <Switch
        class="plugin-switch"
        :title="row.supported ? (row.enabled ? '停用插件' : '启用插件') : '当前平台不支持'"
        :aria-label="row.supported ? `${row.enabled ? '停用' : '启用'}${row.plugin.name}` : `${row.plugin.name}仅支持 Windows`"
        :checked="row.enabled"
        :disabled="!row.supported || togglingId === row.plugin.id"
        :loading="togglingId === row.plugin.id"
        @update:checked="(next: boolean) => onToggle(row.plugin, next)"
      />
      <Button class="plugin-manage" type="primary" @click="openPluginManage(row.plugin)">{{ row.plugin.manageLabel }}</Button>
    </div>
  </article>
  </AntdvProvider>
</template>
