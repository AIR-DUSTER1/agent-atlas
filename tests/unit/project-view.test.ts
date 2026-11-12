/**
 * project-view.test.ts — “不选择项目”视图的纯逻辑回归
 * ============================================================
 * 守：全部项目展示所有会话；不选择项目只展示内部 default；
 * 从无项目视图新建会话仍落 default，侧栏渲染必须复用同一过滤函数。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  DEFAULT_PROJECT_ID,
  PROJECT_VIEW_ALL,
  PROJECT_VIEW_NONE,
  isNoProjectView,
  projectIdForNewSession,
  sessionMatchesProjectView,
} from "../../src/client/modules/project-view.js";

test("项目视图：全部 / 不选择 / 指定项目筛选互不混淆", () => {
  assert.equal(sessionMatchesProjectView(PROJECT_VIEW_ALL, "proj-a"), true);
  assert.equal(sessionMatchesProjectView(PROJECT_VIEW_ALL, DEFAULT_PROJECT_ID), true);
  assert.equal(sessionMatchesProjectView(PROJECT_VIEW_NONE, DEFAULT_PROJECT_ID), true);
  assert.equal(sessionMatchesProjectView(PROJECT_VIEW_NONE, "proj-a"), false);
  assert.equal(sessionMatchesProjectView("proj-a", "proj-a"), true);
  assert.equal(sessionMatchesProjectView("proj-a", DEFAULT_PROJECT_ID), false);
  assert.equal(isNoProjectView(PROJECT_VIEW_NONE), true);
});

test("新建会话：不选择项目和全部项目都落到内部 default", () => {
  assert.equal(projectIdForNewSession(PROJECT_VIEW_NONE), DEFAULT_PROJECT_ID);
  assert.equal(projectIdForNewSession(PROJECT_VIEW_ALL), DEFAULT_PROJECT_ID);
  assert.equal(projectIdForNewSession("proj-a"), "proj-a");
  assert.equal(projectIdForNewSession(""), DEFAULT_PROJECT_ID);
});

test("侧栏渲染复用统一过滤函数，不选择项目能显示 default 会话", async () => {
  const source = await readFile(new URL("../../src/client/views/sessions.ts", import.meta.url), "utf8");
  assert.match(source, /sessionMatchesProjectView\(state\.projectView, session\.projectId\)/);
  assert.doesNotMatch(source, /state\.projectView === "all" \|\| session\.projectId === state\.projectView/);
});
