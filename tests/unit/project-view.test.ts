/**
 * project-view.test.ts — “不选择项目”视图的纯逻辑回归
 * ============================================================
 * 守：全部项目展示所有会话；不选择项目只展示内部 default；
 * 从无项目视图新建会话仍落 default，不会继承上一次选中的项目。
 */
import assert from "node:assert/strict";
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
