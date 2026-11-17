/**
 * workflow/types.ts — 工作流公共载荷与模型契约
 * ============================================================
 * 只保留可被节点、解析器和外部调用方共享的类型；不引入图、存储或网络实现。
 */
import type { AIMessage } from "@langchain/core/messages";
import type { WorkflowPlanDraft } from "../../workflow-plan.js";

export interface ClarificationOption {
  id: string;
  label: string;
  description?: string;
}

/** 一道澄清题。选项 id 只在本题内唯一（A/B/C…），跨题重复没有意义。 */
export interface ClarificationQuestion {
  id: string;
  question: string;
  options: ClarificationOption[];
  allowCustom: boolean;
}

/**
 * interrupt() 的澄清载荷：与 server/events.ts 独立声明同构类型，避免 agent 反向依赖 server。
 *
 * 一次追问可以打包多道题（如求职同时缺城市/方向/薪资/年限）。原来一次只问一题，
 * 用户要连点四轮才能补全信息；现在一张卡全部答完再提交，减少来回。
 * 载荷不再带顶层 question/options —— 旧 journal 里的单问形状由前端归一化兼容。
 */
export interface ClarificationRequest {
  type: "clarification";
  questions: ClarificationQuestion[];
}

/** 可注入的模型壳：生产用 createChatModel，测试可用 FakeListChatModel 验证整图流转。 */
export interface WorkflowChatModel {
  invoke(input: unknown, options?: { signal?: AbortSignal }): Promise<AIMessage>;
}

export interface WorkflowModels {
  agent: WorkflowChatModel;
  analyst: WorkflowChatModel;
  reviewer: WorkflowChatModel;
}

export interface RequirementAnalysis {
  understood: boolean;
  brief: string;
  questions: ClarificationQuestion[];
  plan: WorkflowPlanDraft | null;
}

export interface ReviewResult {
  passes: boolean;
  reason: string;
  feedback: string;
}