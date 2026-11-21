<!--
  settings-plugins-vue.vue — 插件面板 Vue+antdv-next 试点（M4 批次 4.1 CSP 验证场）
  ============================================================
  用 antdv-next 的 Button/Input 渲染插件面板的工具行（与既有 h() 面板并存：
  Vue 版渲染在 #plugins-vue-mount，h() 版继续渲染 #plugin-list，迁移完成前
  两者同屏供对照与 e2e 断言）。antdv 的 CSS-in-JS 运行时注入是否触碰
  style-src CSP 由 e2e 实测（console 违例即停并回报重评）。
-->
<script setup lang="ts">
import { Button, Input } from "antdv-next";
import { onMounted, ref } from "vue";

/** 从既有 /api/plugins 契约读取的启停状态（只读对照，不写回——写回仍是 h() 面板职责） */
interface PluginRow {
  id: string;
  label: string;
  description: string;
  enabled: boolean;
}

const rows = ref<PluginRow[]>([]);
const probeText = ref("");
const loaded = ref(false);

onMounted(async () => {
  try {
    const res = await fetch("/api/plugins", { credentials: "same-origin" });
    const data = (await res.json()) as { plugins?: Array<{ id: string; name: string; enabled: boolean }> };
    rows.value = (data.plugins ?? []).map((p) => ({
      id: p.id,
      label: p.name,
      description: p.id,
      enabled: p.enabled,
    }));
  } catch {
    rows.value = [];
  } finally {
    loaded.value = true;
  }
});
</script>

<template>
  <div class="plugins-vue-spike">
    <p class="plugins-vue-banner">
      <Button type="primary" size="small" data-vue-antdv="button">Vue + antdv-next 试点</Button>
      <Input
        v-model:value="probeText"
        size="small"
        placeholder="antdv Input（CSS-in-JS CSP 验证）"
        data-vue-antdv="input"
        class="plugins-vue-input"
      />
      <span class="plugins-vue-hint">本行是 Vue 试点渲染；下方插件列表仍由 h() 面板负责</span>
    </p>
    <ul v-if="loaded" class="plugins-vue-list">
      <li v-for="row in rows" :key="row.id" :data-plugin-vue="row.id">
        <strong>{{ row.label }}</strong>
        <span>{{ row.enabled ? "已启用" : "已停用" }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.plugins-vue-spike {
  margin-bottom: 14px;
}
.plugins-vue-banner {
  align-items: center;
  display: flex;
  gap: 10px;
  margin: 0 0 8px;
}
.plugins-vue-input {
  max-width: 220px;
}
.plugins-vue-hint {
  color: var(--text-2, #9b9ba4);
  font-size: var(--font-xs, 12px);
}
.plugins-vue-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.plugins-vue-list li {
  display: flex;
  gap: 10px;
  justify-content: space-between;
  padding: 4px 0;
}
</style>
