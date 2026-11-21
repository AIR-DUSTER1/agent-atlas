/**
 * browser-dock.test.ts — Browser Use 右侧画面 Vue 组件（M4 批次 4.4）
 * 覆盖：隐藏/可见切换（#browser-dock.hidden）、标题/URL/状态胶囊文案与色调、
 * 截图地址与 ready 类、空态文案、关闭按钮只发命令面意图、快照重复推送幂等。
 * 数据全部经 window 快照通道注入（bundle 与 1:1 副本是两个 pinia 实例）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import BrowserDockVue from "../../src/client/views/browser-dock-vue.vue";
import type { BrowserDockSnapshot } from "../../src/client/stores/browser-dock.js";

let pinia: Pinia;

function snapshot(overrides: Partial<BrowserDockSnapshot> = {}): BrowserDockSnapshot {
  return {
    sessionId: "sess-1",
    visible: true,
    title: "示例页面",
    url: "https://example.com/",
    stateText: "实时连接",
    stateTone: "live",
    meta: "更新于 10:00:00 · 会话隔离",
    screenshotSrc: "/api/browser/sessions/sess-1/screenshot?v=1",
    emptyVisible: false,
    emptyTitle: "等待 Agent 打开网页",
    emptyDetail: "浏览器画面会在这里实时更新",
    ...overrides,
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
  pinia = createPinia();
  setActivePinia(pinia);
  window.__agentatlasBrowserDock = null;
  window.__agentatlasBrowserDockListeners = new Set();
  window.__agentatlasBrowserDockCommands = {};
});

function mountPanel(): void {
  mount(BrowserDockVue, { attachTo: document.body, global: { plugins: [pinia] } });
}

/** onMounted 里的 store.apply 触发的是异步重渲染，断言前必须等一拍。 */
async function mountAndSettle(): Promise<void> {
  mountPanel();
  await flushPromises();
}

describe("Browser Use 画面", () => {
  it("无快照时默认隐藏", () => {
    mountPanel();
    expect(document.getElementById("browser-dock")?.classList.contains("hidden")).toBe(true);
    expect(document.getElementById("browser-dock-title")?.textContent).toBe("等待网页");
    expect(document.getElementById("browser-dock-url")?.textContent).toBe("about:blank");
  });

  it("挂载时读取已有快照（组件晚于轮询启动挂载）", async () => {
    window.__agentatlasBrowserDock = snapshot();
    await mountAndSettle();
    expect(document.getElementById("browser-dock")?.classList.contains("hidden")).toBe(false);
    expect(document.getElementById("browser-dock-title")?.textContent).toBe("示例页面");
    expect(document.getElementById("browser-dock-url")?.textContent).toBe("https://example.com/");
    expect(document.getElementById("browser-dock-state")?.textContent).toBe("实时连接");
    expect(document.getElementById("browser-dock-state")?.className).toContain("live");
  });

  it("快照推送后即时更新文案与截图地址", async () => {
    mountPanel();
    window.__agentatlasBrowserDock = snapshot({ title: "新页面", url: "https://example.com/next", stateTone: "busy", stateText: "AI 操作中" });
    for (const listener of window.__agentatlasBrowserDockListeners ?? []) listener();
    await flushPromises();
    expect(document.getElementById("browser-dock-title")?.textContent).toBe("新页面");
    expect(document.getElementById("browser-dock-url")?.textContent).toBe("https://example.com/next");
    expect(document.getElementById("browser-dock-state")?.textContent).toBe("AI 操作中");
    expect(document.getElementById("browser-dock-state")?.className).toContain("busy");
    expect(document.getElementById("browser-dock-screen")?.getAttribute("src")).toContain("/screenshot?v=1");
  });

  it("visible=false 时收起并带 hidden 类", async () => {
    window.__agentatlasBrowserDock = snapshot();
    mountPanel();
    window.__agentatlasBrowserDock = snapshot({ visible: false });
    for (const listener of window.__agentatlasBrowserDockListeners ?? []) listener();
    await flushPromises();
    expect(document.getElementById("browser-dock")?.classList.contains("hidden")).toBe(true);
  });

  it("页面异常时空态可见并显示错误原因", async () => {
    window.__agentatlasBrowserDock = snapshot({
      stateText: "页面异常",
      stateTone: "",
      emptyVisible: true,
      emptyTitle: "浏览器已被关闭",
      emptyDetail: "请让 Agent 重新打开或刷新页面",
    });
    await mountAndSettle();
    const empty = document.getElementById("browser-dock-empty") as HTMLElement;
    expect(empty.style.visibility).toBe("visible");
    expect(empty.querySelector("strong")?.textContent).toBe("浏览器已被关闭");
    expect(empty.querySelector("span")?.textContent).toBe("请让 Agent 重新打开或刷新页面");
  });

  it("关闭按钮只调用命令面，不直接发请求", () => {
    const close = vi.fn();
    window.__agentatlasBrowserDockCommands = { close };
    window.__agentatlasBrowserDock = snapshot();
    mountPanel();
    document.getElementById("browser-dock-close")!.dispatchEvent(new Event("click", { bubbles: true }));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("截图 load 成功后加上 ready 类（CSS 靠它显示画面）", async () => {
    window.__agentatlasBrowserDock = snapshot();
    mountPanel();
    const screen = document.getElementById("browser-dock-screen")!;
    expect(screen.classList.contains("ready")).toBe(false);
    screen.dispatchEvent(new Event("load"));
    await flushPromises();
    expect(screen.classList.contains("ready")).toBe(true);
  });
});
