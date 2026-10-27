/**
 * ============================================================
 * backup.ts — 可校验、可保留、可回滚的数据备份（v2）
 * ============================================================
 * 职责：把 journal / checkpoint / 记忆 / 加密配置 / 审计打成平铺备份集。
 * v2 manifest 记录每个文件的大小、SHA-256、schemaVersion 与密钥状态；恢复前
 * 先全量校验，再快照当前状态，任一写回失败会从自动快照回滚已替换文件。
 *
 * 设计立场：
 *  - 不引压缩包：单文件仍可人工检查与替换；
 *  - 备份可能含密文或开发模式明文 Key，manifest 必须标注 secrets 状态；
 *  - 恢复只改磁盘，内存态需重启；本函数不偷偷 reload 全局单例。
 */
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { PROJECT_ROOT } from "./files.js";
import { journalPath, flushJournal, JOURNAL_SCHEMA_VERSION } from "./session-store.js";
import { checkpointFilePath, flushCheckpointLog, CHECKPOINT_SCHEMA_VERSION } from "../checkpoint.js";
import { memoriesFilePath } from "../memory-store.js";
import { CONFIG_SCHEMA_VERSION, SETTINGS_FILE, configSecretsState } from "./config-store.js";
import { auditFilePath, flushAudit, writeAudit } from "./audit.js";
import { log } from "./logging.js";
import { secureFilePermissions } from "./security/file-permissions.js";

const DEFAULT_BACKUP_DIR = join(PROJECT_ROOT, ".setting", "backups");
export function backupRoot(): string {
  return process.env.BACKUP_DIR || DEFAULT_BACKUP_DIR;
}

function backupTargets(): Array<{ key: string; path: string; schemaVersion: number | null }> {
  return [
    { key: "sessions.ndjson", path: journalPath(), schemaVersion: JOURNAL_SCHEMA_VERSION },
    { key: "checkpoints.ndjson", path: checkpointFilePath(), schemaVersion: CHECKPOINT_SCHEMA_VERSION },
    { key: "memories.json", path: memoriesFilePath(), schemaVersion: null },
    { key: "web-config.json", path: SETTINGS_FILE, schemaVersion: CONFIG_SCHEMA_VERSION },
    { key: "audit.ndjson", path: auditFilePath(), schemaVersion: null },
  ];
}

const NAME_RE = /^backup-\d{8}-\d{6}(?:-\d{1,3})*$/;
const KEEP_LATEST_DEFAULT = 7;
const KEEP_DAYS_DEFAULT = 7;

export interface BackupFileEntry {
  name: string;
  bytes: number;
  sha256: string;
  schemaVersion: number | null;
}

export interface BackupManifestV2 {
  version: 2;
  createdAt: number;
  files: BackupFileEntry[];
  secrets: "encrypted" | "plaintext-risk" | "none";
  schemaVersions: Record<string, number | null>;
}

interface BackupManifestV1 {
  version: 1;
  createdAt: number;
  files: string[];
}

export interface BackupInfo {
  name: string;
  createdAt: number;
  files: string[];
  manifestVersion: 1 | 2;
  secrets: "encrypted" | "plaintext-risk" | "none" | "unknown";
  verified: boolean;
}

export interface BackupAudit {
  total: number;
  valid: number;
  invalid: number;
  issues: Array<{ name: string; reason: string }>;
}

async function fileExists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null)) !== null;
}

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

async function hashFile(path: string): Promise<string> {
  return sha256(await readFile(path));
}

export async function fileSha256(path: string): Promise<string> {
  return hashFile(path);
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) return fallback;
  return value;
}

function retentionLimits(): { latest: number; days: number } {
  return {
    latest: clampInt(process.env.BACKUP_KEEP_LATEST, KEEP_LATEST_DEFAULT, 1, 365),
    days: clampInt(process.env.BACKUP_KEEP_DAYS, KEEP_DAYS_DEFAULT, 1, 3650),
  };
}

