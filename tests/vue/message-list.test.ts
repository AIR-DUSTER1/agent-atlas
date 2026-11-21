/**
 * message-list.test.ts — 消息流块骨架 Vue 组件（M4 批次 4.6）
 * 覆盖：四类块 DOM 契约（.msg-user / .notice-block / .error-block /
 * .msg-assistant 与各自内部结构）、footer 用量小字与「复制总结」显隐、
 * 复制反馈（图标切换 + 1.8s 后复原）、空内容提示、块容器注册表
 * （parts.ts 靠它拿 .assistant-body）、以及 store 原地复用块对象
 * （避免 Vue 重建 vnode 导致命令式节点失配）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import MessageListView from "../../src/client/views/message-list-vue.vue";
import { useMessagesStore, usageCaptionOf, type MessageBlockView } from "../../src/client/stores/messages.js";
import { state } from "../../src/client/core/state.js";
import type { AssistantBlock, ChatBlock } from "../../src/client/modules/types.js";

let pinia: Pinia;

beforeEach(() => {
  document.body.innerHTML = '<div id="messages"></div><div id="empty-session" class="hidden"></div>';
  pinia = createPinia();
  setActivePinia(pinia);
  state.currentId = "s1";
  state.blocks = {};
  window.__agentatlasBlockBodyRegistry = undefined;
  window.__agentatlasMessageListeners = new Set();
});

/** 直接写入块视图（测试替身：真实路径是 store.refresh 从 core state 编译）。 */
function setBlocks(views: MessageBlockView[]): void {
  // 必须走 $patch（或其他官方变更通道）：直接给 store.blocks 赋值在
  // pinia setup-store 语义下不会通知模板重新求值，测试会看到空列表。
  useMessagesStore().$patch({ blocks: views, revision: useMessagesStore().revision + 1 });
}

/** 挂载组件后再写入块视图（onMounted 会先按 core state 刷新一次，顺序不能反）。 */
async function mountWith(views: MessageBlockView[]): Promise<void> {
  const target = document.getElementById("messages")!;
  mount(MessageListView, { attachTo: target, global: { plugins: [pinia] } });
  await flushPromises();
  setBlocks(views);
  await flushPromises();
  await flushPromises();
}

async function mountList(): Promise<void> {
  const target = document.getElementById("messages")!;
  mount(MessageListView, { attachTo: target, global: { plugins: [pinia] } });
  await flushPromises();
  await flushPromises();
}

