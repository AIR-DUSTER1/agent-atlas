/**
 * ============================================================
 * routing/state.ts — 路由配置的运行时只读镜像
 * ============================================================
 * 职责：把设置页管理的路由配置暴露给 agent 层，并提供服务端注入的可选依赖
 * （向量检索、熔断器）。持久化与校验由 server/routing-settings.ts 负责。
 *
 * 设计立场：
 *  - 与 plugin-state.ts 同一立场：本模块不读文件、不 import server/*，
 *    因此 agent 层可以安全引用，CLI 下也不会因为缺少配置而崩；
 *  - 向量层是 RAG 的能力（server 侧），通过注入接口进入路由层，
 *    路由层不直接碰 rag.ts；
 *  - 默认 `enabled = false`：不开路由时行为与引入前完全一致。
 */
import {
  DEFAULT_ROUTING_LIMITS,
  DEFAULT_ROUTING_THRESHOLDS,
  type RoutingSettings,
} from "./types.js";
import type { VectorFinder } from "./vector.js";
import type { RoutingBreaker } from "./backends/systemone.js";

export const DEFAULT_ROUTING_SETTINGS: Readonly<RoutingSettings> = Object.freeze({
  enabled: false,
  backend: "openai-compat",
  llm: Object.freeze({
    providerId: null,
    modelId: null,
    temperature: 0,
    structuredOutput: true,
    maxOutputTokens: 300,
  }),
  systemone: Object.freeze({ baseURL: "", expectedModel: "", apiKey: "" }),
  thresholds: DEFAULT_ROUTING_THRESHOLDS,
  limits: DEFAULT_ROUTING_LIMITS,
  decideTimeoutMs: 6_000,
});

function cloneSettings(input: RoutingSettings): RoutingSettings {
  return {
    enabled: input.enabled,
    backend: input.backend,
    llm: { ...input.llm },
    systemone: { ...input.systemone },
    thresholds: { ...input.thresholds },
    limits: { ...input.limits },
    decideTimeoutMs: input.decideTimeoutMs,
  };
}

let current: RoutingSettings = cloneSettings(DEFAULT_ROUTING_SETTINGS);
let vectorFinder: VectorFinder | null = null;
let breaker: RoutingBreaker | null = null;

export function getRoutingSettings(): RoutingSettings {
  return cloneSettings(current);
}

/** 已脱敏的快照：API Key 只暴露「有没有」，与全仓库 Key 回传口径一致。 */
export function getRoutingPublicSettings(): RoutingSettings {
  const snapshot = cloneSettings(current);
  return { ...snapshot, systemone: { ...snapshot.systemone, apiKey: "" } };
}

export function replaceRoutingStateForServer(next: RoutingSettings): void {
  current = cloneSettings(next);
}

export function isRoutingEnabled(): boolean {
  return current.enabled;
}

/** 服务端启动时注入 RAG 向量检索；未注入 = 向量层整层跳过（R4 的要求）。 */
export function configureRoutingVectorFinder(find: VectorFinder | null): void {
  vectorFinder = find;
}

export function getRoutingVectorFinder(): VectorFinder | null {
  return vectorFinder;
}

/** 服务端注入独立熔断器；未注入时 systemone 后端直连（单测 / CLI 场景）。 */
export function configureRoutingBreaker(next: RoutingBreaker | null): void {
  breaker = next;
}

export function getRoutingBreaker(): RoutingBreaker | null {
  return breaker;
}

/** 测试隔离用：恢复默认关闭状态并清空注入依赖。 */
export function resetRoutingStateForTests(): void {
  current = cloneSettings(DEFAULT_ROUTING_SETTINGS);
  vectorFinder = null;
  breaker = null;
}
