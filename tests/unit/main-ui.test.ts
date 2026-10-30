/**
 * main-ui.test.ts — 主界面结构回归
 * ============================================================
 * 守：空会话有明确起步动作、顶栏有项目/会话面包屑、侧栏有日期分组、
 * 消息流有回到底部与未读提示；这些是“空白会话/不知道下一步”问题的回归门。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { readClientFiles, readClientSource } from "../helpers/client-source.js";

test("空会话提供三个快捷起步且不会自动发送", async () => {
  const html = await readFile(new URL("../../src/client/index.html", import.meta.url), "utf8");
  const main = await readClientFiles(["main.ts"]);
  assert.match(html, /id="empty-session"/);
  assert.equal((html.match(/data-empty-prompt=/g) ?? []).length, 3);
  assert.match(main, /\[data-empty-prompt\]/);
  assert.match(main, /inputEl\.value = button\.dataset\.emptyPrompt/);
  assert.doesNotMatch(main, /data-empty-prompt[\s\S]{0,500}send\(\)/);
});

test("顶栏面包屑与空状态切换已接线", async () => {
  const html = await readFile(new URL("../../src/client/index.html", import.meta.url), "utf8");
  const source = await readClientFiles(["views/navigation.ts"]);
  assert.match(html, /id="breadcrumb-project"/);
  assert.match(html, /data-icon="ChevronRight"/);
  assert.match(source, /breadcrumb\.textContent = projectById\(session\.projectId\)/);
  assert.match(source, /classList\.toggle\("hidden", transcript\(session\.id\)\.length > 0\)/);
});

test("新建会话会刷新上下文容量条，不残留上一会话用量", async () => {
  const navigation = await readClientFiles(["views/navigation.ts"]);
  const turn = await readClientFiles(["stream/turn.ts"]);
  assert.match(navigation, /renderPermChip\(session\);\s*\/\/[^\n]*容量条/);
  assert.match(navigation, /updateContextBar\(\);/);
  assert.match(turn, /showChatState\(created\)/);
  assert.doesNotMatch(turn, /showChatState\(state\.sessions\[0\]\)/);
});

test("侧栏按项目与今天/昨天/更早分组，并显示相对时间", async () => {
  const source = await readClientFiles(["views/sessions.ts"]);
  assert.match(source, /function sessionDayGroup/);
  assert.match(source, /session-time-head/);
  assert.match(source, /昨天 \$\{time\}/);
  assert.match(source, /天前/);
});

test("多个会话可并行生成，切换会话不再被全局流状态拦截", async () => {
  const turn = await readClientFiles(["stream/turn.ts"]);
  const navigation = await readClientFiles(["views/navigation.ts"]);
  const sessions = await readClientFiles(["views/sessions.ts"]);
  const events = await readClientFiles(["stream/events.ts"]);

  assert.match(turn, /state\.streams\[sid\]/);
  assert.match(turn, /syncComposerState\(sid\)/);
  assert.match(turn, /state\.streams\[state\.currentId\]\?\.ctrl\.abort\(\)/);
  assert.match(navigation, /export function selectSession\(sid: string\): void \{\s*closeComposerMenu\(\);/);
  assert.doesNotMatch(navigation, /当前正在生成回复，请先停止或等待完成/);
  assert.match(sessions, /class: "s-running"/);
  assert.match(events, /const visible = sid === state\.currentId/);
});
test("消息流有回到底部按钮与未读累计", async () => {
  const source = await readClientSource();
  assert.match(source, /function distanceFromBottom/);
  assert.match(source, /NEAR_BOTTOM_PX = 120/);
  assert.match(source, /markNewMessage\(\)/);
  assert.match(source, /条新消息/);
  assert.match(source, /prefers-reduced-motion: reduce/);
});

test("没有项目时首屏和新建对话直接进入 Agent 选择页", async () => {
  const main = await readClientFiles(["main.ts"]);
  const navigation = await readClientFiles(["views/navigation.ts"]);
  const html = await readFile(new URL("../../src/client/index.html", import.meta.url), "utf8");
  assert.match(main, /state\.projects\.length === 0/);
  assert.match(main, /showWelcomeState\("agent-picker"\)/);
  assert.match(navigation, /WelcomeMode = "default" \| "agent-picker"/);
  assert.match(navigation, /选择一个 Agent 开始新会话/);
  assert.match(navigation, /请选择 Agent 开始新会话/);
  assert.match(html, /id="welcome-title"/);
  assert.match(html, /id="welcome-cards-label"/);
});