async function nextBackupName(): Promise<string> {
  const d = new Date();
  const p = (n: number, len = 2) => String(n).padStart(len, "0");
  let name = `backup-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
  for (let i = 0; i < 10 && await fileExists(join(backupRoot(), name, "manifest.json")); i += 1) {
    name = `${name}-${i}`;
  }
  return name;
}

function assertInsideBackupRoot(target: string): void {
  const root = resolve(backupRoot());
  const child = resolve(target);
  const rel = relative(root, child);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("备份路径越界，已拒绝");
}

function normalizeManifest(value: unknown): BackupManifestV1 | BackupManifestV2 {
  if (!value || typeof value !== "object") throw new Error("manifest 形状不正确");
  const raw = value as Record<string, unknown>;
  if (raw.version === 2 && Array.isArray(raw.files)) {
    const files: BackupFileEntry[] = [];
    for (const item of raw.files) {
      const f = item as Partial<BackupFileEntry>;
      if (typeof f.name !== "string" || typeof f.bytes !== "number" || typeof f.sha256 !== "string") {
        throw new Error("manifest 文件条目损坏");
      }
      files.push({ name: f.name, bytes: f.bytes, sha256: f.sha256, schemaVersion: typeof f.schemaVersion === "number" ? f.schemaVersion : null });
    }
    return {
      version: 2,
      createdAt: typeof raw.createdAt === "number" ? raw.createdAt : 0,
      files,
      secrets: raw.secrets === "encrypted" || raw.secrets === "plaintext-risk" ? raw.secrets : "none",
      schemaVersions: raw.schemaVersions && typeof raw.schemaVersions === "object" ? raw.schemaVersions as Record<string, number | null> : {},
    };
  }
  if (raw.version === 1 && Array.isArray(raw.files)) {
    return {
      version: 1,
      createdAt: typeof raw.createdAt === "number" ? raw.createdAt : 0,
      files: raw.files.filter((f): f is string => typeof f === "string"),
    };
  }
  throw new Error("manifest 版本不受支持");
}

async function loadManifest(name: string): Promise<BackupManifestV1 | BackupManifestV2> {
  if (!NAME_RE.test(name)) throw new Error("备份名格式不对（应为 backup-日期-时间，从备份列表里选择）");
  const dir = join(backupRoot(), name);
  try {
    return normalizeManifest(JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")));
  } catch (err) {
    if (err instanceof Error && /版本不受支持/.test(err.message)) throw err;
    throw new Error(`备份 ${name} 不存在或 manifest 损坏`);
  }
}

async function verifyManifest(name: string, manifest: BackupManifestV1 | BackupManifestV2): Promise<void> {
  const dir = join(backupRoot(), name);
  if (manifest.version === 1) {
    if (!manifest.files.length) throw new Error(`备份 ${name} 里没有数据文件，无法恢复`);
    for (const file of manifest.files) {
      if (!(await fileExists(join(dir, basename(file))))) throw new Error(`旧版备份缺少文件：${file}`);
    }
    return;
  }
  if (!manifest.files.length) throw new Error(`备份 ${name} 里没有数据文件，无法恢复`);
  for (const entry of manifest.files) {
    const path = join(dir, basename(entry.name));
    const st = await stat(path).catch(() => null);
    if (!st?.isFile()) throw new Error(`备份文件缺失：${entry.name}`);
    if (st.size !== entry.bytes) throw new Error(`备份文件大小不匹配：${entry.name}`);
    const actual = await hashFile(path);
    if (actual !== entry.sha256) throw new Error(`备份文件校验失败（可能被篡改）：${entry.name}`);
  }
}

function infoFromManifest(name: string, manifest: BackupManifestV1 | BackupManifestV2, verified: boolean): BackupInfo {
  return {
    name,
    createdAt: manifest.createdAt,
    files: manifest.version === 1 ? manifest.files : manifest.files.map((f) => f.name),
    manifestVersion: manifest.version,
    secrets: manifest.version === 1 ? "unknown" : manifest.secrets,
    verified,
  };
}

async function pruneBackups(): Promise<number> {
  const backups = await listBackups();
  const limits = retentionLimits();
  const keep = new Set(backups.slice(0, limits.latest).map((b) => b.name));
  const days = new Set<string>();
  for (const backup of backups) {
    const day = new Date(backup.createdAt || 0).toISOString().slice(0, 10);
    if (days.has(day) || days.size >= limits.days) continue;
    days.add(day);
    keep.add(backup.name);
  }
  let removed = 0;
  for (const backup of backups) {
    if (keep.has(backup.name)) continue;
    const dir = resolve(backupRoot(), backup.name);
    assertInsideBackupRoot(dir);
    await rm(dir, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

/** 创建备份：flush → 复制 → manifest(v2) → 权限收紧 → 保留策略。 */
export async function createBackup(): Promise<BackupInfo> {
  await flushJournal();
  await flushCheckpointLog();
  await flushAudit();
  await mkdir(backupRoot(), { recursive: true });
  await secureFilePermissions(backupRoot(), true);

  const name = await nextBackupName();
  const dir = join(backupRoot(), name);
  await mkdir(dir, { recursive: false });
  await secureFilePermissions(dir, true);

  const fileEntries: BackupFileEntry[] = [];
  const schemaVersions: Record<string, number | null> = {};
  for (const target of backupTargets()) {
    const st = await stat(target.path).catch(() => null);
    if (!st?.isFile()) {
      schemaVersions[target.key] = target.schemaVersion;
      continue;
    }
    const destination = join(dir, target.key);
    await copyFile(target.path, destination);
    await secureFilePermissions(destination);
    fileEntries.push({
      name: target.key,
      bytes: st.size,
      sha256: await hashFile(target.path),
      schemaVersion: target.schemaVersion,
    });
    schemaVersions[target.key] = target.schemaVersion;
  }

  const manifest: BackupManifestV2 = {
    version: 2,
    createdAt: Date.now(),
    files: fileEntries,
    secrets: await configSecretsState(),
    schemaVersions,
  };
  const manifestPath = join(dir, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), { encoding: "utf8", mode: 0o600 });
  await secureFilePermissions(manifestPath);
  const pruned = await pruneBackups();
  log("info", "backup_created", { name, files: fileEntries.length, secrets: manifest.secrets, pruned });
  return infoFromManifest(name, manifest, true);
}

/** 列出全部备份；manifest 损坏的目录跳过，完整性问题走 auditBackups。 */
export async function listBackups(): Promise<BackupInfo[]> {
  const root = backupRoot();
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const result: BackupInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !NAME_RE.test(entry.name)) continue;
    try {
      const manifest = await loadManifest(entry.name);
      result.push(infoFromManifest(entry.name, manifest, manifest.version === 2));
    } catch {
      /* 坏 manifest 不进入 UI 列表；data:check 会报告 */
    }
  }
  return result.sort((a, b) => b.createdAt - a.createdAt);
}

/** 对全部备份做文件级校验，供 data:check / 诊断使用。 */
export async function auditBackups(): Promise<BackupAudit> {
  const root = backupRoot();
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const dirs = entries.filter((entry) => entry.isDirectory() && NAME_RE.test(entry.name));
  const issues: BackupAudit["issues"] = [];
  for (const entry of dirs) {
    try {
      const manifest = await loadManifest(entry.name);
      await verifyManifest(entry.name, manifest);
    } catch (err) {
      issues.push({ name: entry.name, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return { total: dirs.length, valid: dirs.length - issues.length, invalid: issues.length, issues };
}

/** 恢复：先校验全部文件，再快照当前态；写回失败时从快照回滚已替换项。 */
export async function restoreBackup(name: string): Promise<{ restored: string[]; autoSnapshot: string; verified: boolean }> {
  const manifest = await loadManifest(name);
  await verifyManifest(name, manifest);
  const snapshot = await createBackup();
  const snapshotDir = join(backupRoot(), snapshot.name);
  const sourceDir = join(backupRoot(), name);
  const targets = new Map(backupTargets().map((t) => [t.key, t.path]));

  const selected: Array<{ key: string; source: string; dest: string; tmp: string }> = [];
  for (const file of manifest.files) {
    const key = typeof file === "string" ? file : file.name;
    const safeKey = basename(key);
    const dest = targets.get(safeKey);
    if (!dest) continue;
    const source = join(sourceDir, safeKey);
    if (!(await fileExists(source))) continue;
    selected.push({ key: safeKey, source, dest, tmp: `${dest}.restore.tmp` });
  }
  if (!selected.length) throw new Error(`备份 ${name} 没有可恢复的文件`);

  try {
    for (const item of selected) await copyFile(item.source, item.tmp);
  } catch (err) {
    await Promise.all(selected.map((item) => unlink(item.tmp).catch(() => {})));
    throw err;
  }

  const restored: string[] = [];
  try {
    for (const item of selected) {
      await rename(item.tmp, item.dest);
      restored.push(item.key);
    }
  } catch (err) {
    for (const key of restored) {
      const dest = targets.get(key)!;
      const snapshotFile = join(snapshotDir, key);
      if (await fileExists(snapshotFile)) {
        const rollbackTmp = `${dest}.rollback.tmp`;
        await copyFile(snapshotFile, rollbackTmp).catch(() => {});
        await rename(rollbackTmp, dest).catch(() => {});
      } else {
        await unlink(dest).catch(() => {});
      }
    }
    await Promise.all(selected.map((item) => unlink(item.tmp).catch(() => {})));
    throw new Error(`恢复写入失败，已从 ${snapshot.name} 回滚已替换文件：${err instanceof Error ? err.message : String(err)}`);
  }

  writeAudit("backup.restored", { name, files: restored.length, autoSnapshot: snapshot.name, verified: manifest.version === 2 });
  log("info", "backup_restored", { name, restored: restored.length, verified: manifest.version === 2 });
  return { restored, autoSnapshot: snapshot.name, verified: manifest.version === 2 };
}
