/**
 * tools-rag.ts — 知识检索工具（外部 RAG 的模型出口）
 *
 * retrieve_docs：对外部 RAG 服务发起语义检索，返回命中文本片段与来源。
 *   - 向量存储 / 切块 / embedding 全部由外部 RAG 服务完成（见 server/rag.ts 契约）；
 *   - 本工具是只读低风险操作，不走人工审批（general 审批策略只拦 send_email / terminal / write_file）；
 *   - 结果同时面向两类读者：模型直接阅读文本；前端按 JSON 渲染命中来源卡片。
 *
 * 输出形态（JSON 字符串）：
 *   { query, hits: [{ name, text, score, source }],
 *     note: "请基于以上片段回答并标注来源；片段不相关时说明知识库暂无相关内容" }
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { searchRag } from "./server/rag.js";

/** 工具结果截断：给模型的观察文本不能过长（挤占上下文） */
const RESULT_TEXT_LIMIT = 6_000;

export const retrieveDocs = tool(
  async ({ query, topK }) => {
    try {
      const { query: q, hits } = await searchRag(query, topK ?? undefined);
      if (!hits.length) {
        return JSON.stringify({
          query: q,
          hits: [],
          note: "外部知识库没有命中任何相关内容。如果用户的问题依赖项目文档，可提示先在知识库面板入库；不要编造片段里没有的内容。",
        });
      }
      // 观察文本按 score 降序 + 文本总量截断（避免拖垮上下文窗口）
      const sorted = [...hits].sort((a, b) => b.score - a.score);
      const lines: string[] = [];
      let used = 0;
      for (const h of sorted) {
        const excerpt = h.text.slice(0, 800);
        const line = `[${h.name}]${h.source ? `（来源：${h.source}）` : ""}\n${excerpt}`;
        if (used + line.length > RESULT_TEXT_LIMIT) {
          lines.push("…（剩余片段因长度限制省略，可用更精确的检索词重试）");
          break;
        }
        lines.push(line);
        used += line.length;
      }
      return JSON.stringify({
        query: q,
        hits: sorted.map((h) => ({ name: h.name, text: h.text, score: h.score, source: h.source })),
        excerpt: lines.join("\n\n"),
        note: "请基于以上片段回答并尽量标注来源；片段与问题无关时如实说明知识库暂无相关内容。",
      });
    } catch (e) {
      // 不抛异常（否则整轮对话失败）：把原因告诉模型，让它向用户转述
      return JSON.stringify({
        query,
        hits: [],
        error: e instanceof Error ? e.message : String(e),
        note: "检索失败，请把 error 的原因转述给用户（通常是外部 RAG 服务未配置 / 未启动）。",
      });
    }
  },
  {
    name: "retrieve_docs",
    description:
      "在已接入的外部 RAG 知识库中检索文档片段（语义检索，返回带来源与相似度分数的文本）。" +
      "当问题涉及项目文档、需求说明、入职资料或任何「看起来存在于知识库里的资料」时调用；" +
      "需要事实依据时优先用它而不是凭记忆编造。",
    schema: z.object({
      query: z.string().describe("检索词（自然语言查询，可包含项目 / 文档关键词）"),
      topK: z.number().int().min(1).max(20).optional().describe("返回条数，缺省用服务端配置（通常 5）"),
    }),
  }
);
