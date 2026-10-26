/**
 * ============================================================
 * tools-team.ts — 多智能体协同工具（delegate_agent）
 * ============================================================
 * 给主 Agent 提供「把子任务委派给另一个 Agent」的能力：
 *   delegate_agent({ profile, task })
 *     → subagent.runSubagent 用目标 profile 的 workflow 子图后台跑完任务
 *     → 结果文本作为工具结果回填，主 Agent 汇总进最终回答。
 *
 * 委派语义（何时用 / 何时不用，description 同步给模型）：
 *   - 用：跨域子任务（如查房产行情）、独立的信息收集（隔离上下文，
 *     避免大量工具结果污染主对话）；
 *   - 不用：自己两三个工具能解决的事、需要写操作的任务（子 Agent 只读）。
 *
 * 依赖方向坑：general.ts 挂载本工具（import 本文件），而本工具要按
 * profileId 取 generalProfile / estateProfile —— 若顶层静态 import 两个
 * profile 文件会形成 general ↔ tools-team 的 import 环。这里用工具函数内的
 * **动态 import**（模块缓存，无性能损耗）在运行时取 profile，环不存在。
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { runSubagent } from "./agent/subagent.js";
import type { AgentProfile } from "./agent/profile.js";

/** 任务书长度上限（与 subagent.ts 的 MAX_TASK_CHARS 对齐） */
const MAX_TASK_CHARS = 2_000;

/** profile id → 中文名（审批文案与工具描述共用；新增子 Agent 候选时同步这里与下方枚举） */
const SUBAGENT_LABELS: Record<string, string> = {
  general: "通用",
  estate: "房产找房",
};

/** 运行时按 id 取 profile（动态 import 破 general ↔ tools-team 循环） */
async function loadSubagentProfile(profileId: string): Promise<AgentProfile> {
  if (profileId === "general") {
    return (await import("./agent/general.js")).generalProfile;
  }
  if (profileId === "estate") {
    return (await import("./agent/estate.js")).estateProfile;
  }
  throw new Error(`未知子 Agent：${profileId}`);
}

export const delegateAgent = tool(
  async ({ profile, task }) => {
    try {
      const target = await loadSubagentProfile(profile);
      const result = await runSubagent(target, task);
      // 返回结构化 JSON：前端委派卡要渲染「耗时 / 用了哪些工具」，
      // 纯文本的话这些信息只能靠正则再抠一遍。
      return JSON.stringify({
        ok: result.ok,
        text: result.text,
        durationMs: result.durationMs,
        toolsUsed: result.toolsUsed ?? [],
        profile,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `委派失败：${message.slice(0, 200)}。请转述原因，不要盲目重试。`;
    }
  },
  {
    name: "delegate_agent",
    description:
      "把一个独立的子任务委派给指定的子 Agent 后台执行（子 Agent 只读权限、独立上下文，" +
      "结果以文本返回）。适合：跨域查询（如房产行情）、大批量信息收集（避免工具结果撑爆主对话）。" +
      "不适合：自己几个工具就能完成的事；需要写文件/执行命令/发消息的任务（子 Agent 只读，会失败）。" +
      "一次委派会消耗多轮模型调用，执行前需要用户批准。",
    schema: z.object({
      profile: z.enum(["general", "estate"]).describe(
        `子 Agent：general=通用（编程/文件/知识库检索），estate=房产找房（贝壳数据）`
      ),
      task: z.string().max(MAX_TASK_CHARS).describe(
        "一句话任务书：目标 + 范围 + 期望输出格式。写得越具体，子 Agent 越不需要澄清。"
      ),
    }),
  }
);

/** 多智能体协同工具集（挂在 general profile；子 Agent 自身不可再见此工具，深度 = 1） */
export const teamTools = [delegateAgent];
