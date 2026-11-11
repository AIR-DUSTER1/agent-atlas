/**
 * ============================================================
 * workflow-plan.ts — 自主执行流程的领域模型与状态迁移
 * ============================================================
 * 职责：定义 Agent 执行流程、规范化模型规划、应用步骤进度更新。
 * 设计立场：
 *  - 流程是 checkpoint 中的结构化状态，不是聊天正文；前端只消费快照；
 *  - 只有 2-8 个可验证步骤才值得创建流程，简单问答不生成空壳；
 *  - 每次状态迁移都带 revision，SSE 断线重放时前端可幂等覆盖。
 */

export const WORKFLOW_PLAN_TOOL_NAME = "update_workflow_plan";
export const MIN_WORKFLOW_STEPS = 2;
export const MAX_WORKFLOW_STEPS = 8;

const MAX_GOAL_CHARS = 240;
const MAX_STEP_TITLE_CHARS = 120;
const MAX_STEP_DETAIL_CHARS = 320;
const MAX_STEP_NOTE_CHARS = 280;

export type WorkflowStepStatus = "pending" | "in_progress" | "completed" | "failed" | "skipped";
export type WorkflowPlanStatus = "running" | "completed" | "failed";

export interface WorkflowPlanStep {
  id: string;
  title: string;
  detail?: string;
  status: WorkflowStepStatus;
  note?: string;
}

