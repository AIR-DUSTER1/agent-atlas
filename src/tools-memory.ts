/**
 * tools-memory.ts — 跨会话长期记忆工具集（通用 Agent 用）
 *
 *   memory_save({key, content})   把「值得跨会话记住」的事实/偏好写入长期记忆
 *   memory_recall({query})        按关键词查长期记忆（注入上限之外的补充通道）
 *
 * 风险定级：只读写本服务自己的 .setting/memories.json，不改用户世界 →
 * 不登记人工审批（§5.4），三档权限模式全部直接执行；
 * 存储核心在 src/memory-store.ts（与设置页 API 共用）。
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { saveMemory, searchMemories } from "./memory-store.js";

export const memorySave = tool(
  async ({ key, content }) => {
    try {
      const entry = await saveMemory(key, content, "agent");
      return `已记住（长期记忆，跨会话生效）：[${entry.key}] ${entry.content}`;
    } catch (err) {
      // 工具层约定：失败不 throw 穿透图，返回模型可读中文错误
      return err instanceof Error ? err.message : `记忆保存失败：${String(err)}`;
    }
  },
  {
    name: "memory_save",
    description:
      "把用户表达的长期偏好、项目事实或对既往回答的纠正存入跨会话长期记忆（例：key=回答风格, content=结论先行少用列表）。" +
      "何时用：用户说「以后都…」「记住…」「我喜欢/不喜欢…」这类跨会话有效的信息时。" +
      "何时不用：只对当前对话有意义的信息（放进正常回答即可，不要保存）。",
    schema: z.object({
      key: z.string().describe("主题短语，10 字内（如：回答风格 / 测试命令 / 用户称呼）"),
      content: z.string().describe("要记住的具体内容，一两句话"),
    }),
  }
);

export const memoryRecall = tool(
  async ({ query }) => {
    const hits = searchMemories(query);
    if (!hits.length) return `没有与「${query}」相关的长期记忆。`;
    return hits
      .map((entry) => `[${entry.key}] ${entry.content}`)
      .join("\n");
  },
  {
    name: "memory_recall",
    description:
      "按关键词查询跨会话长期记忆（每轮自动注入最近 30 条，超出部分或想确认已记住什么时用）。" +
      "例：query=\"回答风格\"。",
    schema: z.object({
      query: z.string().describe("搜索关键词，多个词用空格分隔"),
    }),
  }
);

export const memoryTools = [memorySave, memoryRecall];
