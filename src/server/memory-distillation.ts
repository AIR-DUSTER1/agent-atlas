/**
 * server/memory-distillation.ts — 对话结束后的自动记忆沉淀编排
 * ============================================================
 * 聊天完成只负责 fire-and-forget 调用本模块；模型失败、频率限制或存储故障都
 * 不影响回答。候选生成后仍走 MemorySlot 的敏感过滤与 scope 隔离，禁止跨 Agent。
 */
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { createChatModel } from "../llm.js";
import { resolveModelRuntime } from "../model-runtime.js";
import type { MemoryProposal, MemoryProfileId } from "../memory/provider.js";
import { heuristicMemoryProposals, normalizeMemoryProposals, shouldDistill } from "../memory/distillation.js";
import { memoryScope } from "../memory/scope.js";
import { memorySlot } from "../memory/slot.js";
import type { MemoryDistillationConfig } from "./memory-config.js";
import { incCounter } from "./observability/metrics.js";
import { getActiveId } from "./settings.js";
import { runWithModelSlot } from "./runtime/model-gate.js";

const HOUR_MS = 60 * 60 * 1000;
const MAX_TRANSCRIPT_CHARS = 6000;
const AUTO_ACTIVATE_CONFIDENCE = 0.85;

let config: MemoryDistillationConfig = { mode: "smart", maxPerTurn: 3, hourlyLimit: 20 };
const hourly = new Map<string, number[]>();

export function configureMemoryDistillation(next: MemoryDistillationConfig): void {
  config = { ...next };
}

export function resetMemoryDistillationForTests(): void {
  config = { mode: "smart", maxPerTurn: 3, hourlyLimit: 20 };
  hourly.clear();
}

function pruneHourly(scopeKeyValue: string, now: number): number[] {
  const recent = (hourly.get(scopeKeyValue) ?? []).filter((at) => now - at < HOUR_MS);
  hourly.set(scopeKeyValue, recent);
  return recent;
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string") {
        return (item as { text: string }).text;
      }
      return "";
    }).join("");
  }
  return "";
}

async function completeWithCurrentModel(input: {
  sessionId: string;
  turnId: string;
  profileId: MemoryProfileId;
  userText: string;
  assistantText: string;
  existingKeys: string[];
  maxPerTurn: number;
}): Promise<string> {
  const runtime = resolveModelRuntime({ mode: "inherit" });
  if (!runtime?.apiKey) return "";
  const model = createChatModel(0, { runtime, sessionId: input.sessionId });
  const system = [
    "你是长期记忆提取器，只输出 JSON，不回答用户。",
    "只提取用户明确表达、跨会话仍有价值的偏好、项目事实或纠正；忽略临时上下文、猜测、助手自述和工具输出。",
    "不得提取密码、令牌、API Key、手机号、身份证号等敏感信息。",
    `最多输出 ${input.maxPerTurn} 条。`,
    "格式：{\"memories\":[{\"action\":\"create|update|merge\",\"key\":\"10字内主题\",\"content\":\"一两句话\",\"tags\":[\"tag\"],\"category\":\"preference|project_fact|correction|identity|other\",\"confidence\":0.0,\"reason\":\"依据\"}]}。",
  ].join("\n");
  const user = [
    `当前 Agent profile：${input.profileId}`,
    `已有记忆主题：${input.existingKeys.slice(0, 80).join(" / ") || "无"}`,
    "对话：",
    `用户：${input.userText.slice(0, MAX_TRANSCRIPT_CHARS / 2)}`,
    `助手：${input.assistantText.slice(0, MAX_TRANSCRIPT_CHARS / 2)}`,
  ].join("\n");
  const response = await runWithModelSlot(getActiveId(), () => model.invoke([new SystemMessage(system), new HumanMessage(user)]));
  return contentText(response.content);
}

export interface DistillTurnInput {
  sessionId: string;
  turnId: string;
  profileId: MemoryProfileId;
  userText: string;
  assistantText: string;
}

export interface DistillDependencies {
  complete?: typeof completeWithCurrentModel;
  now?: () => number;
}

export interface DistillResult {
  proposed: number;
  saved: number;
  activated: number;
  skipped: string;
}

/** 可单测入口：依赖可注入，真实调用只发生在 server 默认路径。 */
export async function distillTurn(input: DistillTurnInput, deps: DistillDependencies = {}): Promise<DistillResult> {
  if (config.mode === "off") return { proposed: 0, saved: 0, activated: 0, skipped: "disabled" };
  if (!shouldDistill(input.userText)) return { proposed: 0, saved: 0, activated: 0, skipped: "no-signal" };
  const now = deps.now?.() ?? Date.now();
  // 外部 HTTP Provider 没有统一的 candidate / confirm 契约；自动沉淀只在本地存储启用，
  // 避免 confirm 模式下绕过人工确认直接写入外部记忆。
  if (await memorySlot.providerId() !== "local") {
    return { proposed: 0, saved: 0, activated: 0, skipped: "provider-unsupported" };
  }
  const scope = memoryScope(input.profileId);
  const key = `${input.profileId}:${scope.userId}`;
  const recent = pruneHourly(key, now);
  if (recent.length >= config.hourlyLimit) return { proposed: 0, saved: 0, activated: 0, skipped: "rate-limit" };

  const existing = await memorySlot.list(scope, { statuses: ["active", "candidate"] });
  const existingContents = new Set(existing.map((record) => record.content.trim()));
  let proposals: MemoryProposal[] = [];
  try {
    const raw = await (deps.complete ?? completeWithCurrentModel)({
      sessionId: input.sessionId,
      turnId: input.turnId,
      profileId: input.profileId,
      userText: input.userText,
      assistantText: input.assistantText,
      existingKeys: existing.map((record) => record.key),
      maxPerTurn: config.maxPerTurn,
    });
    proposals = normalizeMemoryProposals(raw);
  } catch {
    incCounter("memory_distillation_model_failed_total", { profile: input.profileId });
  }
  if (!proposals.length) proposals = heuristicMemoryProposals(input.userText);
  proposals = proposals
    .filter((proposal) => proposal.action !== "ignore" && !existingContents.has(proposal.content.trim()))
    .slice(0, config.maxPerTurn);

  let saved = 0;
  let activated = 0;
  for (const proposal of proposals) {
    const confidence = proposal.confidence ?? 0.7;
    const autoActivate = config.mode === "smart" &&
      confidence >= AUTO_ACTIVATE_CONFIDENCE &&
      proposal.category !== "identity";
    const status = autoActivate ? "active" as const : "candidate" as const;
    await memorySlot.save({
      scope,
      key: proposal.key,
      content: proposal.content,
      tags: proposal.tags,
      source: "agent",
      status,
      category: proposal.category,
      confidence,
      origin: { mode: "auto", sessionId: input.sessionId, turnId: input.turnId },
    });
    saved += 1;
    if (autoActivate) activated += 1;
    incCounter("memory_distillation_candidate_total", { profile: input.profileId, status });
  }
  if (saved) hourly.set(key, [...recent, now]);
  incCounter("memory_distillation_auto_saved_total", { profile: input.profileId }, activated);
  return { proposed: proposals.length, saved, activated, skipped: saved ? "" : "no-candidate" };
}

/** server 的唯一调用入口：不 await，任何错误都在内部消化。 */
export function scheduleMemoryDistillation(input: DistillTurnInput): void {
  void distillTurn(input).catch((error) => {
    incCounter("memory_distillation_failed_total", { profile: input.profileId });
    void error;
  });
}