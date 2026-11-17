/**
 * workflow/model-adapter.ts — 模型重试、请求超时与统一调用入口
 * ============================================================
 * 生产模型每次尝试重新生成超时；父级取消信号始终透传。测试注入模型保持一次性语义。
 */
import type { AIMessage } from "@langchain/core/messages";
import { config } from "../../config.js";
import { invokeWithModelRetry } from "../../model-retry.js";
import type { WorkflowChatModel } from "./types.js";

function requestSignal(parent?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(config.modelRequestTimeoutMs);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

/** 标记默认生产模型：只有它自动重试；测试注入的确定性假模型保持原语义。 */
const RETRYING_MODEL = Symbol("retrying-model");
type RetryingChatModel = WorkflowChatModel & { [RETRYING_MODEL]: true };

/** 包装默认生产模型：每次尝试重新生成请求超时，退避只响应父级取消信号。 */
export function withModelRetries(model: WorkflowChatModel, sessionId: string | undefined): WorkflowChatModel {
  const wrapped: WorkflowChatModel = {
    invoke: (input, options) => invokeWithModelRetry(
      (signal) => model.invoke(input, { signal: requestSignal(signal) }),
      { sessionId, parentSignal: options?.signal },
    ),
  };
  return Object.assign(wrapped, { [RETRYING_MODEL]: true as const }) as RetryingChatModel;
}

/** 测试模型沿用原一次性调用；生产包装模型内部负责重试与每次请求的超时。 */
export async function invokeModel(
  model: WorkflowChatModel,
  input: unknown,
  parentSignal: AbortSignal | undefined,
  sessionId: string | undefined,
): Promise<AIMessage> {
  if (RETRYING_MODEL in model) return model.invoke(input, { signal: parentSignal });
  return model.invoke(input, { signal: requestSignal(parentSignal) });
}