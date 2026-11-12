/**
 * message-copy.test.ts — 消息复制与 AI 总结提取
 * ============================================================
 * 守卫三件事：用户消息有复制入口；助手只复制最后一段完成的正文而不带思考/工具；
 * 消息、摘要和代码块共享同一剪贴板降级实现。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { assistantSummaryText } from "../../src/client/modules/message-copy.js";
import { writeClipboardText } from "../../src/client/modules/clipboard.js";
import { readClientCss, readClientFiles } from "../helpers/client-source.js";
import type { AssistantBlock } from "../../src/client/modules/types.js";

test("AI 复制取最后一段已完成正文，忽略中间过程和工具参数", () => {
  const block = {
    t: "assistant",
    parts: [
      { p: "thinking", node: "agent", text: "内部思考" },
      { p: "text", text: "先查一下房源", streaming: false },
      { p: "tool", id: "1", name: "house_search", argsText: "{\"city\":\"青岛\"}", result: null },
      { p: "text", text: "## 推荐总结\n\n共找到 3 套。", streaming: false },
    ],
  } satisfies AssistantBlock;
  assert.equal(assistantSummaryText(block), "## 推荐总结\n\n共找到 3 套。");
});

test("工具或审批仍排在正文之后时不把中间说明误当最终总结", () => {
  const block = {
    t: "assistant",
    parts: [
      { p: "text", text: "正在查询，请稍候。", streaming: false },
      { p: "approval", req: {}, status: "pending" },
    ],
  } as unknown as AssistantBlock;
  assert.equal(assistantSummaryText(block), "");
});

test("流式正文和空白正文不可复制", async () => {
  const block = {
    t: "assistant",
    parts: [{ p: "text", text: "尚未完成", streaming: true }],
  } satisfies AssistantBlock;
  assert.equal(assistantSummaryText(block), "");
  assert.equal(await writeClipboardText("   \n  "), false);
});

test("用户消息、助手总结与压缩摘要均接入复制按钮和降级剪贴板", async () => {
  const messages = await readClientFiles(["render/messages.ts"]);
  const turn = await readClientFiles(["stream/turn.ts"]);
  const code = await readClientFiles(["render/code-enhance.ts"]);
  const css = await readClientCss();
  assert.match(messages, /class: "message-actions user-actions"/);
  assert.match(messages, /class: "message-actions assistant-actions hidden"/);
  assert.match(messages, /createMessageCopyButton\("复制"/);
  assert.match(messages, /createMessageCopyButton\("复制总结"/);
  assert.match(messages, /createMessageCopyButton\("复制摘要"/);
  assert.match(messages, /writeClipboardText/);
  assert.match(turn, /refreshAssistantCopy\(ablock\)/);
  assert.match(code, /writeClipboardText\(code\.textContent/);
  assert.match(css, /\.msg-user-content\s*\{/);
  assert.match(css, /\.message-action\.copied\s*\{/);
  assert.match(css, /\.msg-user:hover \.message-actions/);
  assert.match(css, /opacity:\s*0/);
  assert.doesNotMatch(messages, /message-action-label/);
  assert.match(css, /\.message-actions\.hidden\s*\{\s*display:\s*none/s);
});
