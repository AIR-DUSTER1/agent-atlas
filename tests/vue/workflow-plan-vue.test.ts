/**
 * workflow-plan-vue.test.ts — 执行流程状态标记与图标热更新
 * ============================================================
 * 守住三件事：进行中/完成/历史完成要有独立图标；Vue 只改 data-icon 时
 * SVG 必须重新水合；步骤状态文字与图标不能错位。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import WorkflowPlanVue from "../../src/client/views/chat/workflow-plan-vue.vue";
import { useWorkflowPlanStore } from "../../src/client/stores/chat/workflow-plan.js";
import { state } from "../../src/client/core/state.js";
import { initIconHydration } from "../../src/client/ui/icon.js";
import type { WorkflowPlanSnapshot } from "../../src/client/modules/types-api.js";

let pinia: Pinia;
let wrapper: VueWrapper | null = null;

function plan(statuses: Array<"pending" | "in_progress" | "completed" | "failed" | "skipped">, activeStepId: string | null, revision = 1): WorkflowPlanSnapshot {
  return {
    id: "plan-icons",
    revision,
    goal: "验证执行流程状态图标",
    status: statuses.every((status) => status === "completed" || status === "skipped") ? "completed" : "running",
    activeStepId,
    createdAt: 1,
    updatedAt: revision,
    steps: statuses.map((status, index) => ({
      id: `step-${index + 1}`,
      title: `步骤 ${index + 1}`,
      status,
    })),
  };
}

beforeEach(() => {
  document.body.innerHTML = '<div id="workflow-plan-test"></div>';
  pinia = createPinia();
  setActivePinia(pinia);
  state.currentId = "session-icons";
  state.workflowPlans = {};
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

describe("执行流程状态图标", () => {
  it("进行中、完成和历史完成会在同一 DOM 上热切换为正确 SVG", async () => {
    wrapper = mount(WorkflowPlanVue, { attachTo: document.getElementById("workflow-plan-test")!, global: { plugins: [pinia] } });
    const store = useWorkflowPlanStore();
    store.apply(plan(["in_progress", "pending", "pending"], "step-1"), "session-icons");
    await flushPromises();

    initIconHydration(document.body);
    const markers = () => [...document.querySelectorAll<HTMLElement>("#workflow-steps .workflow-step-marker .ui-icon")];
    await vi.waitFor(() => {
      expect(markers()).toHaveLength(3);
      expect(markers().every((icon) => icon.dataset.iconReady === "1" && icon.querySelector("svg"))).toBe(true);
    });
    expect(markers()[0]?.dataset.icon).toBe("Loader");
    expect(markers()[1]?.dataset.icon).toBe("MoreHorizontal");
    expect(markers()[2]?.dataset.icon).toBe("MoreHorizontal");

    store.apply(plan(["completed", "in_progress", "pending"], "step-2", 2), "session-icons");
    await flushPromises();
    await vi.waitFor(() => {
      expect(markers()[0]?.dataset.icon).toBe("Check");
      expect(markers()[1]?.dataset.icon).toBe("Loader");
      expect(markers()[0]?.dataset.iconReady).toBe("1");
      expect(markers()[1]?.dataset.iconReady).toBe("1");
    });
    expect(markers()[0]?.querySelector("svg")).not.toBeNull();
    expect(markers()[1]?.querySelector("svg")).not.toBeNull();

    // 历史回放直接载入全完成状态，也必须水合成 Check，而不是沿用旧图标。
    store.apply(plan(["completed", "completed", "completed"], null, 3), "session-icons");
    await flushPromises();
    await vi.waitFor(() => {
      expect(markers().every((icon) => icon.dataset.icon === "Check" && icon.dataset.iconReady === "1")).toBe(true);
      expect(markers().every((icon) => Boolean(icon.querySelector("svg")))).toBe(true);
    });
    const failedPlan = plan(["completed", "failed", "skipped"], null, 4);
    failedPlan.status = "failed";
    store.apply(failedPlan, "session-icons");
    await flushPromises();
    await vi.waitFor(() => {
      expect(markers()[0]?.dataset.icon).toBe("Check");
      expect(markers()[1]?.dataset.icon).toBe("X");
      expect(markers()[2]?.dataset.icon).toBe("ChevronRight");
      expect(markers().every((icon) => icon.dataset.iconReady === "1")).toBe(true);
    });
  });
});
