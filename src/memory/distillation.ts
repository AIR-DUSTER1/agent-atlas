/**
 * memory/distillation.ts — 自动沉淀的纯规则与候选归一化
 * ============================================================
 * 不直接调用模型或写存储：强信号规则可独立测试，模型输出也必须先经过这里
 * 做长度、敏感信息、类别和置信度归一化，避免把任意文本直接晋升为记忆。
 */
import type { MemoryCategory, MemoryProposal } from "./provider.js";
import { detectSensitiveMemory } from "./sensitive.js";

export const MEMORY_SIGNAL_PATTERN = /(?:记住|记一下|以后|今后|每次|不要再|别再|不要|我喜欢|我偏好|我习惯|我的偏好|我们约定|项目要求|项目使用|纠正一下|不是.+而是|改为)/u;
const MAX_PROPOSALS = 3;
const MAX_KEY = 50;
const MAX_CONTENT = 500;

function normalizeSpace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function inferCategory(text: string): MemoryCategory {
  if (/(?:纠正|不对|不是.+而是|改为|更新一下)/u.test(text)) return "correction";
  if (/(?:我喜欢|我偏好|我习惯|以后|每次|不要|别再|回答风格)/u.test(text)) return "preference";
  if (/(?:项目|仓库|代码|部署|测试|命令|技术栈|环境)/u.test(text)) return "project_fact";
  if (/(?:叫我|我的名字|称呼我|身份)/u.test(text)) return "identity";
  return "other";
}

function keyFromContent(content: string, index: number): string {
  const plain = content.replace(/[：:，,。.!！?？]/g, " ").replace(/\s+/g, " ").trim();
  const key = plain.slice(0, 16) || `自动记忆${index + 1}`;
  return key.slice(0, MAX_KEY);
}

/** 无模型时的保底：只处理用户明确表达“以后都要记住”的短句。 */
export function heuristicMemoryProposals(userText: string): MemoryProposal[] {
  const text = normalizeSpace(userText);
  if (!text || !MEMORY_SIGNAL_PATTERN.test(text)) return [];
  const sentences = text
    .split(/(?<=[。！？!?；;])|\n+/u)
    .map((item) => normalizeSpace(item))
    .filter(Boolean)
    .slice(0, MAX_PROPOSALS);
  const proposals: MemoryProposal[] = [];
  for (const [index, sentence] of sentences.entries()) {
    if (sentence.length < 4) continue;
    const sensitive = detectSensitiveMemory(sentence);
    if (sensitive) continue;
    const content = sentence.slice(0, MAX_CONTENT);
    proposals.push({
      action: "create",
      key: keyFromContent(content, index),
      content,
      category: inferCategory(content),
      confidence: 0.78,
      reason: "用户使用了明确的长期记忆表达",
    });
  }
  return proposals;
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw)?.[1]?.trim();
  const candidate = fenced || raw.trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function parseCategory(value: unknown): MemoryCategory {
  return value === "preference" || value === "project_fact" || value === "correction" || value === "identity"
    ? value
    : "other";
}

/** 模型输出不可信：忽略 ignore、敏感项、空项，并硬性限制每轮最多三条。 */
export function normalizeMemoryProposals(raw: string): MemoryProposal[] {
  const root = parseJsonObject(raw);
  const items = Array.isArray(root?.memories) ? root.memories : [];
  const result: MemoryProposal[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const action = rec.action === "update" || rec.action === "merge" ? rec.action : "create";
    const key = typeof rec.key === "string" ? normalizeSpace(rec.key).slice(0, MAX_KEY) : "";
    const content = typeof rec.content === "string" ? normalizeSpace(rec.content).slice(0, MAX_CONTENT) : "";
    if (!key || !content) continue;
    if (detectSensitiveMemory(`${key}\n${content}`)) continue;
    const confidence = typeof rec.confidence === "number" && Number.isFinite(rec.confidence)
      ? Math.max(0, Math.min(1, rec.confidence))
      : 0.6;
    result.push({
      action,
      key,
      content,
      tags: Array.isArray(rec.tags)
        ? rec.tags.filter((tag): tag is string => typeof tag === "string").map((tag) => tag.trim()).filter(Boolean).slice(0, 6)
        : [],
      category: parseCategory(rec.category),
      confidence,
      ...(typeof rec.reason === "string" && rec.reason.trim() ? { reason: rec.reason.trim().slice(0, 200) } : {}),
    });
    if (result.length >= MAX_PROPOSALS) break;
  }
  return result;
}

export function shouldDistill(userText: string): boolean {
  return MEMORY_SIGNAL_PATTERN.test(userText);
}