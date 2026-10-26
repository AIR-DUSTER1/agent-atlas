/**
 * ============================================================
 * views/settings-backup.ts — 设置页「备份与恢复」分区
 * ============================================================
 * 职责：备份列表渲染、创建备份、从备份恢复（恢复前自动快照当前状态）。
 * 设计立场：
 *  - 恢复是破坏性动作：二次确认写明「会先自动快照」与「需重启生效」；
 *  - 备份目录含 API Key 明文，创建成功后的提示里要再次提醒保管；
 *  - 列表失败不让设置页整体挂掉（调用方 catch 掉）。
 */

import { $ } from "../core/dom.js";
import { api } from "../core/api.js";
import { uiAlert, uiConfirm } from "../modules/ui-dialog.js";
import type { BackupEntry } from "../modules/types.js";

export async function refreshBackups(): Promise<void> {
  const data = await api<{ backups?: BackupEntry[] }>("/api/backup");
  const list = $("backup-list");
  if (!list) return;
  list.innerHTML = "";
  const backups = data.backups || [];
  if (!backups.length) {
    const empty = document.createElement("p");
    empty.className = "memories-empty";
    empty.textContent = "还没有备份。升级版本 / 迁移机器前建议先创建一份。";
    list.appendChild(empty);
    return;
  }
  for (const b of backups) {
    const row = document.createElement("div");
    row.className = "backup-row";
    row.innerHTML = `<div class="b-info"><div class="b-name"></div><div class="b-meta"></div></div><button class="ghost-btn small b-restore">恢复</button>`;
    const nameEl = row.querySelector(".b-name");
    if (nameEl) nameEl.textContent = b.name;
    const when = b.createdAt ? new Date(b.createdAt).toLocaleString("zh-CN") : "时间未知";
    const metaEl = row.querySelector(".b-meta");
    if (metaEl) metaEl.textContent = `${when} · ${b.files.length} 个文件`;
    row.querySelector(".b-restore")?.addEventListener("click", async () => {
      const ok = await uiConfirm(
        `确定恢复备份 ${b.name} 吗？\n\n恢复前会自动创建一份当前状态的快照（可退回）。\n恢复后需要重启服务（npm run web）才生效。`,
        { title: "恢复备份", okText: "恢复" }
      );
      if (!ok) return;
      try {
        const res = await api<{ hint?: string }>("/api/restore", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: b.name }),
        });
        uiAlert(res.hint || "已恢复，请重启服务生效", "恢复完成");
        await refreshBackups();
      } catch (err) {
        uiAlert(`恢复失败：${(err as Error).message}`, "恢复备份");
      }
    });
    list.appendChild(row);
  }
}

export async function createBackup(): Promise<void> {
  try {
    const res = await api<{ hint?: string; name: string }>("/api/backup", { method: "POST" });
    uiAlert(res.hint || `备份已创建：${res.name}`, "备份完成");
    await refreshBackups();
  } catch (err) {
    uiAlert(`备份失败：${(err as Error).message}`, "备份");
  }
}
