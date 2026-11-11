/**
 * ============================================================
 * events.ts — 服务端 → 前端 的「规范化事件流」协议
 * ============================================================
 * 为什么需要规范化？
 *   LangGraph 原始流事件（streamMode: messages / updates）形状复杂：
 *   元组嵌套、子图回显历史、AIMessageChunk 与完整消息混杂。
 *   后端先把原始事件「翻译」成下面这几种简单事件，前端只关心渲染，
 *   不需要理解 LangGraph 的流协议 —— 同时也天然解决了：
 *     - 子图把整段历史回显一遍的「去重」问题（服务端按消息 id 过滤）
 *     - 多模式事件（[mode, payload] 元组）的拆包问题
 *
 * 每种事件对应 ZCode 聊天界面里的一块 UI：
 *   node        → 节点执行步骤小徽章（agent / tools / researcher/agent …）
 *   reasoning   → 供应商原生思考过程（前端默认折叠）
 *   model_retry → 模型请求自动重试进度（前端默认折叠）
 *   token       → 助手正文流式文本（打字机效果）
 *   tool_call   → 工具调用卡片（参数随流式增量到达，边收边渲染）
 *   tool_result → 工具卡片填入结果，状态从「运行中」变「完成」
 *   interrupt   → Human-in-the-loop 审批卡片 / 需求澄清选项
 *   clarification_note → 无头模式下自动采用的假设（不挂起、不等人）
 *   route_decision → 路由决策卡片（派给谁 / 依据 / 来自哪一层 / 可解释分数）
 *   workflow_plan → 输入框上方的自主执行流程快照（创建 / 步骤推进 / 收口）
 *   usage       → 本轮模型调用的 token 用量（驱动上下文容量条 + 缓存占比）
 *   task_usage  → 本轮结束时的任务累计用量（下游统计的权威口径）
 *   ai_message  → 整段助手消息兜底（极少数网关不支持 token 流时使用）
 *   shutdown    → 服务端优雅退出通知（前端提示「稍后刷新重连」）
 *   error/done  → 错误提示 / 本轮流结束
 */

import type { WorkflowPlanSnapshot } from "../workflow-plan.js";

/** 与 hitl.ts 复用审批载荷形状（避免循环依赖，这里独立声明同构类型）。 */
export interface ApprovalPayload {
  type: "approval";
  toolName: string;
  description: string;
  args: Record<string, unknown>;
}

/** 与 agent/workflow.ts 的 ClarificationRequest 同构；用户选择通过 /api/resume 回传。 */
export interface ClarificationOption {
  id: string;
  label: string;
  description?: string;
}

/** 一道澄清题：选项 id 只在本道题内唯一。 */
export interface ClarificationQuestion {
  id: string;
  question: string;
  options: ClarificationOption[];
  allowCustom: boolean;
}

/**
 * 一张澄清卡可以打包多道题（最多 4 道），前端逐题作答后一次性提交。
 * 旧 journal 里的单问形状（顶层 question + options）由前端归一化兼容，
 * 服务端只声明新形状，避免两处都留分叉判断。
 */
export interface ClarificationPayload {
  type: "clarification";
  questions: ClarificationQuestion[];
}

export type InterruptPayload = ApprovalPayload | ClarificationPayload;

