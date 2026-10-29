/**
 * tools-memory.ts — 跨会话长期记忆工具集（按 Agent scope 构造）
 * ============================================================
 * 模型仍只看到 `memory_save({key,content})` 与 `memory_recall({query})`；
 * profile scope 由工厂闭包注入，模型无法通过参数越权读写另一个 Agent 的记忆。
 *
 * 风险定级：只写本服务自己的记忆文件，不改用户世界，不登记人工审批。
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { MemoryProfileId } from "./memory/provider.js";
import { memorySlot } from "./memory/slot.js";
import { memoryScope } from "./memory/scope.js";

const MEMORY_SAVE_DESCRIPTION =
  "把用户表达的长期偏好、项目事实或对既往回答的纠正存入当前 Agent 专属的跨会话长期记忆（例：key=回答风格, content=结论先行少用列表）。" +
  "何时用：用户说「以后都…」「记住…」「我喜欢/不喜欢…」这类跨会话有效的信息时。" +
  "何时不用：只对当前对话有意义的信息、密钥/密码/证件号等敏感信息（放进正常回答即可，不要保存）。";

const MEMORY_RECALL_DESCRIPTION =
  "按关键词查询当前 Agent 专属的跨会话长期记忆。" +
  "何时用：需要确认用户以前是否提出过偏好、约定或项目事实时。例：query=\"回答风格\"。";

export function createMemoryTools(profileId: MemoryProfileId) {
  const memorySave = tool(
    async ({ key, content }) => {
      try {
        const entry = await memorySlot.save({
          scope: memoryScope(profileId),
          key,
          content,
          source: "agent",
        });
        return `已记住（当前 Agent 长期记忆，跨会话生效）：[${entry.key}] ${entry.content}`;
      } catch (err) {
        return err instanceof Error ? err.message : `记忆保存失败：${String(err)}`;
      }
    },
    {
      name: "memory_save",
      description: MEMORY_SAVE_DESCRIPTION,
      schema: z.object({
        key: z.string().describe("主题短语，10 字内（如：回答风格 / 测试命令 / 用户称呼）"),
        content: z.string().describe("要记住的具体内容，一两句话"),
      }),
    }
  );

  const memoryRecall = tool(
    async ({ query }) => {
      const result = await memorySlot.search({ scope: memoryScope(profileId), text: query, limit: 10 });
      if (result.degraded) return `长期记忆暂时不可用：${result.message || "Provider 降级"}`;
      const hits = result.records;
      if (!hits.length) return `没有与「${query}」相关的长期记忆。`;
      return hits.map((entry) => `[${entry.key}] ${entry.content}`).join("\n");
    },
    {
      name: "memory_recall",
      description: MEMORY_RECALL_DESCRIPTION,
      schema: z.object({
        query: z.string().describe("搜索关键词，多个词用空格分隔"),
      }),
    }
  );

  return { memorySave, memoryRecall, memoryTools: [memorySave, memoryRecall] };
}

const defaults = createMemoryTools("general");
export const memorySave = defaults.memorySave;
export const memoryRecall = defaults.memoryRecall;
export const memoryTools = defaults.memoryTools;
