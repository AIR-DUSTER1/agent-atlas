/**
 * approval-flow.test.ts — 审批卡必须出现在对应工具卡之前
 * ============================================================
 * 回归：tool_call 先创建工具卡，interrupt 到达后若只 append 审批卡，
 * 用户会先看到“运行中/已完成”的工具卡，再看到审批按钮。审批 part 必须
 * 插到对应 tool part 前，并且 pending 状态要立即有可操作按钮。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { blockBodies, partEls, state } from "../../src/client/core/state.js";
import type { AssistantBlock, InterruptPayload } from "../../src/client/modules/types.js";

beforeEach(() => {
  document.body.innerHTML = '<div id="chat-scroll"></div>';
  blockBodies.clear();
  partEls.clear();
  state.currentId = "approval-session";
  state.blocks = {};
  state.usage = {};
  state.sessions = [];
});

describe("审批卡顺序", () => {
  it("interrupt 到达后审批卡位于工具卡之前且立即显示操作按钮", async () => {
    const { handleEvent } = await import("../../src/client/stream/events.js");
    const block = { t: "assistant", parts: [] } as AssistantBlock;
    const body = document.createElement("div");
    body.className = "assistant-body";
    document.body.appendChild(body);
    blockBodies.set(block, body);
    state.blocks["approval-session"] = [block];

    handleEvent({ type: "tool_call", id: "tool-approval", name: "terminal", argsFragment: "{}" }, block, "approval-session");
    const payload: InterruptPayload = {
      type: "approval",
      toolName: "terminal",
      description: "执行测试命令",
      args: { command: "echo test" },
    };
    handleEvent({ type: "interrupt", payload }, block, "approval-session");

    await vi.waitFor(() => expect(body.querySelector(".approval-card")).not.toBeNull());
    const approval = body.querySelector(".approval-card");
    const tool = body.querySelector(".tool-card");
    expect(approval).not.toBeNull();
    expect(tool).not.toBeNull();
    expect(approval!.compareDocumentPosition(tool!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(approval!.querySelectorAll(".approval-actions button")).toHaveLength(2);
    expect(block.parts.map((part) => part.p)).toEqual(["approval", "tool"]);
  }, 15_000);

  it("服务端 pending 恢复时必须展开审批操作区，不能继承已处理态的折叠", async () => {
    const { markLatestInterruptPending } = await import("../../src/client/views/app/sessions.js");
    const approval = { p: "approval" as const, req: { type: "approval" as const, toolName: "terminal", description: "测试", args: {} }, status: "approved" as const, collapsed: true };
    state.blocks["approval-session"] = [{ t: "assistant", parts: [approval] } as AssistantBlock];
    expect(markLatestInterruptPending("approval-session")).toBe(true);
    expect(approval.status).toBe("pending");
    expect(approval.collapsed).toBe(false);
  });

  it("读取旧本地缓存时会把审批 part 迁移到工具卡之前", async () => {
    const { normalizeApprovalOrder } = await import("../../src/client/modules/chat-flow.js");
    const tool = { p: "tool" as const, id: "old-tool", name: "terminal", argsText: "{}", result: null };
    const approval = { p: "approval" as const, req: { type: "approval" as const, toolName: "terminal", description: "测试", args: {} }, status: "pending" as const, collapsed: true };
    const block = { t: "assistant" as const, parts: [tool, approval] } as AssistantBlock;
    expect(normalizeApprovalOrder(block)).toBe(true);
    expect(block.parts.map((part) => part.p)).toEqual(["approval", "tool"]);
    expect(approval.collapsed).toBe(false);
  });

  it("同名工具连续出现时审批绑定等待中的最后一张卡而不是第一张完成卡", async () => {
    const { normalizeApprovalOrder } = await import("../../src/client/modules/chat-flow.js");
    const firstDone = { p: "tool" as const, id: "t1", name: "terminal", argsText: "{}", result: { content: "ok", isError: false } };
    const secondDone = { p: "tool" as const, id: "t2", name: "terminal", argsText: "{}", result: { content: "ok", isError: false } };
    const waiting = { p: "tool" as const, id: "t3", name: "terminal", argsText: "{}", result: null, awaitingApproval: true };
    const approval = { p: "approval" as const, req: { type: "approval" as const, toolName: "terminal", description: "测试", args: {} }, status: "pending" as const };
    const block = { t: "assistant" as const, parts: [approval, firstDone, secondDone, waiting] } as AssistantBlock;
    expect(normalizeApprovalOrder(block)).toBe(true);
    expect(block.parts.indexOf(firstDone)).toBeLessThan(block.parts.indexOf(approval));
    expect(block.parts.indexOf(secondDone)).toBeLessThan(block.parts.indexOf(approval));
    expect(block.parts.indexOf(approval)).toBe(block.parts.indexOf(waiting) - 1);
  });
});
