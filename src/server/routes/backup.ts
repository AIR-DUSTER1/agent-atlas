/**
 * routes/backup.ts — 备份与恢复路由（F9）
 * ============================================================
 * POST /api/backup          创建备份（返回目录名与包含的文件）
 * GET  /api/backup          列出全部备份
 * POST /api/restore {name}  恢复指定备份（先自动做恢复前快照）
 *
 * 安全边界动作：audit 记备份创建与恢复（条数/文件数，不含内容）。
 * 恢复只写磁盘不动内存单例 —— 响应里带「需重启」提示由前端转达。
 */
import { readBody, respondBadRequest } from "../http-body.js";
import { createBackup, listBackups, restoreBackup } from "../backup.js";
import { writeAudit } from "../audit.js";

export async function handleCreateBackup(res: import("node:http").ServerResponse): Promise<void> {
  try {
    const info = await createBackup();
    writeAudit("backup.created", { name: info.name, files: info.files.length });
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      ok: true,
      ...info,
      hint: info.secrets === "encrypted"
        ? "备份已创建，敏感配置为 AES-256-GCM 密文；仍请妥善保管备份目录，不要外发"
        : "备份已创建，但当前配置含明文密钥风险（未设置 DATA_KEY）；请立即收紧目录权限，不要外发",
    }));
  } catch (err) {
    respondBadRequest(res, {} as import("node:http").IncomingMessage, err);
  }
}

export async function handleListBackups(res: import("node:http").ServerResponse): Promise<void> {
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ backups: await listBackups() }));
}

export async function handleRestoreBackup(
  res: import("node:http").ServerResponse,
  req: import("node:http").IncomingMessage
): Promise<void> {
  const body = JSON.parse((await readBody(req)) || "{}") as { name?: unknown };
  const name = typeof body.name === "string" ? body.name : "";
  if (!name) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "缺少备份名（name）" }));
    return;
  }
  try {
    const result = await restoreBackup(name);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      ok: true,
      ...result,
      hint: `已恢复 ${result.restored.length} 个文件。当前进程仍在使用内存里的旧状态 —— 请重启服务（npm run web）后生效`,
    }));
  } catch (err) {
    respondBadRequest(res, req, err);
  }
}
