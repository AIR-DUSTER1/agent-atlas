/**
 * ============================================================
 * routing/intents.ts — 意图切分、分层归并与截断（R8）
 * ============================================================
 * 职责：把一段用户请求切成「几件需要独立处理的事」，并在超过阈值时按类别
 * 归并成两层结构（大类 → 子任务），供计划卡片展示与实际派发使用。
 *
 * 设计立场：
 *  - 先做**确定性的分隔符切分**，再用模型补判；切分本身零成本、可解释，
 *    失败也只影响「要不要问」，不影响主流程；
 *  - 深度固定 2 层，不递归：分层是为了让人看懂计划，不是为了自动生成无限嵌套；
 *  - 截断必须显式告知调用方（返回 `truncated` 计数），不静默丢弃用户意图。
 */

/** 用于切分的显式分隔符（含中英文标点与连接词）。 */
const SPLIT_PATTERN = /[；;。\n]+|(?:\s*并且\s*)|(?:\s*然后\s*)|(?:\s*还有\s*)|(?:\s*另外\s*)|(?:\s*同时\s*)|(?:\s*，再\s*)/;

/** 单个子句低于该长度视为语气词（「好的」「谢谢」），不单独算意图。 */
const MIN_INTENT_CHARS = 4;
/** 切分后最多产出多少个子句（防止超长输入炸出几千条） */
const MAX_SPLIT_PIECES = 200;

export interface SplitIntent {
  text: string;
}

/**
 * 纯文本切分：按分隔符切开，去掉太短的碎片。
 * 不做语义判断——那需要模型，属于下一层（可选）。
 */
export function splitIntents(raw: string, maxChars: number): { intents: SplitIntent[]; truncated: number } {
  const text = raw.trim();
  if (!text) return { intents: [], truncated: 0 };
  const pieces = text
    .split(SPLIT_PATTERN)
    .map((piece) => piece.trim())
    .filter((piece) => piece.length >= MIN_INTENT_CHARS)
    .slice(0, MAX_SPLIT_PIECES);
  if (!pieces.length) {
    // 一句完整但没命中分隔符：整段就是 1 个意图。
    return { intents: [{ text: text.slice(0, maxChars) }], truncated: 0 };
  }
  const kept = pieces.slice(0, 50);
  const intents = kept.map((piece) => ({ text: piece.length > maxChars ? piece.slice(0, maxChars) : piece }));
  return { intents, truncated: Math.max(0, pieces.length - kept.length) };
}

export interface HierarchicalPlanItem {
  text: string;
  agentId: string;
}

export interface HierarchicalPlanGroup {
  category: string;
  count: number;
  summary: string;
  items: HierarchicalPlanItem[];
}

export interface HierarchicalPlan {
  total: number;
  groups: HierarchicalPlanGroup[];
  /** 超上限被截断的意图数（>0 时必须在回答里告知用户） */
  truncated: number;
  /** 因类别数超限而未单独成组的意图数 */
  folded: number;
}

/**
 * 两阶段归并：按 category 把意图分组，组内保留原始顺序。
 * 第二阶段（大类展开成可执行子任务）在这里就是把 items 直接铺平 ——
 * 每条意图本身已经是一个子任务，不需要再让模型大一统重写。
 */
export function buildHierarchicalPlan(
  intents: readonly HierarchicalPlanItem[],
  options: { maxCategories: number; maxIntents?: number; categoryOf: (agentId: string) => string },
): HierarchicalPlan {
  const maxIntents = options.maxIntents ?? intents.length;
  const kept = intents.slice(0, maxIntents);
  const truncated = Math.max(0, intents.length - kept.length);

  const buckets = new Map<string, HierarchicalPlanItem[]>();
  for (const item of kept) {
    const category = options.categoryOf(item.agentId) || "其他";
    const list = buckets.get(category);
    if (list) list.push(item);
    else buckets.set(category, [item]);
  }

  const ordered = [...buckets.entries()].sort((a, b) => b[1].length - a[1].length);
  const groups: HierarchicalPlanGroup[] = [];
  let folded = 0;
  for (const [category, items] of ordered) {
    if (groups.length >= Math.max(1, options.maxCategories)) {
      // 类别数超限：并入最后一个分组，但计数如实保留，不掩盖。
      const last = groups[groups.length - 1];
      if (last) {
        last.items.push(...items);
        last.count += items.length;
        last.summary = `${last.count} 项（含并入的「${category}」）`;
      }
      folded += items.length;
      continue;
    }
    groups.push({
      category,
      count: items.length,
      summary: `${items.length} 项`,
      items: [...items],
    });
  }

  return { total: kept.length, groups, truncated, folded };
}

/** 分层是否需要触发（按意图数）。 */
export function needsHierarchy(intentCount: number, hierarchicalAbove: number): boolean {
  return intentCount > Math.max(0, hierarchicalAbove);
}
