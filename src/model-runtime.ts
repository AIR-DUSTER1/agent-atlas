/**
 * model-runtime.ts — 可并行使用的模型运行时快照
 * ============================================================
 * 职责：把「供应商 + 模型 + Key + 协议 + 思考参数」冻结成一个不可变快照，
 * 供主图、子代理和测试在并发场景下各自创建模型，绝不通过修改全局 config
 * 来切换模型。
 *
 * 设计立场：
 *  - agent 层可以读取本模块，但 server 层负责注入 Provider 解析器；
 *  - 子代理默认 inherit 当前主对话模型，也可固定到任意已配置模型；
 *  - 解析失败返回 null，由调用方 fail-closed，不静默退化成别的模型。
 */
import { config, type Protocol } from "./config.js";
import type { ReasoningSetting } from "./reasoning.js";

/** 设置页持久化的子代理模型选择；不包含任何密钥。 */
export type SubagentModelSelection =
  | { mode: "inherit" }
  | { mode: "fixed"; providerId: string; modelId: string };

/** 一次模型构造所需的完整运行时快照。密钥只驻留服务端内存。 */
export interface ModelRuntimeConfig {
  providerId?: string;
  modelId?: string;
  label: string;
  baseURL: string;
  apiKey: string;
  protocol: Protocol;
  model: string;
  reasoning: ReasoningSetting;
  contextWindow?: number;
  requestTimeoutMs?: number;
}

export type ModelRuntimeResolver = (
  selection: SubagentModelSelection,
) => ModelRuntimeConfig | null;

let resolver: ModelRuntimeResolver | null = null;

/** server/settings 启动时注入；CLI / 单测没有 server 时走 config 兜底。 */
export function configureModelRuntimeResolver(next: ModelRuntimeResolver | null): void {
  resolver = next;
}

/** 当前 .env / 内存 config 的兼容快照，用于主对话与 CLI。 */
export function defaultModelRuntime(): ModelRuntimeConfig {
  return {
    label: config.model,
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    protocol: config.protocol,
    model: config.model,
    reasoning: { ...config.reasoning },
    requestTimeoutMs: config.modelRequestTimeoutMs,
  };
}

/**
 * 解析子代理模型。inherit 在没有 server resolver 时使用当前 config；
 * fixed 必须由 server resolver 证明供应商与模型真实存在。
 */
export function resolveModelRuntime(
  selection: SubagentModelSelection,
): ModelRuntimeConfig | null {
  if (resolver) return resolver(selection);
  return selection.mode === "inherit" ? defaultModelRuntime() : null;
}
