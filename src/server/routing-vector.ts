/**
 * ============================================================
 * server/routing-vector.ts — L2 向量层：把 RAG 接进路由
 * ============================================================
 * 职责：实现 routing/vector.ts 的 VectorFinder，用「agent-routing」专用集合
 * 做子代理名片检索；RAG 未配置时返回 null，整层不存在（R4 硬要求）。
 *
 * 设计立场：
 *  - **索引是幂等重建的**：以 agent id 作 document id，配置变更后重新 ingest 覆盖，
 *    不做增量 diff —— 子代理数量是个位数，重建比 diff 简单且不会漂移；
 *  - 独立熔断：路由检索失败不能污染文档检索的状态；
 *  - 卡片文本由 routing/vector.ts 的 renderRoutingDocument 统一渲染，
 *    索引侧与查询侧规则一致才有可比性。
 */
import { searchRag, upsertCollectionText, isRagConfigured } from "./rag.js";
import { log } from "./logging.js";
import { ROUTING_COLLECTION, renderRoutingDocument, type VectorFinder } from "../routing/vector.js";
import { getEnabledSubagents } from "../subagent-state.js";
import { buildRoutingCandidates } from "../routing/candidates.js";
import type { VectorHit } from "../routing/types.js";

/** 路由检索只取前几名；topK 太大反而把「勉强像」的候选拉进来。 */
const ROUTING_TOP_K = 5;
/** 单次检索等待上限：路由是对话前置步骤，不能等 RAG 的 30 秒默认超时。 */
const ROUTING_SEARCH_TIMEOUT_MS = 4_000;

/**
 * RAG 侧只按 collection 检索，没有超时入参；这里用 Promise.race 加一个
 * 「到点就弃权」的上限，避免路由被卡住。超时不取消底层请求（best-effort）。
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(null); },
    );
  });
}

export function createRagVectorFinder(): VectorFinder | null {
  if (!isRagConfigured()) return null;
  return {
    async find(text: string, agentIds: readonly string[]): Promise<VectorHit[]> {
      const allowed = new Set(agentIds);
      const result = await withTimeout(
        searchRag(text, ROUTING_TOP_K, { collection: ROUTING_COLLECTION }),
        ROUTING_SEARCH_TIMEOUT_MS,
      );
      if (!result) return [];
      const hits: VectorHit[] = [];
      for (const hit of result.hits) {
        // RAG 的命中 name 是入库时的文档名，这里约定为 agent id。
        const agentId = (hit.source || hit.name || "").trim();
        if (!allowed.has(agentId)) continue;
        hits.push({ agentId, score: Math.max(0, Math.min(1, hit.score)) });
      }
      return hits.sort((a, b) => b.score - a.score);
    },
  };
}

/**
 * 重建 agent-routing 索引。失败只记日志：向量层是增强，没有它路由照样工作。
 * 调用时机：服务启动后、子代理配置变更后。
 */
export async function syncRoutingIndex(): Promise<void> {
  if (!isRagConfigured()) return;
  const candidates = buildRoutingCandidates(getEnabledSubagents());
  if (!candidates.length) return;
  try {
    for (const candidate of candidates) {
      const text = renderRoutingDocument({
        name: candidate.name,
        description: candidate.description,
        keywords: candidate.routing.keywords,
        suitableFor: candidate.routing.suitableFor,
        notSuitableFor: candidate.routing.notSuitableFor,
        ...(candidate.routing.category ? { category: candidate.routing.category } : {}),
      });
      await upsertCollectionText({
        collection: ROUTING_COLLECTION,
        id: candidate.agentId,
        name: candidate.agentId,
        text,
        source: candidate.agentId,
      });
    }
    log("info", "routing_index_synced", { count: candidates.length });
  } catch (err) {
    log("warn", "routing_index_sync_failed", { error: err instanceof Error ? err.message : String(err) });
  }
}
