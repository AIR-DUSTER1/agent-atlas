/**
 * model-selection-picker.test.ts — 模型多选弹窗
 * ============================================================
 * 覆盖参考图要求的搜索、分组、全选/全不选、只看已选、至少保留一个模型，
 * 以及本地勾选后一次性 emit 应用。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import ModelSelectionPicker from "../../src/client/views/settings/models/model-selection-picker.vue";
import type { GatewayModel } from "../../src/client/modules/types.js";

let wrapper: VueWrapper | null = null;

const MODELS: GatewayModel[] = [
  { id: "glm-5-turbo", contextWindow: 200_000, supportsReasoning: true },
  { id: "glm-5.3-flash", contextWindow: 1_000_000, supportsReasoning: true, supportsVision: true },
  { id: "glm-5.3", contextWindow: 1_000_000, supportsReasoning: true },
];

beforeEach(() => {
  document.body.innerHTML = "";
  document.body.style.overflow = "";
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

function row(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.model-picker-row[data-model-id="${id}"]`);
}

function checkbox(id: string): HTMLInputElement {
  const input = row(id)?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (!input) throw new Error(`找不到 ${id} 的复选框`);
  return input;
}

describe("模型多选弹窗", () => {
  it("支持分组、搜索、全选/全不选、只看已选和批量应用", async () => {
    wrapper = mount(ModelSelectionPicker, {
      attachTo: document.body,
      props: {
        open: true,
        title: "选择模型",
        models: MODELS,
        extraModels: [{ id: "glm-legacy", contextWindow: 200_000 }],
        selectedNames: ["glm-5-turbo", "glm-legacy"],
      },
    });
    await flushPromises();

    expect(document.querySelector(".model-picker-group.is-missing")?.textContent).toContain("不在供应商列表中");
    expect(document.querySelector(".model-picker-group:not(.is-missing)")?.textContent).toContain("供应商返回的模型");
    expect(checkbox("glm-5-turbo").checked).toBe(true);
    expect(checkbox("glm-legacy").checked).toBe(true);
    expect(checkbox("glm-5.3").checked).toBe(false);

    const search = document.querySelector<HTMLInputElement>("#model-selection-search")!;
    search.value = "flash";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await flushPromises();
    await vi.waitFor(() => expect(document.querySelectorAll(".model-picker-row")).toHaveLength(1));
    expect(row("glm-5.3-flash")).not.toBeNull();

    search.value = "";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await flushPromises();
    document.querySelector<HTMLElement>(".model-picker-only-selected input")?.click();
    await flushPromises();
    await vi.waitFor(() => expect(document.querySelectorAll(".model-picker-row")).toHaveLength(2));

    document.querySelector<HTMLElement>(".model-picker-only-selected input")?.click();
    await flushPromises();
    await vi.waitFor(() => expect(document.querySelectorAll(".model-picker-row")).toHaveLength(4));

    document.querySelector<HTMLElement>(".model-picker-clear-all")?.click();
    await flushPromises();
    await vi.waitFor(() => {
      expect(document.querySelector(".model-picker-warning")?.textContent).toContain("至少保留一个模型");
      expect(document.querySelector<HTMLButtonElement>(".model-picker-apply")?.disabled).toBe(true);
    });

    checkbox("glm-5-turbo").click();
    checkbox("glm-5.3-flash").click();
    await flushPromises();
    document.querySelector<HTMLElement>(".model-picker-apply")?.click();
    await flushPromises();

    const applied = wrapper.emitted("apply")?.[0]?.[0] as GatewayModel[];
    expect(applied.map((model) => model.id)).toEqual(["glm-5-turbo", "glm-5.3-flash"]);
  });

  it("整行点击只切换一次，Esc 取消不会提交草稿", async () => {
    wrapper = mount(ModelSelectionPicker, {
      attachTo: document.body,
      props: {
        open: true,
        title: "选择模型",
        models: MODELS,
        selectedNames: ["glm-5-turbo"],
      },
    });
    await flushPromises();

    const rowName = row("glm-5.3")?.querySelector<HTMLElement>(".model-picker-name");
    rowName?.click();
    await flushPromises();
    expect(checkbox("glm-5.3").checked).toBe(true);

    checkbox("glm-5.3").click();
    await flushPromises();
    expect(checkbox("glm-5.3").checked).toBe(false);
    expect(document.body.style.overflow).toBe("hidden");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flushPromises();
    expect(wrapper.emitted("cancel")).toHaveLength(1);
    expect(wrapper.emitted("apply")).toBeUndefined();

    await wrapper.setProps({ open: false });
    await flushPromises();
    expect(document.body.style.overflow).toBe("");
  });
});
