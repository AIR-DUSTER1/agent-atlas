/**
 * ============================================================
 * audit.ts — 安全审计日志（活跃文件 + 可校验归档）
 * ============================================================
 * 职责：append-only NDJSON 审计；活跃文件超限后整文件轮转为带 SHA-256
 * 清单的归档，再按天数/份数清理。写入失败进入 error 日志、指标与诊断，
 * 但绝不向业务抛出。
 */
import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import { basename, dirname, join } from "node:path";
import { PROJECT_ROOT } from "./files.js";
import { log } from "./logging.js";
import { incCounter } from "./observability/metrics.js";
import { secureFilePermissions } from "./security/file-permissions.js";

const AUDIT_FILE = process.env.AUDIT_FILE || join(PROJECT_ROOT, ".setting", "audit.ndjson");
const AUDIT_ARCHIVE_MANIFEST = join(dirname(AUDIT_FILE), "audit-archives.json");
const DEFAULT_MAX_BYTES = 10_000_000;
const DEFAULT_KEEP_DAYS = 30;
const DEFAULT_KEEP_ARCHIVES = 50;

export interface AuditArchiveEntry {
  name: string;
  size: number;
  sha256: string;
  createdAt: number;
}

interface AuditHealth {
  activeFile: string;
  activeSize: number;
  archives: number;
  archiveBytes: number;
  lastError: string | null;
  lastErrorAt: number | null;
  checkedAt: number;
}

let lastError: string | null = null;
let lastErrorAt: number | null = null;
let operationChain: Promise<void> = Promise.resolve();
const pendingWrites = new Set<Promise<void>>();

export function auditFilePath(): string { return AUDIT_FILE; }

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

async function readArchiveManifest(): Promise<AuditArchiveEntry[]> {
  try {
    const raw = JSON.parse(await fsp.readFile(AUDIT_ARCHIVE_MANIFEST, "utf8")) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter((item): item is AuditArchiveEntry => {
      const entry = item as Partial<AuditArchiveEntry>;
      return typeof entry.name === "string" && typeof entry.size === "number" &&
        typeof entry.sha256 === "string" && typeof entry.createdAt === "number";
    });
  } catch {
    return [];
  }
}

async function writeArchiveManifest(entries: AuditArchiveEntry[]): Promise<void> {
  const tmp = AUDIT_ARCHIVE_MANIFEST + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(entries, null, 2), { encoding: "utf8", mode: 0o600 });
  await fsp.rename(tmp, AUDIT_ARCHIVE_MANIFEST);
  await secureFilePermissions(AUDIT_ARCHIVE_MANIFEST);
}

async function pruneArchives(entries: AuditArchiveEntry[]): Promise<AuditArchiveEntry[]> {
  const keepDays = intEnv("AUDIT_KEEP_DAYS", DEFAULT_KEEP_DAYS, 1, 3650);
  const keepCount = intEnv("AUDIT_KEEP_ARCHIVES", DEFAULT_KEEP_ARCHIVES, 1, 10_000);
  const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
  const sorted = [...entries].sort((a, b) => b.createdAt - a.createdAt);
  const keep = new Set(sorted.slice(0, keepCount).filter((entry) => entry.createdAt >= cutoff).map((entry) => entry.name));
  for (const entry of sorted) {
    if (keep.has(entry.name)) continue;
    await fsp.unlink(join(dirname(AUDIT_FILE), basename(entry.name))).catch(() => {});
  }
  return sorted.filter((entry) => keep.has(entry.name));
}

async function rotateIfNeeded(): Promise<void> {
  const maxBytes = intEnv("AUDIT_MAX_BYTES", DEFAULT_MAX_BYTES, 64_000, 1_000_000_000);
  const st = await fsp.stat(AUDIT_FILE).catch(() => null);
  if (!st || st.size <= maxBytes) return;
  const raw = await fsp.readFile(AUDIT_FILE);
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 17);
  const archiveName = `audit-${stamp}-${process.pid}.ndjson`;
  const archivePath = join(dirname(AUDIT_FILE), archiveName);
  await fsp.writeFile(archivePath, raw, { mode: 0o600 });
  await secureFilePermissions(archivePath);
  await fsp.writeFile(AUDIT_FILE, "", { encoding: "utf8", mode: 0o600 });
  await secureFilePermissions(AUDIT_FILE);
  const entries = await readArchiveManifest();
  entries.push({ name: archiveName, size: raw.byteLength, sha256: sha256(raw), createdAt: Date.now() });
  await writeArchiveManifest(await pruneArchives(entries));
  log("info", "audit_rotated", { archive: archiveName, bytes: raw.byteLength });
}

async function appendAudit(event: string, detail: Record<string, unknown>): Promise<void> {
  try {
    await fsp.mkdir(dirname(AUDIT_FILE), { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), ev: event, ...detail }) + "\n";
    await fsp.appendFile(AUDIT_FILE, line, "utf8");
    await secureFilePermissions(AUDIT_FILE);
    await rotateIfNeeded();
    lastError = null;
    lastErrorAt = null;
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    lastErrorAt = Date.now();
    incCounter("agent_audit_write_errors_total");
    log("error", "audit_write_failed", { message: lastError });
  }
}

export function writeAudit(event: string, detail: Record<string, unknown>): void {
  // 串行化 append/rotate，避免两个 fire-and-forget 同时滚动同一活跃文件。
  const task = operationChain.then(() => appendAudit(event, detail));
  operationChain = task.catch(() => {});
  const tracked = task.finally(() => pendingWrites.delete(tracked));
  pendingWrites.add(tracked);
}

export async function flushAudit(): Promise<void> {
  while (pendingWrites.size > 0) {
    await Promise.allSettled([...pendingWrites]);
  }
  await operationChain;
}

export async function auditArchivePaths(): Promise<Array<{ name: string; path: string }>> {
  const entries = await readArchiveManifest();
  return entries.map((entry) => ({ name: entry.name, path: join(dirname(AUDIT_FILE), entry.name) }));
}

export async function auditHealthReport(): Promise<AuditHealth> {
  const st = await fsp.stat(AUDIT_FILE).catch(() => null);
  const entries = await readArchiveManifest();
  return {
    activeFile: basename(AUDIT_FILE),
    activeSize: st?.size ?? 0,
    archives: entries.length,
    archiveBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
    lastError,
    lastErrorAt,
    checkedAt: Date.now(),
  };
}

/** 测试专用：清空进程内错误状态，不修改磁盘审计。 */
export function resetAuditStateForTests(): void {
  lastError = null;
  lastErrorAt = null;
  pendingWrites.clear();
  operationChain = Promise.resolve();
}
