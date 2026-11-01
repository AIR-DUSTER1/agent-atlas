/**
 * ============================================================
 * routing/rules.ts — L1 规则匹配（纯本地，零算力）
 * ============================================================
 * 职责：按关键词与负向词给每个候选 agent 打分并归一化，给出快速路径判定。
 *
 * 设计立场：
 *  - 计分思想沿用 skills.ts 的 matchSkills（命中越长越具体，多命中累加），
 *    但独立实现：技能库的语义是「加载文档」，这里的是「选执行者」，两者不能耦合；
 *  - 负向词的权重远高于正向词：误派的代价（用户看到完全不相关的 agent）
 *    远大于漏派（回落到当前 agent），所以宁可保守；
 *  - 归一化用**固定饱和曲线**而不是「除以本次最高分」：后者会把「只有一个 agent
 *    勉强命中」放大成 1.0，快速路径立刻误判。
 */

/**
 * 每次命中额外加权：鼓励「多个不同关键词都命中」而不是「一个超长词命中」。
 *
 * 为什么不是 plan 里的 raw/40 线性归一化：中文领域关键词普遍是 2–4 字，
 * 单次命中 raw 只有 7，线性归一化后是 0.175 —— 需要 5 次命中才够 0.85，
 * 中文场景下快速路径等于形同虚设。改用饱和曲线 1−e^(−raw/K) 后，同一份 raw
 * 得到符合直觉的分档（见文件末尾的标定表），且仍然单调、有上界、可解释。
 */
const HIT_BONUS = 5;
/** 负向词惩罚系数：比正向更狠，见文件头说明 */
const NEGATIVE_WEIGHT = 3;
/**
 * 饱和常数 K。标定依据（关键词按 2 字计）：
 *   1 次命中  raw=7  → 0.75（单个关键词不够确定，交模型层）
 *   2 次命中  raw=14 → 0.94（两个领域词同时出现，可直接派发）
 *   3 次命中  raw=21 → 0.98
 *   1 个 8 字长词 raw=13 → 0.93（长短语本身就是强信号）
 *   命中 1 个负向词 raw≈1 → 0.18（几乎必然不该派）
 */
const SCORE_SATURATION = 5;

export interface RuleScoringInput {
  agentId: string;
  name: string;
  keywords: readonly string[];
  notSuitableFor: readonly string[];
  category?: string;
}

export interface RuleScoringResult {
  agentId: string;
  name: string;
  score: number;
  raw: number;
  hits: string[];
  negatives: string[];
  category?: string;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** 饱和归一化：raw ≤ 0 记 0，其余 1−e^(−raw/K)，单调递增且恒 < 1。 */
function saturate(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return clamp01(1 - Math.exp(-raw / SCORE_SATURATION));
}

function normalizeTerm(term: string): string {
  return term.trim().toLowerCase();
}

/**
 * 给一组候选打分。返回按分数降序、同分保持输入顺序的数组。
 * 空文本 / 没有任何关键词配置时返回全 0（调用方据此判定「规则层弃权」）。
 */
export function scoreRoutingCandidates(
  candidates: readonly RuleScoringInput[],
  userText: string,
): RuleScoringResult[] {
  const haystack = userText.toLowerCase();
  const scored = candidates.map((candidate) => {
    const keywords = [...new Set(candidate.keywords.map(normalizeTerm).filter(Boolean))];
    const negatives = [...new Set(candidate.notSuitableFor.map(normalizeTerm).filter(Boolean))];
    const hits = haystack ? keywords.filter((term) => haystack.includes(term)) : [];
    const negativeHits = haystack
      ? negatives.filter((term) => haystack.includes(term) && !keywords.some((keyword) => keyword.includes(term)))
      : [];
    const positive = hits.reduce((sum, term) => sum + term.length, 0) + hits.length * HIT_BONUS;
    const penalty = negativeHits.reduce((sum, term) => sum + term.length, 0) * NEGATIVE_WEIGHT;
    const raw = positive - penalty;
    return {
      agentId: candidate.agentId,
      name: candidate.name,
      score: saturate(raw),
      raw,
      hits,
      negatives: negativeHits,
      ...(candidate.category ? { category: candidate.category } : {}),
    };
  });
  // Array.prototype.sort 是稳定排序，同分时保留配置顺序（= 设置页顺序），结果可复现。
  return scored.sort((a, b) => b.score - a.score);
}

export interface CategoryScore {
  category: string;
  score: number;
  agentIds: string[];
}

/** 把同一 category 下各 agent 的分数相加，供「超过 N 个意图」的分层归并使用。 */
export function mergeCategoryScores(scores: readonly RuleScoringResult[]): CategoryScore[] {
  const byCategory = new Map<string, CategoryScore>();
  for (const item of scores) {
    if (!item.category || item.score <= 0) continue;
    const current = byCategory.get(item.category);
    if (current) {
      current.score += item.score;
      current.agentIds.push(item.agentId);
    } else {
      byCategory.set(item.category, { category: item.category, score: item.score, agentIds: [item.agentId] });
    }
  }
  return [...byCategory.values()].sort((a, b) => b.score - a.score);
}

export interface FastPathVerdict {
  /** 是否走快速路径直接派发 */
  accept: boolean;
  top?: RuleScoringResult;
  second?: RuleScoringResult;
  /** top1 − top2（没有第二候选时为 top1） */
  margin: number;
}

/** 快速路径判定：分数够高且明显领先，才算规则层「有把握」。 */
export function fastPathVerdict(
  scores: readonly RuleScoringResult[],
  thresholds: { ruleAutoAccept: number; ruleMargin: number },
): FastPathVerdict {
  const top = scores[0];
  if (!top || top.score <= 0) return { accept: false, margin: 0 };
  const second = scores[1];
  const margin = top.score - (second?.score ?? 0);
  const accept = top.score >= thresholds.ruleAutoAccept && margin >= thresholds.ruleMargin;
  return { accept, top, ...(second ? { second } : {}), margin };
}
