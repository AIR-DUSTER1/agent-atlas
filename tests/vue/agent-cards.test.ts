/**
 * agent-cards.test.ts — 欢迎页 Agent 卡片与示例 chips（M4 批次 4.5）
 * 覆盖：卡片 DOM 契约（.demo-card / .d-head / .d-num / .d-name / .d-default /
 * .d-desc / .d-eg）、默认徽标、插件停用即隐藏找房/求职入口、内置 demos 追加、
 * 点击只经 window 命令面请求建会话、示例 chips 文本与预填参数。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import AgentCardsVue from "../../src/client/views/agent-cards-vue.vue";
import ExampleChipsVue from "../../src/client/views/example-chips-vue.vue";
import { state } from "../../src/client/core/state.js";

let pinia: Pinia;

beforeEach(() => {
  document.body.innerHTML = "";
  pinia = createPinia();
  setActivePinia(pinia);
  state.plugins = { enabled: { rag: true, estate: true, job: true, browser: false, computer: false }, platform: "win32" } as never;
  state.config = { demos: [{ id: 1, name: "演示一", desc: "对话记忆", example: "记住我叫小明" }] } as never;
  window.__agentatlasShellCommands = {};
  window.__agentatlasShellListeners = new Set();
});

async function mountCards(): Promise<void> {
  mount(AgentCardsVue, { attachTo: document.body, global: { plugins: [pinia] } });
  await flushPromises();
}

describe("Agent 卡片", () => {
  it("渲染通用 Agent（带默认徽标）+ 找房 + 求职 + 内置示例", async () => {
    await mountCards();
    const cards = [...document.querySelectorAll(".demo-card")];
    expect(cards).toHaveLength(4);
    expect(cards[0]?.querySelector(".d-name")?.textContent).toContain("通用");
    expect(cards[0]?.querySelector(".d-default")?.textContent).toBe("默认");
    expect(cards[0]?.querySelector(".d-eg")?.textContent?.startsWith("示例：")).toBe(true);
    expect(cards[3]?.querySelector(".d-name")?.textContent).toContain("演示一");
  });

  it("插件停用时隐藏找房与求职入口", async () => {
    state.plugins = { enabled: { rag: true, estate: false, job: false, browser: false, computer: false }, platform: "win32" } as never;
    await mountCards();
    const names = [...document.querySelectorAll(".demo-card .d-name")].map((el) => el.textContent ?? "");
    expect(names.some((name) => name.includes("找房"))).toBe(false);
    expect(names.some((name) => name.includes("求职"))).toBe(false);
    expect(names.some((name) => name.includes("通用"))).toBe(true);
  });

  it("点击通用卡片经命令面请求建 agent 会话", async () => {
    const create = vi.fn();
    window.__agentatlasShellCommands = { create };
    await mountCards();
    (document.querySelector(".demo-card") as HTMLElement).dispatchEvent(new Event("click", { bubbles: true }));
    expect(create).toHaveBeenCalledWith("agent", null, null);
  });

  it("点击内置示例卡片带 demo id 与预填文案", async () => {
    const create = vi.fn();
    window.__agentatlasShellCommands = { create };
    await mountCards();
    const demoCard = [...document.querySelectorAll<HTMLElement>(".demo-card")]
      .find((card) => card.textContent?.includes("演示一"));
    demoCard!.dispatchEvent(new Event("click", { bubbles: true }));
    expect(create).toHaveBeenCalledWith("demo", 1, "记住我叫小明");
  });

  it("插件启停后经监听器重建卡片", async () => {
    await mountCards();
    expect(document.querySelectorAll(".demo-card")).toHaveLength(4);
    state.plugins = { enabled: { rag: true, estate: false, job: false, browser: false, computer: false }, platform: "win32" } as never;
    for (const listener of window.__agentatlasShellListeners ?? []) listener();
    await flushPromises();
    expect(document.querySelectorAll(".demo-card")).toHaveLength(2); // 通用 + 内置示例
  });
});

describe("示例 chips", () => {
  it("渲染四个通用示例并以通用 Agent 预填创建", async () => {
    const create = vi.fn();
    window.__agentatlasShellCommands = { create };
    mount(ExampleChipsVue, { attachTo: document.body, global: { plugins: [pinia] } });
    await flushPromises();
    const chips = [...document.querySelectorAll<HTMLElement>(".ex-chip")];
    expect(chips).toHaveLength(4);
    expect(chips[0]?.textContent).toContain("(128+512)*3");
    chips[0]!.dispatchEvent(new Event("click", { bubbles: true }));
    expect(create).toHaveBeenCalledWith("agent", null, chips[0]!.textContent);
  });
});
