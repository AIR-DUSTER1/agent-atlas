/**
 * workflow/nodes/agent.ts — ReAct 主模型节点
 * ============================================================
 * 负责把需求、反思、记忆、技能、权限和窗口预算组装成稳定上下文，再发起一次模型调用；
 * 工具执行仍由 hitl.ts 的 approvalToolsNode 负责，不在这里直接触达外部服务。
 */
import { buildAgentContext } from "../../context-builder.js";
import { memorySlot } from "../../../memory/slot.js";
import { memoryScope } from "../../../memory/scope.js";
import { rememberHistoryReasoning } from "../../../reasoning-passthrough.js";
import { skillNoteForMessage } from "../../../skills.js";
import { sanitizeCheckpointMessage } from "../../checkpoint-sanitize.js";
import { permissionModeNote, type PermissionMode } from "../../permission.js";
import { workflowPlanPrompt } from "../../../workflow-plan.js";
import { invokeModel } from "../model-adapter.js";
import { lastHumanText } from "../message-utils.js";
import type { WorkflowRuntime } from "../runtime.js";
import type { WorkflowStateType } from "../state.js";

type AgentNodeConfig = {
  signal?: AbortSignal;
  configurable?: {
    permission_mode?: PermissionMode;
    task_ledger?: string;
    task_budget_note?: string;
    context_window?: number;
    personalization_context?: string;
  };
};

export function createAgentNode(runtime: WorkflowRuntime) {
  return async function agentNode(state: WorkflowStateType, config?: AgentNodeConfig) {
    // 上下文投影 + 内部注记统一走 context-builder：需求 brief / 历史澄清 /
    // 反思反馈 / 权限模式 / 跨会话长期记忆在这里组装成稳定 system，
    // 消息窗口与工具结果按预算裁剪。记忆注记每轮动态拼（不落 checkpoint），
    // 新会话、甚至服务重启后的第一轮就能看到全部记忆。
    // 技能：只匹配「最近一条用户消息」（不看整段历史，避免旧话题的关键词
    // 每轮都把技能拽进来）。未命中返回 null，上下文里不会多出任何内容。
    const lastUserText = lastHumanText(state.messages);
    const skillNote = await skillNoteForMessage(lastUserText);
    const context = buildAgentContext({
      profile: runtime.profile,
      messages: state.messages,
      requirementBrief: state.requirementBrief,
      clarificationHistory: state.clarificationHistory,
      reviewFeedback: state.reviewFeedback,
      permissionNote: permissionModeNote(config?.configurable?.permission_mode),
      personalizationContext: config?.configurable?.personalization_context,
      memoryNote: (await memorySlot.note({
        scope: memoryScope(runtime.profile.id, runtime.options.userId),
        query: lastUserText,
      })) ?? undefined,
      workflowPlanNote: runtime.planningEnabled ? workflowPlanPrompt(state.workflowPlan) : undefined,
      skillNote: skillNote ?? undefined,
      dispatchBrief: state.dispatchBrief
        ? `【子代理已完成的工作（作为你的已知事实，不要重复调用相同工具）】\n${state.dispatchBrief}`
        : undefined,
      taskLedger: config?.configurable?.task_ledger,
      budgetNote: config?.configurable?.task_budget_note,
      contextWindow: config?.configurable?.context_window,
    });
    // 思考型网关要求把历史 assistant 的 reasoning_content 原样回传；先从
    // checkpoint 消息里重新登记一次（服务重启后内存记录为空，靠这一步自愈），
    // 出站补字段由 llm.ts 的 fetch 封装完成。
    rememberHistoryReasoning(runtime.options.sessionId, context.messages);
    const response = await invokeModel(runtime.agentModel, context.messages, config?.signal, runtime.options.sessionId);
    runtime.observeModel("agent", response);
    // 网关回显的 tools/output 与 dataURL 会原样进入 checkpoint；先投影再入状态。
    return { messages: [sanitizeCheckpointMessage(response)] };
  };
}