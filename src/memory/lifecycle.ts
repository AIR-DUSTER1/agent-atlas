/**
 * memory/lifecycle.ts — 记忆状态、有效期与淘汰策略
 * ============================================================
 * 纯函数负责 candidate / active / stale / superseded / archived 的时间推进，
 * 存储层只负责把变化写入事件日志。这样 TTL 与保留策略可单测，不依赖文件或模型。
 */
import type { MemoryCategory, MemoryRecord } from "./provider.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface MemoryLifecyclePolicy {
  staleGraceDays: number;
  preferenceDays: number;
  projectFactDays: number;
  correctionDays: number;
  identityDays: number;
}

export const DEFAULT_LIFECYCLE_POLICY: MemoryLifecyclePolicy = {
  staleGraceDays: 30,
  preferenceDays: 180,
  projectFactDays: 120,
  correctionDays: 365,
  identityDays: 365,
};

let policy: MemoryLifecyclePolicy = { ...DEFAULT_LIFECYCLE_POLICY };

export function configureMemoryLifecycle(next: Partial<MemoryLifecyclePolicy> | null): void {
  policy = { ...DEFAULT_LIFECYCLE_POLICY, ...(next ?? {}) };
}

export function lifecyclePolicy(): MemoryLifecyclePolicy {
  return { ...policy };
}

export function categoryDays(category: MemoryCategory | undefined): number {
  if (category === "preference") return policy.preferenceDays;
  if (category === "project_fact") return policy.projectFactDays;
  if (category === "correction") return policy.correctionDays;
  if (category === "identity") return policy.identityDays;
  return policy.preferenceDays;
}

export function expirationForCategory(category: MemoryCategory | undefined, now = Date.now()): number {
  return now + categoryDays(category) * DAY_MS;
}

export interface LifecycleResult {
  records: MemoryRecord[];
  changed: boolean;
}

/** 只推进时间状态，不改内容；调用方在 changed=true 时落一条快照/事件。 */
export function applyLifecycleTransitions(records: MemoryRecord[], now = Date.now()): LifecycleResult {
  let changed = false;
  const next = records.map((input) => {
    const record = { ...input, tags: [...input.tags], scope: { ...input.scope } };
    if (record.status === "candidate" && record.expiresAt && record.expiresAt <= now) {
      record.status = "archived";
      record.staleAt = now;
      changed = true;
      return record;
    }
    if (record.status === "active" && record.expiresAt && record.expiresAt <= now) {
      record.status = "stale";
      record.staleAt = now;
      changed = true;
      return record;
    }
    if (record.status === "stale" && record.staleAt && record.staleAt + policy.staleGraceDays * DAY_MS <= now) {
      record.status = "archived";
      changed = true;
    }
    return record;
  });
  return { records: next, changed };
}