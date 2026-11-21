/**
 * ============================================================
 * security/account-lock.ts — 账户级登录锁定
 * ============================================================
 * IP 维度限流（authFailureLimiter）之外的第二道防线：同一用户名连续
 * 失败 ACCOUNT_LOCK_THRESHOLD 次后锁定 ACCOUNT_LOCK_WINDOW_MS。
 *
 * 已知边界（有意为之，与单实例红线一致）：
 *  - 计数在进程内存里，重启即清零——攻击者重启服务无法绕过（需要本机权限），
 *    但不要把它当成跨重启的强审计；审计日志里另有 auth_login_locked 记录；
 *  - 多实例部署不共享本表——本产品 SSE/限流/浏览器会话均按单实例设计。
 */
import { writeAudit } from "../audit.js";

export const ACCOUNT_LOCK_THRESHOLD = 10;
export const ACCOUNT_LOCK_WINDOW_MS = 15 * 60_000;

export interface AccountLockDecision {
  locked: boolean;
  /** 锁定剩余秒数；未锁定为 0。 */
  retryAfterSeconds: number;
  /** 锁定前剩余可尝试次数。 */
  remaining: number;
}

interface LockEntry {
  failures: number[];
  lockedUntil: number;
}

const locks = new Map<string, LockEntry>();

function prune(entry: LockEntry, now: number): void {
  entry.failures = entry.failures.filter((ts) => now - ts < ACCOUNT_LOCK_WINDOW_MS);
  if (entry.lockedUntil && entry.lockedUntil <= now) entry.lockedUntil = 0;
}

/** 检查用户名是否处于锁定期；不产生任何写入。 */
export function checkAccountLock(username: string, now = Date.now()): AccountLockDecision {
  const entry = locks.get(username);
  if (!entry) {
    return { locked: false, retryAfterSeconds: 0, remaining: ACCOUNT_LOCK_THRESHOLD };
  }
  prune(entry, now);
  if (entry.lockedUntil > now) {
    return {
      locked: true,
      retryAfterSeconds: Math.max(1, Math.ceil((entry.lockedUntil - now) / 1000)),
      remaining: 0,
    };
  }
  return {
    locked: false,
    retryAfterSeconds: 0,
    remaining: Math.max(0, ACCOUNT_LOCK_THRESHOLD - entry.failures.length),
  };
}

/** 记录一次登录失败；达到阈值时锁定并写审计（绝不记录密码）。 */
export function recordAccountFailure(username: string, ipTag: string, now = Date.now()): AccountLockDecision {
  let entry = locks.get(username);
  if (!entry) {
    entry = { failures: [], lockedUntil: 0 };
    locks.set(username, entry);
  }
  prune(entry, now);
  if (entry.lockedUntil > now) {
    return {
      locked: true,
      retryAfterSeconds: Math.max(1, Math.ceil((entry.lockedUntil - now) / 1000)),
      remaining: 0,
    };
  }
  entry.failures.push(now);
  if (entry.failures.length >= ACCOUNT_LOCK_THRESHOLD) {
    entry.lockedUntil = now + ACCOUNT_LOCK_WINDOW_MS;
    writeAudit("auth_login_locked", { ip: ipTag, username });
    return { locked: true, retryAfterSeconds: Math.ceil(ACCOUNT_LOCK_WINDOW_MS / 1000), remaining: 0 };
  }
  return {
    locked: false,
    retryAfterSeconds: 0,
    remaining: Math.max(0, ACCOUNT_LOCK_THRESHOLD - entry.failures.length),
  };
}

/** 登录成功后清零该用户的失败计数。 */
export function clearAccountFailures(username: string): void {
  locks.delete(username);
}

/** 测试钩子：清空全部锁定状态。 */
export function resetAccountLocksForTests(): void {
  locks.clear();
}
