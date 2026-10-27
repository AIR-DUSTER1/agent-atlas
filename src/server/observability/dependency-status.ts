/**
 * observability/dependency-status.ts — 外部依赖最近状态
 * ============================================================
 * 只保留固定依赖 id 与脱敏摘要；不记录请求 URL、凭据或响应正文。
 */
export type DependencyState = "unknown" | "ok" | "degraded" | "down";

const states = new Map<string, { state: DependencyState; message: string; checkedAt: number }>();

export function recordDependency(id: string, state: DependencyState, message: string): void {
  states.set(id, { state, message: message.slice(0, 240), checkedAt: Date.now() });
}

export function listDependencyStatuses(): Array<{ id: string; state: DependencyState; message: string; checkedAt: number }> {
  return [...states.entries()].map(([id, value]) => ({ id, ...value })).sort((a, b) => a.id.localeCompare(b.id));
}

export function resetDependencyStatusForTests(): void {
  states.clear();
}
