/**
 * ============================================================
 * tools-plan.ts — Agent 自主执行流程的内部受控工具
 * ============================================================
 * 职责：让主 Agent 在理解需求后创建/推进流程，本身不产生副作用。
 * 设计立场：流程状态由 LangGraph 的 planProgress 节点统一落库；工具只承接
 * 参数并通过 zod 守门，避免把状态迁移散落在模型生成路径里。
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { WORKFLOW_PLAN_TOOL_NAME } from "./workflow-plan.js";

const stepStatus = z.enum(["pending", "in_progress", "completed", "failed", "skipped"]);

const planSchema = z.object({
  goal: z.string().trim().max(240).optional().describe("本轮任务的一句话目标；创建流程时必填"),
  steps: z.array(z.object({
    id: z.string().trim().max(32).optional().describe("稳定步骤 id，如 step-1"),
    title: z.string().trim().min(1).max(120).describe("可验证的动作标题"),
    detail: z.string().trim().max(320).optional().describe("可选执行说明"),
  })).min(2).max(8).optional().describe("首次创建流程时的完整步骤列表"),
  updates: z.array(z.object({
    stepId: z.string().trim().min(1).max(32).describe("要更新的步骤 id"),
    status: stepStatus.describe("步骤最新状态"),
    note: z.string().trim().max(280).optional().describe("完成证据、失败原因或跳过说明"),
  })).min(1).max(8).optional().describe("增量推进步骤时使用"),
}).refine((value) => Boolean(value.steps?.length || value.updates?.length), {
  message: "至少提供 steps 或 updates",
});

export const updateWorkflowPlanTool = tool(
  async () => JSON.stringify({ ok: true, message: "执行流程更新已接收，下一步按流程继续。" }),
  {
    name: WORKFLOW_PLAN_TOOL_NAME,
    description:
      "创建或更新当前任务的可见执行流程。复杂任务开始时用 steps 创建 2-8 步；" +
      "每个步骤开始/完成后用 updates 推进状态。简单问答不要调用。此工具必须单独调用，不能与其他业务工具同批。",
    schema: planSchema,
  },
);