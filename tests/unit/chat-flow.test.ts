/**
 * chat-flow.test.ts — 审批恢复单助手块与长内容约束回归
 * ============================================================
 * 完整回合可经历多次 interrupt/resume，但 UI 只能有一个头像；
 * 审批卡里的长 URL / 命令必须能换行，不能撑破消息容器。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  assistantBlockContaining,
  isContinuationRecord,
  lastAssistantBlock,
  mergeAdjacentAssistantBlocks,
} from "../../src/server/public/modules/chat-flow.js";

test("continuation 标记与旧审批文案都能识别为恢复轮", () => {
  assert.equal(isContinuationRecord({ continuation: true, user: "任意" }), true);
  assert.equal(isContinuationRecord({ user: "（人工审批：批准 terminal）" }), true);
  assert.equal(isContinuationRecord({ user: "（需求澄清：北京）" }), true);
  assert.equal(isContinuationRecord({ user: "今天北京天气怎么样" }), false);
});

test("旧缓存中的连续助手块合并，并保留最后用量", () => {
  const first = { t: "assistant", parts: [{ p: "tool", id: "1" }], _usage: { lastInput: 1 } };
  const second = { t: "assistant", parts: [{ p: "text", text: "完成" }], _usage: { lastInput: 2 } };
  const blocks = [{ t: "user", text: "查天气" }, first, second];
  const merged = mergeAdjacentAssistantBlocks(blocks);
  assert.equal(merged.length, 2);
  assert.equal(merged[1], first);
  assert.deepEqual(merged[1].parts.map((part) => part.p), ["tool", "text"]);
  assert.deepEqual(merged[1]._usage, { lastInput: 2 });
});

test("审批 part 能定位所属助手块，用户消息分隔的块不会被误合并", () => {
  const approval = { p: "approval" };
  const first = { t: "assistant", parts: [approval] };
  const blocks = [first, { t: "user", text: "下一问" }, { t: "assistant", parts: [] }];
  assert.equal(assistantBlockContaining(blocks, approval), first);
  assert.equal(lastAssistantBlock(blocks), blocks[2]);
  assert.equal(mergeAdjacentAssistantBlocks(blocks).length, 3);
});

test("前端恢复流复用原助手块，审批内容样式允许任意长串换行", async () => {
  const root = new URL("../../src/server/public/", import.meta.url);
  const app = await readFile(new URL("app.js", root), "utf8");
  const css = await readFile(new URL("style.css", root), "utf8");
  assert.match(app, /async function runResume\(payload, targetBlock = null\)/);
  assert.match(app, /mountTyping\(ablock\)/);
  assert.match(app, /isContinuationRecord\(rec\)/);
  assert.match(app, /mergeAdjacentAssistantBlocks\(blocks\)/);
  assert.match(css, /\.approval-desc\s*\{[^}]*overflow-wrap:\s*anywhere/s);
  assert.match(css, /\.approval-args\s*\{[^}]*overflow-wrap:\s*anywhere/s);
  assert.match(css, /\.approval-card\s*\{[^}]*overflow:\s*hidden/s);
});