<!--
  settings-backup-vue.vue — 备份与恢复列表（框架迁移 M4 批次 4.2；antdv 接入批次改控件）
  ============================================================
  职责：渲染备份列表并处理恢复流程（uiConfirm 二次确认 → store.restore → uiAlert 结果）。
  契约：DOM 与 h() 版一致（.backup-row / .b-name / .b-meta / .b-restore / .memories-empty 空态）。
  立场：恢复是破坏性动作，确认文案写明「自动快照」与「需重启生效」。

  antdv 接入说明：空态用 Empty、恢复按钮用 Button、密钥风险状态用 Tag 着色。
  `.backup-row` / `.b-name` / `.b-meta` / `.b-restore` 四个类名保留（备份面板由
  设置页 e2e 与样式表 .b-* 规则共同依赖），antdv 的类只做叠加不做替换。
-->
<script setup lang="ts">
import { onMounted } from "vue";
import { Button, Empty, Tag } from "antdv-next";
import { useBackupStore } from "../../../stores/settings/models/backup.js";
import { uiAlert, uiConfirm } from "../../../ui/dialog.js";
import AntdvProvider from "../../../ui/antdv-provider.vue";

const store = useBackupStore();

/** 密钥安全状态：明文风险必须显式着色，不能和"无密钥"一个样子。 */
function securityLabel(entry: { secrets?: string }): string {
  if (entry.secrets === "encrypted") return "密文密钥";
  if (entry.secrets === "plaintext-risk") return "明文密钥风险";
  if (entry.secrets === "unknown") return "旧版未验证";
  return "无密钥";
}

/** Tag 的语义色：只有"明文风险"需要红色警告，其余中性。 */
function securityColor(entry: { secrets?: string }): "error" | "success" | "default" {
  if (entry.secrets === "plaintext-risk") return "error";
  if (entry.secrets === "encrypted") return "success";
  return "default";
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
  <AntdvProvider>
    <Empty
      v-if="!store.entries.length"
      class="memories-empty"
      :image="Empty.PRESENTED_IMAGE_SIMPLE"
      description="还没有备份。升级版本 / 迁移机器前建议先创建一份。"
    />
    <template v-else>
      <div v-for="entry in store.entries" :key="entry.name" class="backup-row">
        <div class="b-info">
          <div class="b-name">{{ entry.name }}</div>
          <div class="b-meta">
            {{ entry.createdAt ? new Date(entry.createdAt).toLocaleString("zh-CN") : "时间未知" }}
            · {{ entry.files.length }} 个文件 ·
            <Tag class="b-secrets" :color="securityColor(entry)">{{ securityLabel(entry) }}</Tag>
          </div>
        </div>
        <Button class="b-restore" size="small" @click="restore(entry.name)">恢复</Button>
      </div>
    </template>
  </AntdvProvider>
</template>
