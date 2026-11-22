/**
 * ============================================================
 * stores/backup.ts — 备份列表（框架迁移 M4 批次 4.2）
 * ============================================================
 * 职责：备份与恢复分区的业务状态与写回；确认对话与提示文案留在组件层。
 * 设计立场：恢复是破坏性动作，服务端会先自动快照；失败向上抛给组件提示。
 */
import { defineStore } from "pinia";
import { api } from "../../../core/api.js";
import type { BackupEntry } from "../../../modules/types.js";
import "../../pinia.js";

export const useBackupStore = defineStore("backup", {
  state: () => ({
    entries: [] as BackupEntry[],
    loaded: false,
  }),
  actions: {
    async refresh(): Promise<void> {
      const data = await api<{ backups?: BackupEntry[] }>("/api/backup");
      this.entries = data.backups ?? [];
      this.loaded = true;
    },
    /** 创建备份；返回服务端提示与名称。 */
    async create(): Promise<{ hint?: string; name: string }> {
      const res = await api<{ hint?: string; name: string }>("/api/backup", { method: "POST" });
      await this.refresh();
      return res;
    },
    /** 恢复备份（服务端先自动快照，重启后生效）；失败向上抛。 */
    async restore(name: string): Promise<{ hint?: string }> {
      const res = await api<{ hint?: string }>("/api/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      await this.refresh();
      return res;
    },
  },
});