export type AgentEvent =
  /** 进入某个图节点（name 可能是 "agent" 或子图路径 "researcher/agent"） */

  | { type: "node"; name: string }
  /**
   * 模型供应商原生返回的思考过程增量（reasoning_content / thinking block）。
   * 与 token 分开是为了让前端默认折叠；没有原生思考字段时不会伪造。
   */
  | { type: "reasoning"; text: string; node?: string }
  /** 模型请求失败后的自动重试进度；前端默认折叠成一张可展开卡。 */
  | {
      type: "model_retry";
      attempt: number;
      retries: number;
      totalAttempts: number;
      phase: "retry" | "success" | "failed";
      reason: string;
      at: number;
    }
  /** 助手文本的流式增量片段 */
  | { type: "token"; text: string; node?: string }
  /**
   * 工具调用（流式）：name 首次出现时创建卡片，后续事件是参数 JSON 字符串的增量。
   * id 在同一次流内唯一，前端用它把「调用」和「结果」配对。
   */
  | { type: "tool_call"; id: string; name?: string; argsFragment: string }
  /** 工具执行完毕 */
  | { type: "tool_result"; id: string; content: string; isError?: boolean }
  /** 整段助手消息（兜底：token 流不可用时） */
  | { type: "ai_message"; content: string; node?: string }
  /**
   * 模型返回的 token 用量（取自 usage_metadata / tokenUsage）：
   * inputTokens ≈ 当时整段对话的上下文大小；cacheReadTokens 是提示词缓存命中数。
   * 同一回合约多模型协作（Demo 4）会有多条，前端保留最后一条即可。
   */
  | {
      type: "usage";
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      cacheReadTokens: number;
      /** 产生该用量的模型显示名（F2 统计按模型聚合；旧事件 / mock 外未知场景缺省） */
      model?: string;
      /**
       * 同一次模型调用的稳定 id。流式 usage 可能分多片到达，统计按此归并；
       * 旧 journal 没有该字段时，统计层按连续快照去重。
       */
      callId?: string;
      /** 产生用量的图节点；前端用它区分主循环与 review/analyze 辅助调用 */
      node?: string;
      /** 内部辅助模型调用：会计入统计成本，但不得覆盖上下文容量条 */
      internal?: boolean;
      /** 本次请求的目标上下文窗口容量；切换模型后前端保留 used、更新分母。 */
      contextWindow?: number;
      /** 输入可用预算：窗口扣除输出预留与安全余量后的 token 上限。 */
      contextInputBudget?: number;
      /** 输出预留 token。 */
      outputReserveTokens?: number;
      /** 估算/校验误差的安全余量 token。 */
      safetyMarginTokens?: number;
      /** 服务端权威的任务累计快照（跨审批 continuation 不重置）。 */
      taskInputTokens?: number;
      taskOutputTokens?: number;
      taskToolCalls?: number;
      taskModelCalls?: number;
      taskActiveMs?: number;
    }
  /**
   * 无头模式（/api/chat 带 headless:true）下，本会挂起等人的澄清被自动决策：
   * 采用 model 给出的默认假设继续执行。下游据此知道「这里本来要问人」。
   */
  | {
      type: "clarification_note";
      question: string;
      /** 采用的假设（选项标签或模型给的可执行默认值） */
      assumption: string;
      /** 原选项 id（采用某个候选时） */
      optionId?: string;
    }
  /**
   * 任务累计用量：本轮结束时（done 之前）发一次，是 token 统计的权威口径。
   * 同一轮内可能有多条 usage（每次模型调用一条），下游只取这一条即可。
   */
  | {
      type: "task_usage";
      inputTokens: number;
      outputTokens: number;
      toolCalls: number;
      modelCalls: number;
      activeMs: number;
      /** 本轮是否有等待人工的挂起（有则累计只到挂起前） */
      interrupted?: boolean;
    }
  /**
   * 路由决策：把「这轮为什么派给这个 agent」摊开给人看。
   * 三层都可能产出它（rule / vector / model / fallback），前端渲染成一张可折叠卡。
   */
  | {
      type: "route_decision";
      kind: "dispatch" | "ask" | "main";
      layer: "rule" | "vector" | "model" | "fallback";
      agentId?: string;
      agentName?: string;
      /** 0..1；规则层是归一化分，模型层是自报置信度 */
      confidence: number;
      /** top1 − top2 */
      margin: number;
      reason: string;
      candidates: Array<{ agentId: string; name: string; score: number }>;
      /** 本轮已发生的转回次数 */
      handoffCount: number;
    }
  /** HITL：图已暂停，等待人工审批或需求澄清 */
  | { type: "interrupt"; payload: InterruptPayload }
  /** 自主执行流程快照；plan=null 表示本轮没有流程，前端隐藏窗体。 */
  | { type: "workflow_plan"; plan: WorkflowPlanSnapshot | null }
  /** 自主审批的自动决定：仅供服务端审计，写 SSE 也无害（前端可忽略） */
  | {
      type: "risk_decision";
      decision: "auto";
      toolName: string;
      reason: string;
      callId?: string;
    }
  /** 优雅退出：由 lifecycle.shutdown 直接写入 SSE，不经过图/翻译层 */
  | { type: "shutdown"; message: string }
  | { type: "error"; message: string }
  | { type: "done" };

export type UsageEvent = Extract<AgentEvent, { type: "usage" }>;
