/**
 * stream-cursor.test.ts — 工具边界不应留下流式光标
 * ============================================================
 * 回归用户截图中的空竖线：思考/正文分片后立刻进入工具卡时，旧的
 * streaming text part 必须立即封口，不能把 `.cursor` 留在工具卡前面。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { blockBodies, partEls, state } from "../../src/client/core/state.js";
import type { AssistantBlock } from "../../src/client/modules/types.js";

beforeEach(() => {
  document.body.innerHTML = '<div id="chat-scroll"></div>';
  blockBodies.clear();
  partEls.clear();
  state.currentId = "cursor-session";
  state.blocks = {};
  state.usage = {};
});

describe("工具边界的光标清理", () => {
  it("正文刚流式输出就出现工具卡时不残留光标", async () => {
    const { handleEvent } = await import("../../src/client/stream/events.js");
    const block = { t: "assistant", parts: [] } as AssistantBlock;
    const body = document.createElement("div");
    body.className = "assistant-body";
    document.body.appendChild(body);
    blockBodies.set(block, body);
    state.blocks["cursor-session"] = [block];

    handleEvent({ type: "reasoning", text: "判断环境", node: "agent" }, block, "cursor-session");
    handleEvent({ type: "token", text: "Windows", node: "agent" }, block, "cursor-session");
    handleEvent({ type: "tool_call", id: "tool-1", name: "terminal", argsFragment: "{}" }, block, "cursor-session");
    await vi.waitFor(() => {
      expect(body.querySelectorAll(".cursor")).toHaveLength(0);
      expect(body.querySelector(".tool-card")).not.toBeNull();
    });
  }, 15_000);

  it("空 token 不创建空正文，非文本 part 会清理孤立光标", async () => {
    const { handleEvent } = await import("../../src/client/stream/events.js");
    const { mountPart } = await import("../../src/client/render/parts.js");
    const block = { t: "assistant", parts: [] } as AssistantBlock;
    const body = document.createElement("div");
    body.className = "assistant-body";
    document.body.appendChild(body);
    blockBodies.set(block, body);
    state.blocks["cursor-session"] = [block];

    handleEvent({ type: "token", text: "", node: "agent" }, block, "cursor-session");
    expect(body.querySelector(".md")).toBeNull();

    handleEvent({ type: "token", text: "Windows", node: "agent" }, block, "cursor-session");
    await vi.waitFor(() => expect(body.querySelector(".cursor")).not.toBeNull());
    expect(body.querySelector(".md")?.textContent).toContain("Windows");
    expect(body.querySelector(".md .cursor")).not.toBeNull();
    mountPart(block, { p: "node", name: "tools" });
    expect(body.querySelector(".cursor")).toBeNull();
  }, 15_000);
});
