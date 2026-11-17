/**
 * workflow/state.ts — LangGraph 工作流状态 Schema
 * ============================================================
 * 状态字段只描述图内可恢复事实；提示词、解析器和节点实现不得反向写入本模块。
 */
import { Annotation, MessagesAnnotation } from "@langchain/langgraph";
import type { RouteDecision } from "../../routing/types.js";
import type { WorkflowPlanSnapshot } from "../../workflow-plan.js";
import type { ClarificationRequest } from "./types.js";

export const WorkflowState = Annotation.Root({
  ...MessagesAnnotation.spec,
  requirementBrief: Annotation<string>({
    reducer: (_previous, next) => next ?? "",
    default: () => "",
  }),
  /** 本轮执行流程；analyze 每轮先清空，简单问答保持 null，前端据此隐藏流程窗体。 */
  workflowPlan: Annotation<WorkflowPlanSnapshot | null>({
    reducer: (_previous, next) => next,
    default: () => null,
  }),
  clarification: Annotation<ClarificationRequest | null>({
    reducer: (_previous, next) => next,
    default: () => null,
  }),
  clarificationHistory: Annotation<string>({
    reducer: (_previous, next) => next ?? "",
    default: () => "",
  }),
  reviewFeedback: Annotation<string>({
    reducer: (_previous, next) => next ?? "",
    default: () => "",
  }),
  reviewAttempts: Annotation<number>({
    reducer: (_previous, next) => next ?? 0,
    default: () => 0,
  }),
  /**
   * 无头模式下自动采用的假设（有值 = 本轮本该澄清但无人可问）。
   * 只用于把假设告诉调用方与模型，不参与后续路由判断。
   */
  headlessAssumption: Annotation<string>({
    reducer: (_previous, next) => next ?? "",
    default: () => "",
  }),
  /** 本轮路由决策（dispatch / ask / main），供流层产出 route_decision 事件 */
  routeDecision: Annotation<RouteDecision | null>({
    reducer: (_previous, next) => next,
    default: () => null,
  }),
  /** 本轮已转回次数（R7 硬约束 ≤ maxHandoffs，计数只能由节点代码改） */
  handoffCount: Annotation<number>({
    reducer: (_previous, next) => next ?? 0,
    default: () => 0,
  }),
  /** 已尝试过的子代理 id，防止 A→B→A 绕圈 */
  routeHistory: Annotation<string[]>({
    reducer: (_previous, next) => next ?? [],
    default: () => [],
  }),
  /**
   * 程序化派发布展出的任务书：路由节点生成，agent 节点作为前置事实注入。
   * 只在本轮内有效，不参与跨轮记忆。
   */
  dispatchBrief: Annotation<string>({
    reducer: (_previous, next) => next ?? "",
    default: () => "",
  }),
  /**
   * 连续工作模式（回合内有效）：反思不通过就持续回炉执行，直到反思通过 /
   * 空转熔断 / 请求异常 / 用户中止。在 analyze 从请求 configurable 读一次后写入
   * 图状态 —— 审批 resume 走同一线程检查点，状态还在，前端无需重传该标记。
   */
  continuousMode: Annotation<boolean>({
    reducer: (_previous, next) => next ?? false,
    default: () => false,
  }),
  /** 连续模式：上一次反思执行时的消息总数，用来计算「这轮回炉期间有没有新的工具动作」。 */
  lastReviewMessageCount: Annotation<number>({
    reducer: (_previous, next) => next ?? 0,
    default: () => 0,
  }),
  /** 连续模式：连续「反思不通过且期间无工具动作」的轮数；出现工具动作即清零。 */
  idleReviewRounds: Annotation<number>({
    reducer: (_previous, next) => next ?? 0,
    default: () => 0,
  }),
});

export type WorkflowStateType = typeof WorkflowState.State;