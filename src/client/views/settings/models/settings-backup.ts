/**
 * ============================================================
 * views/settings-backup.ts — 备份分区装载入口（M4 批次 4.2 起）
 * ============================================================
 * 列表渲染与恢复流程已迁往 Vue（settings-backup-vue.vue + stores/backup.ts）；
 * 本文件只保留 legacy 侧职责：
 *  1. 备份列表懒加载入口 refreshBackups（设置壳 models 分区与 main 调用）；
 *  2. 创建备份入口 createBackup（main.ts 的 #backup-create-btn）。
 * Vue 面板与 store 都经动态 import 进入（1:1 过渡树静态图不得出现 .vue
 * 与裸包名 vue/pinia），本模块静态依赖图保持纯 .ts。
 */
import { uiAlert } from "../../../ui/dialog.js";
import { toast } from "../../../ui/toast.js";

/** 进入 models 分区时懒加载备份列表（失败不打扰设置流程，调用方 catch）。 */
export async function refreshBackups(): Promise<void> {
  void import("./settings-backup-vue.js")
    .then((m) => m.mountBackupVue())
    .catch(() => {});
  const { useBackupStore } = await import("../../../stores/settings/models/backup.js");
  await useBackupStore().refresh();
}

/** 创建备份（#backup-create-btn）：成功 toast，失败对话框。 */
export async function createBackup(): Promise<void> {
  try {
    const { useBackupStore } = await import("../../../stores/settings/models/backup.js");
    const res = await useBackupStore().create();
    toast(res.hint || `备份已创建：${res.name}`, "success");
  } catch (err) {
    uiAlert(`备份失败：${(err as Error).message}`, "备份");
  }
}
