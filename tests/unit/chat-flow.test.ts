/**
 * chat-flow.test.ts — 审批恢复单助手块与长内容约束回归
 * ============================================================
 * 完整回合可经历多次 interrupt/resume，但 UI 只能有一个头像；
 * 审批卡里的长 URL / 命令必须能换行，不能撑破消息容器。
 */
import assert from "node:assert/strict";
import type { AssistantPart, ChatBlock } from "../../src/client/modules/types.js";
import { test } from "node:test";
import { readClientCss, readClientSource } from "../helpers/client-source.js";
import {
  assistantBlockContaining,
  isContinuationRecord,
  lastAssistantBlock,
  mergeAdjacentAssistantBlocks,
} from "../../src/client/modules/chat-flow.js";

test("continuation 标记与旧审批文案都能识别为恢复轮", () => {
  assert.equal(isContinuationRecord({ continuation: true, user: "任意" }), true);
  assert.equal(isContinuationRecord({ user: "（人工审批：批准 terminal）" }), true);
  assert.equal(isContinuationRecord({ user: "（需求澄清：北京）" }), true);
  assert.equal(isContinuationRecord({ user: "今天北京天气怎么样" }), false);
});

test("旧缓存中的连续助手块合并，并保留最后用量", () => {
  // 这些 fixture 刻意做成「旧缓存里可能出现的残缺形状」，故用 as 收窄到 ChatBlock
  const first = {
    t: "assistant", parts: [{ p: "tool", id: "1" }], _usage: { lastInput: 1 },
  } as unknown as ChatBlock;
  const second = {
    t: "assistant", parts: [{ p: "text", text: "完成" }], _usage: { lastInput: 2 },
  } as unknown as ChatBlock;
  const blocks: ChatBlock[] = [{ t: "user", text: "查天气" }, first, second];
  const merged = mergeAdjacentAssistantBlocks(blocks);
  assert.equal(merged.length, 2);
  assert.equal(merged[1], first);
  const parts = (merged[1] as { parts: Array<{ p: string }> }).parts;
  assert.deepEqual(parts.map((part) => part.p), ["tool", "text"]);
  assert.deepEqual((merged[1] as { _usage?: unknown })._usage, { lastInput: 2 });
});

test("审批 part 能定位所属助手块，用户消息分隔的块不会被误合并", () => {
  const approval = { p: "approval" } as unknown as AssistantPart;
  const first = { t: "assistant", parts: [approval] } as unknown as ChatBlock;
  const blocks: ChatBlock[] = [first, { t: "user", text: "下一问" }, { t: "assistant", parts: [] }];
  assert.equal(assistantBlockContaining(blocks, approval), first);
  assert.equal(lastAssistantBlock(blocks), blocks[2]);
  assert.equal(mergeAdjacentAssistantBlocks(blocks).length, 3);
});

test("前端恢复流复用原助手块，审批内容样式允许任意长串换行", async () => {
  const app = await readClientSource();
  const css = await readClientCss();
  assert.match(app, /export async function runResume\(/);
  assert.match(app, /mountTyping\(ablock\)/);
  assert.match(app, /isContinuationRecord\(rec\)/);
  assert.match(app, /mergeAdjacentAssistantBlocks\(blocks\)/);
  assert.match(css, /\.approval-desc\s*\{[^}]*overflow-wrap:\s*anywhere/s);
  assert.match(css, /\.approval-args\s*\{[^}]*overflow-wrap:\s*anywhere/s);
  assert.match(css, /\.approval-card\s*\{[^}]*overflow:\s*hidden/s);
});

test("审批完成后默认折叠为摘要行，仍可手动展开详情", async () => {
  const app = await readClientSource();
  const css = await readClientCss();
  assert.match(app, /part\.collapsed = true/);
  assert.match(app, /class: "approval-summary"/);
  assert.match(app, /class: "approval-body"/);
  assert.match(app, /part\.collapsed = !part\.collapsed/);
  assert.match(css, /\.approval-card\.collapsed \.approval-body\s*\{\s*display:\s*none/s);
});

test("思考过程使用默认折叠的 details，点击摘要可手动展开", async () => {
  const app = await readClientSource();
  const css = await readClientCss();
  assert.match(app, /case "reasoning": appendReasoning\(ablock, ev\)/);
  assert.match(app, /export function appendReasoning\(ablock: AssistantBlock, ev: \{ text\?: string; node\?: string \}\): void/);
  assert.match(app, /document\.createElement\("details"\)/);
  assert.match(app, /h\("summary", \{ class: "thinking-summary" \}/);
  assert.doesNotMatch(app, /details\.open\s*=\s*true/, "思考内容不能默认展开");
  assert.match(app, /thinking-node/);
  assert.match(app, /details\.addEventListener\("toggle"/);
  assert.match(css, /\.thinking-block\s*\{/);
  assert.match(css, /\.thinking-block\[open\]\s*\{/);
  assert.match(css, /\.thinking-text\s*\{[^}]*white-space:\s*pre-wrap/s);
});

test("同批工具超过两个才折叠到 tools，摘要保留工具名且 1–2 个继续平铺", async () => {
  const app = await readClientSource();
  const css = await readClientCss();
  assert.match(app, /export function mountToolCard\(block: AssistantBlock, card: HTMLElement\): void \{\s*blockBodies\.get\(block\)\?\.appendChild\(card\);/s);
  assert.match(app, /const TOOL_GROUP_MIN = 3/);
  assert.match(app, /export function groupToolCallsIfNeeded\(/);
  assert.match(app, /tools\.length < TOOL_GROUP_MIN/);
  assert.match(app, /tool-group-names/);
  assert.doesNotMatch(app, /tool-drawer|ensureToolDrawer|refreshToolDrawer/);
  assert.match(css, /\.tool-group-summary/);
  assert.match(css, /\.tool-group\[open\]/);
  assert.doesNotMatch(css, /\.tool-drawer|\.drawer-head|\.drawer-items/);
});

test("会话项右侧操作按钮共享横向操作区，导出与删除不会重叠", async () => {
  const app = await readClientSource();
  const css = await readClientCss();
  assert.match(app, /const exportButton = h\("button",/);
  assert.match(app, /const deleteButton = h\("button",/);
  assert.match(app, /h\("div", \{ class: "s-actions" \}, exportButton, deleteButton\)/);
  assert.match(css, /\.s-actions\s*\{[^}]*display:\s*flex[^}]*gap:\s*2px/s);
  assert.match(css, /\.session-item \.s-title\s*\{[^}]*padding-right:\s*56px/s);
  assert.match(css, /@media \(hover: none\), \(pointer: coarse\)/);
  assert.doesNotMatch(css, /\.s-del\s*\{[^}]*position:\s*absolute/s, "按钮本体不能各自绝对定位");
});
