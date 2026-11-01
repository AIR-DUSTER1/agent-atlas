/**
 * subagent-state.ts — 子代理配置的运行时只读状态
 * ============================================================
 * 职责：把设置页管理的子代理配置暴露给 agent 层。持久化、校验和审计由
 * server/subagent-settings.ts 负责；本模块不读文件，避免 agent 依赖 server。
 *
 * 设计立场：
 *  - 配置只描述身份、路由说明、启停与模型选择；专项提示词和工具在每次委派时
 *    由主 Agent 动态赋予，不把固定角色写死到运行时；
 *  - routing 是「路由名片」：规则层与决策模型都靠它判断该不该派给这个 agent，
 *    缺省为空数组表示「不参与路由竞争」（兜底型 agent 就该如此）；
 *  - general / estate 作为兼容旧能力的默认种子，但允许用户编辑、停用和删除；
 *  - 配置变化由 server bumpConfigVersion，已有会话下一条消息重建图。
 */
import type { SubagentModelSelection } from "./model-runtime.js";
import { EMPTY_SUBAGENT_ROUTING, type SubagentRouting } from "./routing/types.js";

export interface SubagentConfig {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  model: SubagentModelSelection;
  /** 路由名片：关键词 / 类别 / 适用与不适用范围 / 领域 profile */
  routing: SubagentRouting;
  builtIn: boolean;
  createdAt: number;
  updatedAt: number;
}

const SEED_TIME = 0;

export const DEFAULT_SUBAGENTS: readonly SubagentConfig[] = Object.freeze([
  Object.freeze({
    id: "general",
    name: "通用子代理",
    description: "隔离上下文处理通用研究、代码阅读、文档分析和多步骤信息收集。",
    enabled: true,
    model: { mode: "inherit" } as const,
    // 兜底型 agent：不填关键词与类别，因此不参与路由竞争 ——
    // 「谁都不合适」时主 Agent 自己处理，不需要把一个通用兜底当候选。
    routing: EMPTY_SUBAGENT_ROUTING,
    builtIn: true,
    createdAt: SEED_TIME,
    updatedAt: SEED_TIME,
  }),
  Object.freeze({
    id: "estate",
    name: "房产找房子代理",
    description: "处理房源检索、小区对比、市场行情、户型和经纪人等贝壳找房任务。",
    enabled: true,
    model: { mode: "inherit" } as const,
    routing: Object.freeze({
      keywords: Object.freeze([
        "租房", "买房", "房源", "小区", "户型", "经纪人", "贝壳",
        "首付", "月供", "学区", "楼盘", "二手房", "新房", "看房", "带看",
      ]),
      category: "居住",
      suitableFor: Object.freeze([
        "按城市/预算/区域检索房源并给出对比结论",
        "评估小区、板块、户型与通勤取舍",
      ]),
      notSuitableFor: Object.freeze([
        "天气", "算数", "计算", "写代码", "编程", "文档", "闲聊",
      ]),
      domainProfile: "estate" as const,
    }),
    builtIn: true,
    createdAt: SEED_TIME,
    updatedAt: SEED_TIME,
  }),
]);

function cloneRouting(routing: SubagentRouting): SubagentRouting {
  return {
    keywords: [...routing.keywords],
    ...(routing.category ? { category: routing.category } : {}),
    suitableFor: [...routing.suitableFor],
    notSuitableFor: [...routing.notSuitableFor],
    ...(routing.domainProfile ? { domainProfile: routing.domainProfile } : {}),
  };
}

let configs: SubagentConfig[] = cloneSubagents(DEFAULT_SUBAGENTS);

function cloneModel(model: SubagentModelSelection): SubagentModelSelection {
  return model.mode === "inherit"
    ? { mode: "inherit" }
    : { mode: "fixed", providerId: model.providerId, modelId: model.modelId };
}

export function cloneSubagent(config: SubagentConfig): SubagentConfig {
  return { ...config, model: cloneModel(config.model), routing: cloneRouting(config.routing) };
}


export function cloneSubagents(list: readonly SubagentConfig[]): SubagentConfig[] {
  return list.map(cloneSubagent);
}

export function replaceSubagentStateForServer(next: readonly SubagentConfig[]): void {
  configs = cloneSubagents(next);
}

export function getSubagentSnapshot(): SubagentConfig[] {
  return cloneSubagents(configs);
}

export function getEnabledSubagents(): SubagentConfig[] {
  return cloneSubagents(configs.filter((item) => item.enabled));
}

export function findSubagent(id: string): SubagentConfig | null {
  const found = configs.find((item) => item.id === id);
  return found ? cloneSubagent(found) : null;
}

/** 测试隔离用：恢复到没有用户配置时的默认种子。 */
export function resetSubagentStateForTests(): void {
  configs = cloneSubagents(DEFAULT_SUBAGENTS);
}
