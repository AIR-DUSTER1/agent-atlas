/**
 * ============================================================
 * routing/route-step.ts — 路由决策的一次完整执行（供图节点与测试复用）
 * ============================================================
 * 职责：读取路由配置与候选 → 调 decideRouteForText → 返回 RouteDecision，
 * 并把「这次决策用到了哪些外部能力」一并报告给调用方。
 *
 * 设计立场：
 *  - 本模块**不做任何 IO 之外的判断**：候选过滤、层级顺序、守卫都在别处；
 *    它只负责「组装输入 + 安全执行 + 失败降级」；
 *  - 路由整体失败绝不抛出：返回 fallback 决策，对话继续；
 *  - 不读 process.env，不读配置文件（配置由 state.ts 的镜像提供）。
 */
import { getEnabledSubagents } from "../subagent-state.js";
import { buildRoutingCandidates } from "./candidates.js";
import { decideRouteForText } from "./decide.js";
import { fallbackDecision } from "./guards.js";
import { createOpenAiCompatBackend } from "./backends/openai.js";
import { createSystemoneBackend } from "./backends/systemone.js";
import type { DecisionBackend } from "./backends/index.js";
import {
  getRoutingBreaker,
  getRoutingSettings,
  getRoutingVectorFinder,
  isRoutingEnabled,
} from "./state.js";
import type { RouteDecision, RoutingSettings } from "./types.js";

export interface RouteStepInput {
  text: string;
  sessionKind: "agent" | "estate" | "demo" | "external";
  /** 已转回次数 */
  handoffCount: number;
  /** 已尝试过的 agent（转回场景用于排除，防绕圈） */
  exclude?: readonly string[];
  signal?: AbortSignal;
  /** 测试注入：跳过真实后端 */
  backendOverride?: DecisionBackend | null;
  /** 测试注入：覆盖配置 */
  settingsOverride?: RoutingSettings;
}

export interface RouteStepResult {
  decision: RouteDecision;
  /** 是否实际调用了模型后端（供观测与「零算力」验证） */
  usedModel: boolean;
  /** 是否实际调用了向量层 */
  usedVector: boolean;
}

/** 该会话类型是否允许路由：外部会话与 demo 一律不走。 */
export function routingAppliesTo(kind: RouteStepInput["sessionKind"]): boolean {
  return kind === "agent" || kind === "estate";
}

function backendFor(settings: RoutingSettings): DecisionBackend | null {
  if (settings.backend === "rules-only") return null;
  if (settings.backend === "systemone") {
    const breaker = getRoutingBreaker();
    return createSystemoneBackend(settings, breaker ? { breaker } : {});
  }
  return createOpenAiCompatBackend(settings);
}

/**
 * 执行一次路由决策。调用方负责判断「要不要路由」（sessionKind / enabled / 已在子图内）。
 */
export async function runRouteStep(input: RouteStepInput): Promise<RouteStepResult> {
  const settings = input.settingsOverride ?? getRoutingSettings();
  if (!settings.enabled || !routingAppliesTo(input.sessionKind)) {
    return {
      decision: fallbackDecision("路由未启用，由当前 Agent 处理。", { handoffCount: input.handoffCount }),
      usedModel: false,
      usedVector: false,
    };
  }

  const candidates = buildRoutingCandidates(getEnabledSubagents(), input.exclude ?? []);
  if (!candidates.length) {
    return {
      decision: fallbackDecision(
        "没有配置可参与路由的子代理（需要在「设置 → 子代理 → 路由」填写关键词或类别），由当前 Agent 处理。",
        { handoffCount: input.handoffCount },
      ),
      usedModel: false,
      usedVector: false,
    };
  }

  const backend = input.backendOverride !== undefined ? input.backendOverride : backendFor(settings);
  const vector = getRoutingVectorFinder();
  try {
    const decision = await decideRouteForText({
      text: input.text,
      candidates,
      // settingsOverride 只覆盖阈值；enabled 已在上面判定，这里强制置真，
      // 避免「测试传了阈值却忘了 enabled」导致静默走兜底。
      settings: { ...settings, enabled: true },
      backend,
      vector,
      handoffCount: input.handoffCount,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return {
      decision,
      usedModel: decision.layer === "model",
      usedVector: decision.layer === "vector",
    };
  } catch (err) {
    // 任何意外都降级：路由层没有让对话失败的权利。
    return {
      decision: fallbackDecision(
        `路由判断失败（${err instanceof Error ? err.message : String(err)}），由当前 Agent 处理。`,
        { handoffCount: input.handoffCount },
      ),
      usedModel: false,
      usedVector: false,
    };
  }
}

/** 图节点用：只关心「要不要派发」，不关心用了哪一层。 */
export function shouldDispatch(decision: RouteDecision): boolean {
  return decision.kind === "dispatch" && Boolean(decision.agentId);
}
