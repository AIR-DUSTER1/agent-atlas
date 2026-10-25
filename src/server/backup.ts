/**
 * ============================================================
 * backup.ts — 数据备份与恢复（F9，可用性主线收尾）
 * ============================================================
 * 把「全部本地状态」一键快照到带时间戳的目录并可恢复：
 *   journal（会话记录）/ 持久检查点 / 长期记忆 / 供应商配置 / 审计日志。
 * 换机、误删、版本升级前各来一份，恢复 = 目录内容写回原路径 + 重启服务。
 *
 * 设计立场：
 * - 不做压缩打包：平铺目录 + manifest.json，肉眼可检、单文件可替换；
 * - ⚠ 备份含 API Key（web-config.json 里是明文）——目录放 .setting/backups/
 *   （gitignore 内），README 明确警示「妥善保管、不要外发」；
 * - 恢复前自动做一次「恢复前快照」：先 flush 全部在途写入 → 备份当前态 →
 *   覆盖文件；恢复只动磁盘、不动内存单例 —— 必须重启服务才真正生效
 *   （内存里的 journal/配置会把旧态写回去）；
 * - 写回用临时文件 + rename 原子替换（config-store 同模式），半写不损坏原文件。
 */
import { copyFile, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PROJECT_ROOT } from "./files.js";
import { journalPath, flushJournal } from "./session-store.js";
import { checkpointFilePath, flushCheckpointLog } from "../checkpoint.js";
import { memoriesFilePath } from "../memory-store.js";
import { SETTINGS_FILE } from "./config-store.js";
import { auditFilePath, flushAudit, writeAudit } from "./audit.js";
import { log } from "./logging.js";

// 测试钩子：BACKUP_DIR 指向临时目录（不污染真实 .setting/backups）
const DEFAULT_BACKUP_DIR = join(PROJECT_ROOT, ".setting", "backups");
function backupRoot(): string {
  return process.env.BACKUP_DIR || DEFAULT_BACKUP_DIR;
}

/** 备份集：key = 备份内的文件名，path = 当前实际生效路径（env 钩子随之变化） */
function backupTargets(): Array<{ key: string; path: string }> {
  return [
    { key: "sessions.ndjson", path: journalPath() },
    { key: "checkpoints.ndjson", path: checkpointFilePath() },
    { key: "memories.json", path: memoriesFilePath() },
    { key: "web-config.json", path: SETTINGS_FILE },
    { key: "audit.ndjson", path: auditFilePath() },
  ];
}

/** 备份目录名：backup-<yyyyMMdd-HHmmss[-SSS][-NN]>
 *  毫秒段与序号段防「恢复前快照与原备份同秒碰撞」（踩过：快照把破坏态
 *  覆盖进刚创建的同名备份目录，恢复出来的就是坏数据）。
 *  白名单严格限制为纯数字段（天然防路径穿越）。 */
const NAME_RE = /^backup-\d{8}-\d{6}(?:-\d{1,3})*$/;

async function nextBackupName(): Promise<string> {
  const d = new Date();
  const p = (n: number, len = 2) => String(n).padStart(len, "0");
  let name = `backup-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
  // 同毫秒仍在撞（理论场景）就追加序号段
  for (let i = 0; i < 10 && await fileExists(join(backupRoot(), name, "manifest.json")); i += 1) {
    name = `${name}-${i}`;
  }
  return name;
}

export interface BackupManifest {
  version: 1;
  createdAt: number;
  files: string[]; // 实际包含的数据文件名
}

export interface BackupInfo {
  name: string;
  createdAt: number;
  files: string[];
}

async function fileExists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null)) !== null;
}

/** 创建一份备份：flush 在途写入 → 拷贝存在的数据文件 → 写 manifest */
export async function createBackup(): Promise<BackupInfo> {
  // flush 让「恢复前快照」也拿到完整状态；平时创建备份同样受益（尾部不缺行）
  await flushJournal();
  await flushCheckpointLog();
  await flushAudit();

  const name = await nextBackupName();
  const dir = join(backupRoot(), name);
  await mkdir(dir, { recursive: true });
  const files: string[] = [];
  for (const { key, path } of backupTargets()) {
    if (!(await fileExists(path))) continue; // 没有过的数据不造空文件
    await copyFile(path, join(dir, key));
    files.push(key);
  }
  const manifest: BackupManifest = { version: 1, createdAt: Date.now(), files };
  await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  log("info", "backup_created", { name, files: files.length });
  return { name, createdAt: manifest.createdAt, files };
}

/** 列出全部备份（读 manifest；坏目录跳过） */
export async function listBackups(): Promise<BackupInfo[]> {
  const root = backupRoot();
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [] as Array<{ name: string; isDirectory: () => boolean }>);
  const result: BackupInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !NAME_RE.test(entry.name)) continue;
    try {
      const manifest = JSON.parse(await readFile(join(root, entry.name, "manifest.json"), "utf8")) as Partial<BackupManifest>;
      if (!Array.isArray(manifest.files)) continue;
      result.push({ name: entry.name, createdAt: manifest.createdAt ?? 0, files: manifest.files });
    } catch {
      /* 坏 manifest 的目录直接不展示 */
    }
  }
  return result.sort((a, b) => b.createdAt - a.createdAt);
}

/** 恢复指定备份：先快照当前态 → 校验 manifest → 原子写回各文件。
 *  只动磁盘不动内存 —— 返回后调用方必须提示用户重启服务。 */
export async function restoreBackup(name: string): Promise<{ restored: string[]; autoSnapshot: string }> {
  if (!NAME_RE.test(name)) {
    throw new Error("备份名格式不对（应为 backup-日期-时间，从备份列表里选择）");
  }
  const dir = join(backupRoot(), name);
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as BackupManifest;
  } catch {
    throw new Error(`备份 ${name} 不存在或 manifest 损坏`);
  }
  if (!Array.isArray(manifest.files) || !manifest.files.length) {
    throw new Error(`备份 ${name} 里没有数据文件，无法恢复`);
  }

  // 恢复前快照：先把「当前态」完整落一份，误恢复也能退回来
  const snapshot = await createBackup();

  const targets = new Map(backupTargets().map((t) => [t.key, t.path]));
  const restored: string[] = [];
  for (const key of manifest.files) {
    const dest = targets.get(key);
    if (!dest) continue; // 未来版本新增的条目、本版本不认识 → 跳过
    const src = join(dir, key);
    if (!(await fileExists(src))) continue;
    // 原子写回：临时文件 + rename（半写不会损坏目标）
    const tmp = `${dest}.restore.tmp`;
    await copyFile(src, tmp);
    await rename(tmp, dest);
    restored.push(key);
  }
  if (!restored.length) throw new Error(`备份 ${name} 没有可恢复的文件`);
  writeAudit("backup.restored", { name, files: restored.length, autoSnapshot: snapshot.name });
  log("info", "backup_restored", { name, restored: restored.length });
  return { restored, autoSnapshot: snapshot.name };
}