export interface WorkflowPlanSnapshot {
  id: string;
  revision: number;
  goal: string;
  steps: WorkflowPlanStep[];
  status: WorkflowPlanStatus;
  activeStepId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface WorkflowPlanDraftStep {
  /** normalizeWorkflowPlanDraft 一定会补齐稳定 id；原始模型输出由 unknown 解析。 */
  id: string;
  title: string;
  detail?: string;
}

export interface WorkflowPlanDraft {
  goal: string;
  steps: WorkflowPlanDraftStep[];
}

export interface WorkflowPlanUpdate {
  stepId: string;
  status: WorkflowStepStatus;
  note?: string;
}

export interface WorkflowPlanToolInput {
  goal?: string;
  steps?: WorkflowPlanDraftStep[];
  updates?: WorkflowPlanUpdate[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function uniqueStepId(raw: string, index: number, seen: Set<string>): string {
  const base = /^[a-zA-Z0-9_-]{1,32}$/.test(raw) ? raw : `step-${index + 1}`;
  let id = base;
  let suffix = 2;
  while (seen.has(id)) {
    id = `${base}-${suffix}`;
    suffix += 1;
  }
  seen.add(id);
  return id;
}

/** 接受模型常见的字符串 / 对象步骤形状，坏步骤逐条丢弃而不是让整次规划失效。 */
export function normalizeWorkflowPlanDraft(value: unknown): WorkflowPlanDraft | null {
  const record = asRecord(value);
  const rawSteps = Array.isArray(record?.steps)
    ? record.steps
    : Array.isArray(value)
      ? value
      : [];
  if (!rawSteps.length) return null;

  const seen = new Set<string>();
  const steps: WorkflowPlanDraftStep[] = [];
  for (const [index, item] of rawSteps.entries()) {
    const itemRecord = asRecord(item);
    const title = text(itemRecord?.title ?? itemRecord?.label ?? item, MAX_STEP_TITLE_CHARS);
    if (!title) continue;
    const suggestedId = text(itemRecord?.id, 32);
    const step: WorkflowPlanDraftStep = {
      id: uniqueStepId(suggestedId, index, seen),
      title,
    };
    const detail = text(itemRecord?.detail ?? itemRecord?.description, MAX_STEP_DETAIL_CHARS);
    if (detail) step.detail = detail;
    steps.push(step);
    if (steps.length >= MAX_WORKFLOW_STEPS) break;
  }
  if (steps.length < MIN_WORKFLOW_STEPS) return null;

  const goal = text(record?.goal ?? record?.objective ?? record?.title, MAX_GOAL_CHARS)
    || steps[0]?.title
    || "执行任务";
  return { goal, steps };
}

function derivePlanStatus(steps: WorkflowPlanStep[]): WorkflowPlanStatus {
  const unfinished = steps.some((step) => step.status === "pending" || step.status === "in_progress");
  if (unfinished) return "running";
  return steps.some((step) => step.status === "failed") ? "failed" : "completed";
}

function ensureSingleActiveStep(steps: WorkflowPlanStep[]): string | null {
  let active: string | null = null;
  for (const step of steps) {
    if (step.status !== "in_progress") continue;
    if (active) step.status = "pending";
    else active = step.id;
  }
  if (!active) {
    const next = steps.find((step) => step.status === "pending");
    if (next) {
      next.status = "in_progress";
      active = next.id;
    }
  }
  return active;
}

/**
 * 从需求分析结果创建初始流程。第一个步骤直接标为进行中：调用方拿到流程后
 * 会立刻进入执行节点，UI 不应先显示一个没有归属的“未开始”空状态。
 */
export function createWorkflowPlanFromDraft(
  draft: WorkflowPlanDraft,
  now = Date.now(),
  id = `plan-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
): WorkflowPlanSnapshot | null {
  const normalized = normalizeWorkflowPlanDraft(draft);
  if (!normalized) return null;
  const steps: WorkflowPlanStep[] = normalized.steps.map((step, index) => ({
    ...step,
    status: index === 0 ? "in_progress" : "pending",
  }));
  return {
    id,
    revision: 1,
    goal: normalized.goal,
    steps,
    status: "running",
    activeStepId: steps[0]?.id ?? null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 把 update_workflow_plan 的参数应用到当前流程。
 * 支持一次创建（steps）和增量推进（updates）；未知步骤 id 被忽略，避免模型
 * 把旧轮次的步骤写进本轮。
 */
export function applyWorkflowPlanToolInput(
  current: WorkflowPlanSnapshot | null,
  input: unknown,
  now = Date.now(),
): WorkflowPlanSnapshot | null {
  const record = asRecord(input);
  if (!record) return current;

  const replacingSteps = Array.isArray(record.steps);
  const draft = replacingSteps
    ? normalizeWorkflowPlanDraft({ goal: record.goal ?? current?.goal, steps: record.steps })
    : null;
  if (replacingSteps && !draft) return current;

  let base: WorkflowPlanSnapshot | null = current;
  if (!base && draft) {
    base = createWorkflowPlanFromDraft(draft, now);
    if (!base) return null;
  } else if (base && draft) {
    const oldById = new Map(base.steps.map((step) => [step.id, step]));
    const steps: WorkflowPlanStep[] = draft.steps.map((step) => {
      const old = oldById.get(step.id ?? "");
      return {
        ...step,
        status: old?.status ?? "pending",
        ...(old?.note ? { note: old.note } : {}),
      };
    });
    base = {
      ...base,
      goal: draft.goal,
      steps,
      revision: base.revision + 1,
      updatedAt: now,
    };
  }

  if (!base) return current;
  const goal = text(record.goal, MAX_GOAL_CHARS);
  let steps = base.steps.map((step) => ({ ...step }));
  if (goal) base = { ...base, goal };

  const rawUpdates = Array.isArray(record.updates) ? record.updates : [];
  let changed = Boolean(draft) || Boolean(goal);
  for (const raw of rawUpdates) {
    const update = asRecord(raw);
    const stepId = text(update?.stepId ?? update?.id, 32);
    const status = update?.status;
    if (!stepId || status !== "pending" && status !== "in_progress" && status !== "completed" && status !== "failed" && status !== "skipped") continue;
    const step = steps.find((item) => item.id === stepId);
    if (!step) continue;
    step.status = status;
    const note = text(update?.note, MAX_STEP_NOTE_CHARS);
    if (note) step.note = note;
    else if (status !== "in_progress") delete step.note;
    changed = true;
  }

  if (!changed) return current;
  const activeStepId = ensureSingleActiveStep(steps);
  const status = derivePlanStatus(steps);
  return {
    ...base,
    steps,
    status,
    activeStepId: status === "running" ? activeStepId : null,
    revision: current ? current.revision + 1 : base.revision,
    updatedAt: now,
  };
}

/** 反思通过或达到终止条件时封口；重复调用保持幂等，不制造无意义的 revision。 */
export function finalizeWorkflowPlan(
  plan: WorkflowPlanSnapshot | null,
  status: "completed" | "failed",
  now = Date.now(),
): WorkflowPlanSnapshot | null {
  if (!plan) return null;
  if (plan.status === status && plan.activeStepId === null) return plan;
  return {
    ...plan,
    status,
    activeStepId: null,
    revision: plan.revision + 1,
    updatedAt: now,
  };
}

export function workflowPlanSummary(plan: WorkflowPlanSnapshot | null): string {
  if (!plan) return "（本轮没有执行流程）";
  const lines = plan.steps.map((step) => {
    const active = step.id === plan.activeStepId ? " ← 当前" : "";
    const note = step.note ? `：${step.note}` : "";
    return `- [${step.status}] ${step.title}${note}${active}`;
  });
  return `目标：${plan.goal}\n${lines.join("\n")}`;
}

/**
 * 注入每一轮 Agent 上下文的流程契约。它是跨领域共享的编排规则，所以不写进
 * 单个 profile 的 systemPrompt，避免通用 / 找房 / 求职三套提示词漂移。
 */
export function workflowPlanPrompt(plan: WorkflowPlanSnapshot | null): string {
  const rules = [
    "【执行流程契约】",
    "1. 复杂任务（需要两个以上可验证步骤、多次工具调用或明确依赖顺序）在开始执行前，必须单独调用 update_workflow_plan 创建 2-8 步流程；简单问答、单次查询和纯计算不要创建流程。",
    "2. 创建参数：{\"goal\":\"一句话目标\",\"steps\":[{\"id\":\"step-1\",\"title\":\"可验证动作\"}]}；创建后先等工具返回，再执行步骤。",
    "3. 每个步骤开始/结束时调用 update_workflow_plan：{\"updates\":[{\"stepId\":\"step-1\",\"status\":\"completed\",\"note\":\"证据或结果\"},{\"stepId\":\"step-2\",\"status\":\"in_progress\"}]}；只有一个步骤进行中。",
    "4. completed 必须有真实工具结果或明确产出支撑；失败标 failed，跳过标 skipped 并写明原因。全部步骤结束后才能收尾。",
    "5. 规划调用必须单独发起，不要和 terminal、write_file、browser 等业务工具放在同一批。",
  ];
  if (plan) rules.push("", "当前流程：", workflowPlanSummary(plan));
  return rules.join("\n");
}