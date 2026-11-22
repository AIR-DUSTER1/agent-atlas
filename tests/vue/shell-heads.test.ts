/**
 * shell-heads.test.ts — 顶栏会话头 / 欢迎页标题 / 权限 chip（M4 批次 4.5）
 * 覆盖：会话标题与面包屑（项目名 / 未归属）、示例徽标（demo / external /
 * agent profile）、欢迎态（默认 / 无项目 Agent 选择页）、插件开关影响副标题、
 * 权限 chip 文案与可用性判定（共享 session-kind 谓词，求职会话必须有入口）。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import TopbarVue from "../../src/client/views/app/topbar-vue.vue";
import WelcomeHeadVue from "../../src/client/views/welcome/welcome-head-vue.vue";
import PermChipVue from "../../src/client/views/app/perm-chip-vue.vue";
import { state } from "../../src/client/core/state.js";
import type { ProjectEntry, Session } from "../../src/client/modules/types.js";

let pinia: Pinia;

const PROJECTS = [
  { id: "p1", name: "项目一", type: "local", path: "/tmp/p1" },
] as unknown as ProjectEntry[];

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "s1", title: "会话甲", projectId: "p1", createdAt: Date.now(),
    kind: "demo", demo: 1, turns: 1, permissionMode: "approve",
    ...overrides,
  } as unknown as Session;
}

beforeEach(() => {
  document.body.innerHTML = '<div id="perm-chip-mount"></div>';
  pinia = createPinia();
  setActivePinia(pinia);
  state.projects = PROJECTS;
  state.projectView = "all";
  state.currentId = null;
  state.externalAgents = [];
  state.plugins = { enabled: { rag: true, estate: true, job: true, browser: false, computer: false }, platform: "win32" } as never;
  window.__agentatlasTopbarListeners = new Set();
});

describe("顶栏会话头", () => {
  it("会话态显示标题、项目面包屑与示例徽标", async () => {
    mount(TopbarVue, { attachTo: document.body, global: { plugins: [pinia] } });
    await flushPromises();
    const topbar = await import("../../src/client/stores/topbar.js").then((m) => m.useTopbarStore());
    topbar.applySession(makeSession());
    await flushPromises();
    expect(document.getElementById("session-title")?.textContent).toBe("会话甲");
    expect(document.getElementById("breadcrumb-project")?.textContent).toBe("项目一");
    const badge = document.getElementById("demo-badge")!;
    expect(badge.textContent).toContain("示例 1");
    expect(badge.classList.contains("hidden")).toBe(false);
  });

  it("未归属项目的会话面包屑显示「未归属项目」", async () => {
    mount(TopbarVue, { attachTo: document.body, global: { plugins: [pinia] } });
    const topbar = (await import("../../src/client/stores/topbar.js")).useTopbarStore();
    topbar.applySession(makeSession({ projectId: "missing" }));
    await flushPromises();
    expect(document.getElementById("breadcrumb-project")?.textContent).toBe("未归属项目");
  });

  it("外部 Agent 会话徽标显示「外部 · 名称」", async () => {
    state.externalAgents = [{ id: "ext-1", name: "外部助手" }] as never;
    mount(TopbarVue, { attachTo: document.body, global: { plugins: [pinia] } });
    const topbar = (await import("../../src/client/stores/topbar.js")).useTopbarStore();
    topbar.applySession(makeSession({ kind: "external", agentId: "ext-1" }));
    await flushPromises();
    expect(document.getElementById("demo-badge")?.textContent).toContain("外部助手");
  });
});

describe("欢迎页标题区", () => {
  it("默认欢迎态显示产品名与副标题", async () => {
    mount(WelcomeHeadVue, { attachTo: document.body, global: { plugins: [pinia] }, props: { section: "hero" } });
    const topbar = (await import("../../src/client/stores/topbar.js")).useTopbarStore();
    topbar.applyWelcome("default");
    await flushPromises();
    expect(document.getElementById("welcome-title")?.textContent).toBe("agentatlas");
    expect(document.getElementById("welcome-subtitle")?.textContent).toContain("可扩展的 Agent 工具集");
    expect(document.getElementById("welcome-examples-label")?.classList.contains("hidden")).toBe(false);
  });

  it("无项目 Agent 选择页：标题切换、示例标签隐藏、副标题含项目提示", async () => {
    mount(WelcomeHeadVue, { attachTo: document.body, global: { plugins: [pinia] }, props: { section: "hero" } });
    const topbar = (await import("../../src/client/stores/topbar.js")).useTopbarStore();
    topbar.applyWelcome("agent-picker");
    await flushPromises();
    expect(document.getElementById("welcome-title")?.textContent).toBe("选择一个 Agent 开始新会话");
    expect(document.getElementById("welcome-subtitle")?.textContent).toContain("当前还没有添加项目");
    expect(document.getElementById("welcome-examples-label")?.classList.contains("hidden")).toBe(true);
  });

  it("cards 段渲染「选择 Agent 或内置示例」标签", async () => {
    mount(WelcomeHeadVue, { attachTo: document.body, global: { plugins: [pinia] }, props: { section: "cards" } });
    await flushPromises();
    expect(document.getElementById("welcome-cards-label")?.textContent).toBe("选择 Agent 或内置示例");
    expect(document.getElementById("welcome-title")).toBeNull();
  });

  it("插件停用后 Agent 选择页副标题不再提找房 Agent", async () => {
    mount(WelcomeHeadVue, { attachTo: document.body, global: { plugins: [pinia] }, props: { section: "hero" } });
    const topbar = (await import("../../src/client/stores/topbar.js")).useTopbarStore();
    topbar.applyWelcome("agent-picker");
    await flushPromises();
    expect(document.getElementById("welcome-subtitle")?.textContent).toContain("通用 Agent 或租房 / 房产 Agent");
    state.plugins = { enabled: { rag: true, estate: false, job: true, browser: false, computer: false }, platform: "win32" } as never;
    topbar.refreshPluginCopy();
    await flushPromises();
    expect(document.getElementById("welcome-subtitle")?.textContent).not.toContain("租房 / 房产");
  });
});

describe("权限 chip", () => {
  it("求职会话（job）必须有权限入口并显示「权限·审批」", async () => {
    mount(PermChipVue, { attachTo: document.body, global: { plugins: [pinia] } });
    const topbar = (await import("../../src/client/stores/topbar.js")).useTopbarStore();
    topbar.applySession(makeSession({ kind: "job", permissionMode: "approve" }));
    await flushPromises();
    expect(document.getElementById("perm-group")?.classList.contains("hidden")).toBe(false);
    expect(document.querySelector("#cm-perm .cm-text")?.textContent).toBe("权限·审批");
    expect(document.getElementById("cm-perm")?.title).toContain("会话权限模式：审批");
  });

  it("demo 会话与历史失效会话没有权限入口", async () => {
    mount(PermChipVue, { attachTo: document.body, global: { plugins: [pinia] } });
    const topbar = (await import("../../src/client/stores/topbar.js")).useTopbarStore();
    topbar.applyWelcome("default");
    await flushPromises();
    expect(document.getElementById("perm-group")?.classList.contains("hidden")).toBe(true);

    topbar.applySession(makeSession({ kind: "agent", stale: true } as never));
    await flushPromises();
    expect(document.getElementById("perm-group")?.classList.contains("hidden")).toBe(true);
  });

  it("模式切换后文案跟随（审批 → 只读）", async () => {
    mount(PermChipVue, { attachTo: document.body, global: { plugins: [pinia] } });
    const topbar = (await import("../../src/client/stores/topbar.js")).useTopbarStore();
    topbar.applySession(makeSession({ kind: "agent", permissionMode: "approve" }));
    await flushPromises();
    expect(document.querySelector("#cm-perm .cm-text")?.textContent).toBe("权限·审批");
    topbar.applySession(makeSession({ kind: "agent", permissionMode: "readonly" }));
    await flushPromises();
    expect(document.querySelector("#cm-perm .cm-text")?.textContent).toBe("权限·只读");
  });
});
