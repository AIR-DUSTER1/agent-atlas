/**
 * ============================================================
 * routing/backends/openai.ts — 默认决策后端（复用现有供应商 × 模型）
 * ============================================================
 * 职责：把路由候选渲染成一次结构化问答，交给现有 createChatModel 执行，
 * 再把模型输出宽松解析成 RawDecision。
 *
 * 设计立场：
 *  - **零新增依赖、零新增内存**：复用 llm.ts 的模型工厂，云 API / 局域网
 *    Ollama / vLLM 只要兼容 OpenAI 协议就能当决策后端；
 *  - **坏输出一律弃权**（返回 null），不重试、不猜 —— 与 parseRequirementAnalysis
 *    的既有立场一致：宁可回落到规则层多问一句，也不要拿半截 JSON 做派发；
 *  - 并发闸与超时由调用方（decide.ts）统一控制，本文件不重复实现。
 */
import { createChatModel } from "../../llm.js";
import { resolveModelRuntime, type ModelRuntimeConfig } from "../../model-runtime.js";
import type { RoutingCandidate, RoutingLimits, RoutingSettings } from "../types.js";
import { decisionFromProbabilities, type DecisionBackend, type RawDecision } from "./index.js";

/** 候选描述上限：criteria 太长会让小模型走神，也会拖慢首字延迟。 */
const MAX_CRITERIA_ITEM_CHARS = 60;
const MAX_CANDIDATES_IN_PROMPT = 12;
/** 模型输出上限：只要求一个短 JSON，不需要长文本。 */
const MAX_RAW_OUTPUT_CHARS = 4_000;

const SYSTEM_PROMPT = [
  "你是多 Agent 系统的路由决策器。只做一件事：判断用户这次请求应该交给哪个子代理。",
  "规则：",
  "1. 只能从给定候选里选一个 agentId；没有合适的就选 \"none\"。",
  "2. 不要为了显得确定而强行选择；确实模糊时给低 confidence。",
  "3. 只输出一个 JSON 对象，不要 Markdown 代码块，不要解释。",
  "格式：",
  '{"agentId":"候选 id 或 none","confidence":0.0,"reason":"一句中文依据",' +
    '"intents":[{"text":"拆出的子任务","agentId":"候选 id 或 none"}]}',
  "intents 只在用户明显提出多件独立的事时才填（最多 20 条），否则给空数组。",
].join("\n");