describe("消息流块骨架", () => {
  it("用户消息渲染气泡、附件 chips 与复制按钮", async () => {
    await mountWith([{
      key: "user-0", t: "user", text: "你好",
      files: [{ name: "a.md", source: "项目文件" }, { name: "b.png", source: "本地上传", image: true }],
    }]);
    const wrap = document.querySelector("#messages .msg-user")!;
    expect(wrap.querySelector(".bubble")?.textContent).toContain("你好");
    expect(wrap.querySelectorAll(".f-chip")).toHaveLength(2);
    expect(wrap.querySelector(".f-chip .fname")?.textContent).toBe("a.md");
    expect(wrap.querySelector(".f-chip .fsrc")?.textContent).toBe("项目文件");
    // 图片附件用 Image 图标，普通文件用 Paperclip
    expect(wrap.querySelectorAll(".f-chip .ui-icon")[0]?.getAttribute("data-icon")).toBe("Paperclip");
    expect(wrap.querySelectorAll(".f-chip .ui-icon")[1]?.getAttribute("data-icon")).toBe("Image");
    expect(wrap.querySelector(".user-message-footer .message-action")).not.toBeNull();
  });

  it("提示块渲染标题/正文/摘要折叠区", async () => {
    await mountWith([{
      key: "notice-1", t: "notice",
      noticeTitle: "上下文已压缩", noticeText: "已省略 12 轮", summary: "摘要正文", loading: true,
    }]);
    const wrap = document.querySelector("#messages .notice-block")!;
    expect(wrap.classList.contains("loading")).toBe(true);
    expect(wrap.querySelector(".notice-title")?.textContent).toBe("上下文已压缩");
    expect(wrap.querySelector(".notice-text")?.textContent).toBe("已省略 12 轮");
    expect(wrap.querySelector(".notice-details summary")?.textContent).toBe("查看压缩摘要");
    expect(wrap.querySelector(".notice-details pre")?.textContent).toBe("摘要正文");
  });

  it("错误块用警示图标 + 文案", async () => {
    await mountWith([{ key: "error-2", t: "error", text: "请求失败：503" }]);
    const wrap = document.querySelector("#messages .error-block")!;
    expect(wrap.querySelector(".ui-icon")?.getAttribute("data-icon")).toBe("TriangleAlert");
    expect(wrap.textContent).toContain("请求失败：503");
  });

  it("助手块渲染头像、body、footer 与用量小字", async () => {
    await mountWith([{
      key: "assistant-3", t: "assistant",
      usageCaption: usageCaptionOf({ lastInput: 1200, lastOutput: 300, lastCache: 300 }),
      copyVisible: true,
    }]);
    const wrap = document.querySelector("#messages .msg-assistant")!;
    expect(wrap.querySelector(".avatar [data-icon]")?.getAttribute("data-icon")).toBe("Zap");
    expect(wrap.querySelector(".assistant-body")).not.toBeNull();
    expect(wrap.querySelector(".usage-caption")?.textContent).toBe("↑ 1,200 · ↓ 300 · 缓存 25%");
    // 有总结时复制按钮可见、footer 不是 is-empty
    expect(wrap.querySelector(".assistant-actions")?.classList.contains("hidden")).toBe(false);
    expect(wrap.querySelector(".assistant-footer")?.classList.contains("is-empty")).toBe(false);
  });

  it("空回合：footer 为 is-empty 且复制按钮隐藏", async () => {
    await mountWith([{ key: "assistant-0", t: "assistant", usageCaption: "", copyVisible: false }]);
    const wrap = document.querySelector("#messages .msg-assistant")!;
    expect(wrap.querySelector(".assistant-footer")?.classList.contains("is-empty")).toBe(true);
    expect(wrap.querySelector(".assistant-actions")?.classList.contains("hidden")).toBe(true);
    expect(wrap.querySelector(".usage-caption")).toBeNull();
  });

  it("用量小字格式化：无缓存时不显示缓存段", () => {
    expect(usageCaptionOf({ lastInput: 385, lastOutput: 418, lastCache: 0 })).toBe("↑ 385 · ↓ 418");
    expect(usageCaptionOf({ lastInput: 1000, lastOutput: 1, lastCache: 500 })).toBe("↑ 1,000 · ↓ 1 · 缓存 50%");
  });

  it("渲染后把容器写进注册表（parts.ts 靠它拿 .assistant-body）", async () => {
    await mountWith([{ key: "assistant-0", t: "assistant" }]);
    await flushPromises();
    const registry = window.__agentatlasBlockBodyRegistry;
    expect(registry?.wrap?.("assistant-0")).toBeInstanceOf(HTMLElement);
    expect(registry?.body?.("assistant-0")).toBeInstanceOf(HTMLElement);
    expect(registry?.body?.("assistant-0")?.className).toBe("assistant-body");
    // 不存在的 key 返回 null，调用方据此跳过
    expect(registry?.body?.("missing")).toBeNull();
  });

  it("复制成功后按钮就地反馈「已复制」并在 1.8s 后复原", async () => {
    await mountWith([{ key: "user-0", t: "user", text: "hello" }]);
    const button = document.querySelector("#messages .message-action") as HTMLButtonElement;
    button.dispatchEvent(new Event("click", { bubbles: true }));
    await vi.waitFor(() => {
      expect(button.classList.contains("copied")).toBe(true);
    });
    // 就地反馈：图标切勾、title/aria-label 同步（不额外弹 toast）
    expect(button.querySelector("[data-icon]")?.getAttribute("data-icon")).toBe("Check");
    expect(button.getAttribute("aria-label")).toBe("已复制");
    expect(document.getElementById("ui-toast-region")?.textContent ?? "").toBe("");
    // 1.8s 后复原为可再次复制
    await vi.waitFor(() => {
      expect(button.classList.contains("copied")).toBe(false);
    }, { timeout: 3_000 });
    expect(button.getAttribute("aria-label")).toBe("复制");
  });

  it("复制空内容时给出针对性提示", async () => {
    await mountWith([{ key: "assistant-0", t: "assistant" }]);
    const button = document.querySelector("#messages .assistant-actions .message-action") as HTMLButtonElement;
    button.dispatchEvent(new Event("click", { bubbles: true }));
    await vi.waitFor(() => {
      expect(document.querySelector("#ui-toast-region")?.textContent ?? "").toContain("还没有可复制的总结");
    });
  });

  it("store.refresh 原地复用块对象（避免 Vue 重建 vnode 打乱命令式内容）", () => {
    state.currentId = "s1";
    state.blocks = {
      s1: [
        { t: "user", text: "hi" } as ChatBlock,
        { t: "assistant", parts: [] } as unknown as AssistantBlock,
      ],
    } as never;
    const store = useMessagesStore();
    store.refresh();
    const first = store.blocks;
    const firstObjects = [...first];
    store.refresh();
    // 对象身份必须保持：块内的 .assistant-body 里塞着 parts.ts 挂的节点
    expect(store.blocks[0]).toBe(firstObjects[0]);
    expect(store.blocks[1]).toBe(firstObjects[1]);
  });
});
