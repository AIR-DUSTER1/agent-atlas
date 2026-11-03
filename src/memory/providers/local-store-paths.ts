/**
 * memory/providers/local-store-paths.ts — 本地记忆路径与原子文件原语
 * ============================================================
 * 这一层只处理路径、目录、临时文件、fsync 与 rename；不解释记忆记录。
 * 所有业务代码只通过 local-store 获取路径，避免测试与备份各自拼目录。
 */
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_STORE_DIR = join(MODULE_DIR, "..", "..", "..", ".setting", "memory-store");
export const DEFAULT_LEGACY_FILE = join(MODULE_DIR, "..", "..", "..", ".setting", "memories.json");

export function resolveMemoryStoreDir(): string {
  if (process.env.MEMORY_STORE_DIR?.trim()) return resolve(process.env.MEMORY_STORE_DIR.trim());
  if (process.env.MEMORIES_FILE?.trim()) {
    const legacy = resolve(process.env.MEMORIES_FILE.trim());
    return join(dirname(legacy), "memory-store");
  }
  return resolve(DEFAULT_STORE_DIR);
}

export function resolveLegacyMemoryFile(): string {
  return process.env.MEMORIES_FILE?.trim() ? resolve(process.env.MEMORIES_FILE.trim()) : resolve(DEFAULT_LEGACY_FILE);
}

export function scopeDirectoryName(profileId: string, userId: string): string {
  const safeProfile = profileId.replace(/[^A-Za-z0-9._-]/g, "_") || "general";
  const safeUser = userId.replace(/[^A-Za-z0-9._-]/g, "_") || "local";
  return `${safeUser}--${safeProfile}`;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

export async function readUtf8(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
}

export async function atomicWrite(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  const handle = await open(tmp, "w");
  try {
    await handle.writeFile(body, "utf8");
    await handle.sync();
    await handle.close();
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(tmp).catch(() => {});
    throw error;
  }
  try {
    await rename(tmp, path);
  } catch (error) {
    // Windows 目标已存在时 rename 偶发 EPERM：删除目标后重试一次。
    await unlink(path).catch(() => {});
    try {
      await rename(tmp, path);
    } catch (retryError) {
      await unlink(tmp).catch(() => {});
      throw retryError ?? error;
    }
  }
}

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await atomicWrite(path, JSON.stringify(value, null, 2));
}

export async function createEmptyFile(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "", { encoding: "utf8", flag: "a" });
}