function clip(text: string, max: number): string {
  const value = text.replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** 候选 → 提示词里的清单。criteria 只放 suitableFor 的前两条摘要。 */
export function renderCandidateList(candidates: readonly RoutingCandidate[]): string {
  return candidates
    .slice(0, MAX_CANDIDATES_IN_PROMPT)
    .map((candidate) => {
      const suitable = candidate.routing.suitableFor
        .map((item) => clip(item, MAX_CRITERIA_ITEM_CHARS))
        .filter(Boolean)
        .slice(0, 2)
        .join("；");
      const desc = suitable || clip(candidate.description, MAX_CRITERIA_ITEM_CHARS);
      const avoid = candidate.routing.notSuitableFor
        .map((item) => clip(item, 24))
        .slice(0, 3)
        .join("、");
      return `- ${candidate.agentId}（${candidate.name}）：${desc}${avoid ? `｜不适用：${avoid}` : ""}`;
    })
    .join("\n");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 宽松解析：去围栏、取第一个 {...}，失败返回 null。 */
export function parseDecisionJson(raw: string): unknown {
  const text = raw.trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const attempt = (candidate: string): unknown => {
    try {
      return JSON.parse(candidate);
    } catch {
      return null;
    }
  };
  const direct = attempt(text);
  if (direct) return direct;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  return attempt(text.slice(start, end + 1));
}

function parseIntents(value: unknown, allowed: ReadonlySet<string>, limits: RoutingLimits): Array<{ text: string; agentId: string }> {
  if (!Array.isArray(value)) return [];
  const result: Array<{ text: string; agentId: string }> = [];
  for (const item of value) {
    if (result.length >= limits.maxIntents) break;
    const record = asRecord(item);
    const text = typeof record?.text === "string" ? record.text.trim() : "";
    if (!text) continue;
    const rawAgent = typeof record?.agentId === "string" ? record.agentId.trim() : "";
    // 幻觉出来的 agent id 归到 none，交给守卫与上层处理，不直接报错。
    const agentId = allowed.has(rawAgent) ? rawAgent : "none";
    result.push({ text: text.slice(0, limits.maxIntentTextChars), agentId });
  }
  return result;
}

/**
 * 把模型输出转成 RawDecision。任何不合规的字段都导致弃权：
 * - 不是对象 / 没有 agentId → null
 * - agentId 既不是候选也不是 "none" → null（G1 不替模型擦屁股，
 *   因为这说明模型根本没用我们给的清单）
 */
export function toRawDecision(
  parsed: unknown,
  candidates: readonly RoutingCandidate[],
  limits: RoutingLimits,
): RawDecision | null {
  const record = asRecord(parsed);
  if (!record) return null;
  const allowed = new Set(candidates.map((item) => item.agentId));
  const agentId = typeof record.agentId === "string" ? record.agentId.trim() : "";
  if (!agentId) return null;
  if (agentId !== "none" && !allowed.has(agentId)) return null;

  const confidenceRaw = Number(record.confidence);
  const confidence = Number.isFinite(confidenceRaw) ? Math.min(1, Math.max(0, confidenceRaw)) : 0;
  const intents = parseIntents(record.intents, allowed, limits);
  const reason = typeof record.reason === "string" ? clip(record.reason, 200) : "";

  // 模型明确说「没有合适的 agent」：不能走概率整理（那样会把 0 分的第一个候选选出来），
  // 必须保留 none 语义，让上层直接兜底到当前 agent。
  if (agentId === "none") {
    return {
      agentId: "none",
      confidence: 0,
      margin: 0,
      reason: reason || "模型判断没有合适的子代理",
      intents,
      probabilities: {},
    };
  }

  // 模型层没有概率分布：用「选中 1.0 / 其余 0」表达，margin 自然为 1。
  // 这也是为什么模型层不能复用 candidateMargin 的语义（见 guards.ts 注释）。
  const probabilities: Record<string, number> = {};
  for (const candidate of candidates) probabilities[candidate.agentId] = candidate.agentId === agentId ? 1 : 0;
  return decisionFromProbabilities({
    probabilities,
    candidates,
    confidence,
    reason: reason || `模型判定 ${agentId}（自报置信度 ${confidence.toFixed(2)}）`,
    intents,
  });
}

export function createOpenAiCompatBackend(settings: RoutingSettings): DecisionBackend {
  const runtime = resolveBackendRuntime(settings);
  return {
    id: "openai-compat",
    unavailableReason: runtime ? null : "没有可用的模型：请先在「设置 → 模型与供应商」启用一个模型",
    async decide(input) {
      if (!runtime || !input.candidates.length) return null;
      const model = createChatModel(settings.llm.temperature, { runtime });
      const candidateList = renderCandidateList(input.candidates);
      const response = await model.invoke([
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `可选子代理：\n${candidateList}\n\n用户请求：\n${clip(input.text, 4_000)}`,
        },
      ], { signal: input.signal });
      const text = typeof response.content === "string"
        ? response.content
        : Array.isArray(response.content)
          ? response.content.map((part) => (typeof part === "string" ? part : String((part as { text?: unknown }).text ?? ""))).join("")
          : "";
      if (!text || text.length > MAX_RAW_OUTPUT_CHARS) return null;
      const decision = toRawDecision(parseDecisionJson(text), input.candidates, input.limits);
      if (!decision) return null;
      // 模型自己说 none：这是「确实没有合适的 agent」，不是置信度问题。
      if (decision.agentId === "none") {
        return { ...decision, confidence: 0, probabilities: {} };
      }
      return decision;
    },
  };
}

/**
 * 解析后端要用的模型快照。
 * 优先级：路由专属配置 > 当前启用的「供应商 × 模型」。
 */
export function resolveBackendRuntime(settings: RoutingSettings): ModelRuntimeConfig | null {
  if (settings.llm.providerId && settings.llm.modelId) {
    const fixed = resolveModelRuntime({
      mode: "fixed",
      providerId: settings.llm.providerId,
      modelId: settings.llm.modelId,
    });
    if (fixed) return fixed;
  }
  return resolveModelRuntime({ mode: "inherit" });
}
