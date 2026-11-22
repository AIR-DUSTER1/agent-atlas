<!--
  workflow-plan-vue.vue — 输入框上方的自主执行流程窗体（框架迁移 M4 批次 4.6）
  ============================================================
  职责：折叠摘要、目标、步骤状态与总进度。DOM 契约与 h() 版逐 id / 类名
  一致（workflow-panel / workflow-active / workflow-status / workflow-count /
  workflow-meter / workflow-meter-fill / workflow-percent / workflow-goal /
  workflow-steps / .workflow-step.status-*），composer e2e 依赖这些锚点。
  立场：
  - 无计划完全不占位；新流程默认收起，用户展开后更新不抢回折叠态；
  - 步骤文本全部走插值，无 HTML 注入面。
-->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useWorkflowPlanStore } from "../../stores/workflow-plan.js";
import type { WorkflowPlanStep, WorkflowStepStatus } from "../../modules/types-api.js";

const STEP_STATUS_LABEL: Record<WorkflowStepStatus, string> = {
  pending: "待执行",
  in_progress: "进行中",
  completed: "已完成",
  failed: "失败",
  skipped: "已跳过",
};

const STEP_STATUS_ICON: Record<WorkflowStepStatus, string> = {
  pending: "Clock",
  in_progress: "LoaderCircle",
  completed: "CircleCheck",
  failed: "CircleX",
  skipped: "ChevronRight",
};

const store = useWorkflowPlanStore();
const panel = ref<HTMLDetailsElement | null>(null);
const open = ref(false);

/** 新流程到来时收起（store.planKey 变化 → userOpened 已被重置）。 */
watch(() => store.planKey, () => { open.value = false; });
watch(() => store.userOpened, (value) => { open.value = value; });

const visible = computed(() => Boolean(store.plan && store.steps.length > 0));

function stepMeta(step: WorkflowPlanStep): string {
  return step.note || step.detail || "";
}

function isActive(step: WorkflowPlanStep): boolean {
  return Boolean(store.plan) && step.id === store.plan!.activeStepId && step.status === "in_progress";
}

function onToggle(event: Event): void {
  const target = event.target as HTMLDetailsElement;
  store.toggleOpen(target.open);
}
</script>

<template>
  <details
    id="workflow-panel"
    ref="panel"
    v-show="visible"
    class="workflow-panel"
    :class="{ hidden: !visible }"
    :open="visible && open"
    @toggle="onToggle"
  >
    <summary class="workflow-summary" aria-label="展开或收起执行流程">
      <span class="workflow-summary-icon"><i class="ui-icon" data-icon="Waypoints" aria-hidden="true"></i></span>
      <span class="workflow-summary-copy">
        <strong>执行流程</strong>
        <span id="workflow-active">{{ store.activeText }}</span>
      </span>
      <span id="workflow-status" class="workflow-status" :class="`status-${store.plan?.status}`">{{ store.statusLabel }}</span>
      <span id="workflow-count" class="workflow-count">{{ store.completedCount }}/{{ store.steps.length }} 步</span>
      <span
        id="workflow-meter"
        class="workflow-meter"
        role="progressbar"
        aria-label="执行流程进度"
        aria-valuemin="0"
        aria-valuemax="100"
        :aria-valuenow="store.percent"
        :aria-valuetext="`已完成 ${store.completedCount} 个步骤，共 ${store.steps.length} 个`"
      >
        <span id="workflow-meter-fill" class="workflow-meter-fill" :class="`status-${store.plan?.status}`" :style="{ width: `${store.percent}%` }"></span>
      </span>
      <span id="workflow-percent" class="workflow-percent">{{ store.percent }}%</span>
      <span class="workflow-chevron" aria-hidden="true"><i class="ui-icon" data-icon="ChevronRight"></i></span>
    </summary>
    <div class="workflow-body">
      <div class="workflow-goal-row">
        <span class="workflow-goal-label">目标</span>
        <span id="workflow-goal" class="workflow-goal">{{ store.plan?.goal }}</span>
      </div>
      <ol id="workflow-steps" class="workflow-steps" aria-label="执行步骤">
        <li
          v-for="(step, index) in store.steps"
          :key="step.id"
          class="workflow-step"
          :class="[`status-${step.status}`, { 'is-active': isActive(step) }]"
          :aria-current="isActive(step) ? 'step' : undefined"
        >
          <span class="workflow-step-marker" aria-hidden="true">
            <i class="ui-icon" :data-icon="STEP_STATUS_ICON[step.status]" aria-hidden="true" style="--icon-size: 14px"></i>
          </span>
          <div class="workflow-step-copy">
            <div class="workflow-step-title">
              <span class="workflow-step-index">{{ String(index + 1).padStart(2, "0") }}</span>
              <strong>{{ step.title }}</strong>
            </div>
            <p v-if="stepMeta(step)" class="workflow-step-note">{{ stepMeta(step) }}</p>
          </div>
          <span class="workflow-step-status">{{ STEP_STATUS_LABEL[step.status] }}</span>
        </li>
      </ol>
    </div>
  </details>
</template>
