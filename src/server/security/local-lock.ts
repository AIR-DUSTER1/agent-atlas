/**
 * ============================================================
 * security/local-lock.ts — 文件模式的本地访问密码锁（用户体系改造 U3）
 * ============================================================
 * 职责：file 后端的单用户密码锁。密码哈希存 `.setting/local-user.json`
 * （0600，gitignore——哈希不等于密钥，但也不该进仓库）。
 *
 * 设计立场：
 *  - 未设锁时现状行为完全不变（AUTH_TOKEN 配对 / 本机回环免登）；
 *  - 设锁后：AUTH_TOKEN 仍可配对（救援通道），访问密码也可以配对；
 *  - 忘记密码走 CLI 解锁（scripts/clear-local-lock.ts），依赖本机文件权限。
 */
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hashPassword, verifyPassword } from "./password.js";
import { secureFilePermissions } from "./file-permissions.js";
import { log } from "../logging.js";

const LOCAL_LOCK_FILE = process.env.LOCAL_LOCK_FILE
  || join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".setting", "local-user.json");

export interface LocalLockState {
  passwordHash: string;
  displayName: string;
  updatedAt: number;
}

let cached: LocalLockState | null | undefined;

function resolveLockFile(): string {
  return process.env.LOCAL_LOCK_FILE || LOCAL_LOCK_FILE;
}

/** 读锁状态；未设锁返回 null。读损坏文件按「未设锁」处理并告警（不阻断启动）。 */
export async function getLocalLock(): Promise<LocalLockState | null> {
  if (cached !== undefined) return cached;
  const raw = await readFile(resolveLockFile(), "utf8").catch(() => null);
  if (raw === null) {
    cached = null;
    return cached;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LocalLockState>;
    if (parsed && typeof parsed.passwordHash === "string" && parsed.passwordHash) {
      cached = {
        passwordHash: parsed.passwordHash,
        displayName: typeof parsed.displayName === "string" && parsed.displayName ? parsed.displayName : "本地用户",
        updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
      };
      return cached;
    }
  } catch {
    log("warn", "local_lock_corrupted", { file: resolveLockFile() });
  }
  cached = null;
  return cached;
}

export async function hasLocalLock(): Promise<boolean> {
  return (await getLocalLock()) !== null;
}

/** 设置 / 更新本地密码锁；写入后 0600。 */
export async function setLocalLock(password: string, displayName = "本地用户"): Promise<void> {
  const state: LocalLockState = {
    passwordHash: await hashPassword(password),
    displayName,
    updatedAt: Date.now(),
  };
  const file = resolveLockFile();
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  await secureFilePermissions(tmp);
  await rename(tmp, file);
  await secureFilePermissions(file);
  cached = state;
}

/** 清除密码锁（CLI 解锁 / 设置页清除）；文件不存在时静默成功。 */
export async function clearLocalLock(): Promise<void> {
  const { rm } = await import("node:fs/promises");
  await rm(resolveLockFile(), { force: true });
  cached = null;
}

/** 校验访问密码；未设锁返回 false（调用方不应把无锁当作验证通过）。 */
export async function verifyLocalLockPassword(password: string): Promise<boolean> {
  const state = await getLocalLock();
  if (!state) return false;
  return verifyPassword(password, state.passwordHash);
}

/** 测试钩子：清空内存缓存并删掉测试锁文件之外的缓存态。 */
export function resetLocalLockCacheForTests(): void {
  cached = undefined;
}
