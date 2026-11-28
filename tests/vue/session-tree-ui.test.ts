/**
 * session-tree-ui.test.ts — 侧栏会话树 Vue 组件（M4 批次 4.5）
 * 覆盖：分组头 DOM 契约（.proj-group-head / role / aria-expanded / 类型标签）、
 * 时间分隔行、会话项（.active / .stale / .s-running / .s-pending）、
 * 搜索强制展开、折叠状态下不渲染子项、空态文案、命令面只发意图。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import SessionTreeVue from "../../src/client/views/app/session-tree-vue.vue";
import { useSessionsStore } from "../../src/client/stores/app/sessions.js";
import { state } from "../../src/client/core/state.js";
import type { ProjectEntry, Session } from "../../src/client/modules/types.js";

const NOW = Date.now();

function session(id: string, title: string, projectId: string, createdAt = NOW): Session {
  return {
    id, title, projectId, createdAt,
    kind: "demo", demo: 1, turns: 1,
  } as unknown as Session;
}

const PROJECTS = [
  { id: "p1", name: "项目一", type: "local", path: "/tmp/p1" },
  { id: "p2", name: "云端二", type: "cloud", url: "https://example.invalid/r.git" },
] as unknown as ProjectEntry[];

let pinia: Pinia;

beforeEach(() => {
  // 真实页面里组件挂在 <nav id="session-list"> 内；测试必须复刻这一容器，
  // 否则 document.querySelector("#session-list …") 全部落空。
  document.body.innerHTML = '<input id="session-search" /><nav id="session-list"></nav>';
  pinia = createPinia();
  setActivePinia(pinia);
  state.projects = PROJECTS;
  state.projectView = "all";
  state.projCollapsed = [];
  state.currentId = null;
  state.streams = {};
  state.blocks = {};
  state.sessions = [
    session("s1", "会话甲", "p1", NOW),
    session("s2", "会话乙", "p1", NOW - 86_400_000),
    session("s3", "孤立会话", "missing-project", NOW),
  ];
  window.__agentatlasSessionCommands = {};
  window.__agentatlasSessionListeners = new Set();
});

async function mountPanel(): Promise<void> {
  const target = document.getElementById("session-list")!;
  mount(SessionTreeVue, { attachTo: target, global: { plugins: [pinia] } });
  await flushPromises();
}

describe("会话树", () => {
  it("按项目分组渲染，未归属会话进独立组且标「无项目」", async () => {
    await mountPanel();
    // 空分组（云端二）不渲染；有会话的：项目一 + 未归属组
    const heads = [...document.querySelectorAll("#session-list .proj-group-head")];
    expect(heads).toHaveLength(2);
    expect(heads[0]?.querySelector(".g-name")?.textContent).toBe("项目一");
    expect(heads[0]?.querySelector(".p-type-tag")?.textContent).toBe("本地");
    expect(heads[1]?.querySelector(".g-name")?.textContent).toBe("未归属");
    // 孤儿组恒用 ORPHAN_GROUP_KEY，类型标签是「无项目」
    expect(heads[1]?.querySelector(".p-type-tag")?.textContent).toBe("无项目");
  });

  it("有会话的云端项目分组带 cloud 类与「云端」标签", async () => {
    state.sessions = [...state.sessions, session("s4", "云端会话", "p2", NOW)];
    await mountPanel();
    await flushPromises();
    const cloudHead = [...document.querySelectorAll("#session-list .proj-group-head")]
      .find((head) => head.querySelector(".g-name")?.textContent === "云端二") as HTMLElement;
    expect(cloudHead.classList.contains("cloud")).toBe(true);
    expect(cloudHead.querySelector(".p-type-tag")?.textContent).toBe("云端");
  });

  it("分组头有 role=button 与 aria-expanded，可键盘折叠", async () => {
    const toggleGroup = vi.fn();
    window.__agentatlasSessionCommands = { toggleGroup };
    await mountPanel();
    const head = document.querySelector("#session-list .proj-group-head") as HTMLElement;
    expect(head.getAttribute("role")).toBe("button");
    expect(head.getAttribute("aria-expanded")).toBe("true");
    expect(head.getAttribute("aria-label")).toBe("项目一，2 个会话，已展开");
    head.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(toggleGroup).toHaveBeenCalledWith("p1");
  });

  it("折叠的分组不渲染会话子项（不是靠 CSS 隐藏）", async () => {
    state.projCollapsed = ["p1"];
    await mountPanel();
    await flushPromises();
    const head = document.querySelector("#session-list .proj-group-head") as HTMLElement;
    expect(head.classList.contains("collapsed")).toBe(true);
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelectorAll("#session-list .session-item").length).toBe(1); // 只剩孤立会话
  });

  it("渲染时间分隔行：今天 / 昨天", async () => {
    await mountPanel();
    const days = [...document.querySelectorAll("#session-list .session-time-head")].map((el) => el.textContent);
    expect(days).toContain("今天");
    expect(days).toContain("昨天");
  });

  it("会话项带上标签、时间与操作按钮，active 跟随 core state", async () => {
    state.currentId = "s1";
    state.streams = { s2: {} as never };
    state.sessions[1]!.pendingApproval = true;
    await mountPanel();
    const items = [...document.querySelectorAll("#session-list .session-item")];
    const first = items.find((el) => el.textContent?.includes("会话甲")) as HTMLElement;
    expect(first.classList.contains("active")).toBe(true);
    expect(first.querySelector(".s-demo")?.textContent).toBe("示例 1");
    expect(first.querySelector(".s-export")?.getAttribute("aria-label")).toBe("导出当前会话为 Markdown");
    expect(first.querySelector(".s-del")?.getAttribute("aria-label")).toBe("删除当前会话");
    const second = items.find((el) => el.textContent?.includes("会话乙")) as HTMLElement;
    expect(second.querySelector(".s-running")).not.toBeNull();
    expect(second.querySelector(".s-pending")).not.toBeNull();
  });

  it("页面刷新后本地无流：服务端 running=true 也要显示「生成中」", async () => {
    // 真实场景：生成中刷新页面 → state.streams 清空，只有 /api/sessions 的
    // running 字段还在。侧栏必须靠它还原标记，否则看起来像没人跑。
    state.streams = {};
    state.sessions[0]!.running = true;
    await mountPanel();
    const item = [...document.querySelectorAll("#session-list .session-item")]
      .find((el) => el.textContent?.includes("会话甲")) as HTMLElement;
    expect(item.querySelector(".s-running")).not.toBeNull();
    state.sessions[0]!.running = false;
  });

  it("搜索时分组头不可折叠（static）并强制展开", async () => {
    state.projCollapsed = ["p1"];
    await mountPanel();
    const store = useSessionsStore();
    store.setTerm("会话甲");
    await flushPromises();
    const head = document.querySelector("#session-list .proj-group-head") as HTMLElement;
    expect(head.classList.contains("static")).toBe(true);
    expect(head.classList.contains("collapsed")).toBe(false);
    expect(head.hasAttribute("role")).toBe(false);
    expect(document.querySelectorAll("#session-list .session-item").length).toBe(1);
  });

  it("无命中时给出搜索空态文案", async () => {
    await mountPanel();
    useSessionsStore().setTerm("不存在的关键词");
    await flushPromises();
    expect(document.querySelector("#session-list .fs-empty")?.textContent).toBe("没有命中搜索的会话");
  });

  it("侧栏搜索框输入即过滤，且组件独占该 input 监听", async () => {
    await mountPanel();
    const input = document.getElementById("session-search") as HTMLInputElement;
    input.value = "会话乙";
    input.dispatchEvent(new Event("input"));
    await flushPromises();
    expect(document.querySelectorAll("#session-list .session-item").length).toBe(1);
    expect(document.querySelector("#session-list .session-item")?.textContent).toContain("会话乙");
  });

  it("点击导出/删除只调用命令面", async () => {
    const exportSession = vi.fn();
    const removeSession = vi.fn();
    window.__agentatlasSessionCommands = { exportSession, removeSession };
    await mountPanel();
    const first = document.querySelector("#session-list .session-item") as HTMLElement;
    (first.querySelector(".s-export") as HTMLElement).dispatchEvent(new Event("click", { bubbles: true }));
    (first.querySelector(".s-del") as HTMLElement).dispatchEvent(new Event("click", { bubbles: true }));
    expect(exportSession).toHaveBeenCalledTimes(1);
    expect(removeSession).toHaveBeenCalledTimes(1);
    // 会话项本身的 click 不应被触发（事件已 stopPropagation）
    expect(window.__agentatlasSessionCommands?.select).toBeUndefined();
  });
});
