/**
 * ============================================================
 * routing/vector.ts — L2 向量比对（仅在 RAG 已配置时启用）
 * ============================================================
 * 职责：定义「给一段文字，返回各候选 agent 的相似度」这一最小接口，
 * 由服务端注入具体实现（RAG 客户端 + agent-routing 集合）。
 *
 * 设计立场：
 *  - 路由层不认识 RAG：只要实现 `find()` 就能当向量层，单测用假实现即可；
 *  - `find()` 失败必须由实现自己吞掉或由调用方 catch —— 向量层是**增强**，
 *    不具备让路由失败的权利；
 *  - 未注入 = 该层不存在，零网络调用、零延迟（R4 硬要求）。
 */
import type { VectorHit } from "./types.js";

export type { VectorHit };

export interface VectorFinder {
  /**
   * @param text 用户本轮文本
   * @param agentIds 参与比对的候选 id（实现可以据此过滤掉已转回过的 agent）
   */
  find(text: string, agentIds: readonly string[]): Promise<VectorHit[]>;
}

/**
 * 把「路由名片」渲染成入库文本。索引侧与检索侧必须用同一份拼装规则，
 * 否则相似度会失去可比性。
 */
export function renderRoutingDocument(input: {
  name: string;
  description: string;
  keywords: readonly string[];
  suitableFor: readonly string[];
  notSuitableFor: readonly string[];
  category?: string;
}): string {
  return [
    `子代理：${input.name}`,
    input.category ? `类别：${input.category}` : "",
    `用途：${input.description}`,
    input.keywords.length ? `关键词：${input.keywords.join("、")}` : "",
    input.suitableFor.length ? `适用：${input.suitableFor.join("；")}` : "",
    input.notSuitableFor.length ? `不适用：${input.notSuitableFor.join("；")}` : "",
  ].filter(Boolean).join("\n");
}

/** 专用集合名：不能与文档知识库共用，否则项目文档会污染 agent 匹配。 */
export const ROUTING_COLLECTION = "agent-routing";
