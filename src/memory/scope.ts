/**
 * scope.ts — 记忆作用域的唯一构造与校验入口
 * ============================================================
 * 通用 Agent 与租房 Agent 不共享隐式作用域。所有入口先走这里归一化，
 * 避免某个路由漏传 profileId 后意外落到另一域。
 */
import type { MemoryProfileId, MemoryScope } from "./provider.js";

export const MEMORY_USER_ID = "local";
export const DEFAULT_MEMORY_PROFILE: MemoryProfileId = "general";

export function isMemoryProfileId(value: unknown): value is MemoryProfileId {
  return value === "general" || value === "estate";
}

export function memoryScope(
  profileId: unknown = DEFAULT_MEMORY_PROFILE,
  userId = MEMORY_USER_ID
): MemoryScope {
  return {
    profileId: isMemoryProfileId(profileId) ? profileId : DEFAULT_MEMORY_PROFILE,
    userId: userId.trim() || MEMORY_USER_ID,
  };
}

export function sameMemoryScope(a: MemoryScope, b: MemoryScope): boolean {
  return a.profileId === b.profileId && a.userId === b.userId;
}

export function scopeKey(scope: MemoryScope): string {
  return `${scope.userId}:${scope.profileId}`;
}
