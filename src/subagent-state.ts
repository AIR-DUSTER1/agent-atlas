/**
 * subagent-state.ts — 子代理配置的运行时只读状态
 * ============================================================
 * 职责：把设置页管理的子代理配置暴露给 agent 层。持久化、校验和审计由
 * server/subagent-settings.ts 负责；本模块不读文件，避免 agent 依赖 server。
 *
 * 设计立场：
 *  - 配置只描述身份、路由说明、启停与模型选择；专项提示词和工具在每次委派时
 *    由主 Agent 动态赋予，不把固定角色写死到运行时；
 *  - general / estate 作为兼容旧能力的默认种子，但允许用户编辑、停用和删除；
 *  - 配置变化由 server bumpConfigVersion，已有会话下一条消息重建图。
 */
import type { SubagentModelSelection } from "./model-runtime.js";

export interface SubagentConfig {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  model: SubagentModelSelection;
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
    builtIn: true,
    createdAt: SEED_TIME,
    updatedAt: SEED_TIME,
  }),
]);

let configs: SubagentConfig[] = cloneSubagents(DEFAULT_SUBAGENTS);

function cloneModel(model: SubagentModelSelection): SubagentModelSelection {
  return model.mode === "inherit"
    ? { mode: "inherit" }
    : { mode: "fixed", providerId: model.providerId, modelId: model.modelId };
}

export function cloneSubagent(config: SubagentConfig): SubagentConfig {
  return { ...config, model: cloneModel(config.model) };
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
