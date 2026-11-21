<!--
  settings-backup-vue.vue — 备份与恢复列表（框架迁移 M4 批次 4.2）
  ============================================================
  职责：渲染备份列表并处理恢复流程（uiConfirm 二次确认 → store.restore → uiAlert 结果）。
  契约：DOM 与 h() 版一致（.backup-row / .b-name / .b-meta / .b-restore / .memories-empty 空态）。
  立场：恢复是破坏性动作，确认文案写明「自动快照」与「需重启生效」。
-->
<script setup lang="ts">
import { onMounted } from "vue";
import { useBackupStore } from "../stores/backup.js";
import { uiAlert, uiConfirm } from "../ui/dialog.js";

const store = useBackupStore();

/** 密钥安全状态文案：明文风险必须显式展示。 */
function securityLabel(entry: { secrets?: string }): string {
  if (entry.secrets === "encrypted") return "密文密钥";
  if (entry.secrets === "plaintext-risk") return "明文密钥风险";
  if (entry.secrets === "unknown") return "旧版未验证";
  return "无密钥";
}

async function restore(name: string): Promise<void> {
  const ok = await uiConfirm(
    `确定恢复备份 ${name} 吗？\n\n恢复前会自动创建一份当前状态的快照（可退回）。\n恢复后需要重启服务（npm run web）才生效。`,
    { title: "恢复备份", okText: "恢复" },
  );
  if (!ok) return;
  try {
    const res = await store.restore(name);
    void uiAlert(res.hint || "已恢复，请重启服务生效", "恢复完成");
  } catch (err) {
    void uiAlert(`恢复失败：${(err as Error).message}`, "恢复备份");
  }
}

onMounted(() => {
  if (!store.loaded) void store.refresh().catch(() => {});
});
</script>

<template>
  <p v-if="!store.entries.length" class="memories-empty">还没有备份。升级版本 / 迁移机器前建议先创建一份。</p>
  <template v-else>
    <div v-for="entry in store.entries" :key="entry.name" class="backup-row">
      <div class="b-info">
        <div class="b-name">{{ entry.name }}</div>
        <div class="b-meta">{{ entry.createdAt ? new Date(entry.createdAt).toLocaleString("zh-CN") : "时间未知" }} · {{ entry.files.length }} 个文件 · {{ securityLabel(entry) }}</div>
      </div>
      <button type="button" class="ghost-btn small b-restore" @click="restore(entry.name)">恢复</button>
    </div>
  </template>
</template>
