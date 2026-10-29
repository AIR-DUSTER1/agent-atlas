/**
 * session-tree.test.ts — 侧栏会话树（按项目折叠）回归
 * ============================================================
 * 守：项目分组是一级节点、可键盘折叠、折叠状态持久化且重渲染后还原；
 * 未归属组有独立 key，不与真实 projectId 冲突；搜索态强制展开；
 * caret/aria 不缺失，reduced-motion 下不动画。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readClientCss, readClientFiles } from "../helpers/client-source.js";

test("项目分组头可折叠：角色、aria-expanded 与键盘操作齐备", async () => {
  const source = await readClientFiles(["views/sessions.ts"]);
  assert.match(source, /export const ORPHAN_GROUP_KEY = "__orphan__"/);
  assert.match(source, /function renderProjectGroupHead\(\s*project: ProjectEntry \| null,\s*key: string,/);
  assert.match(source, /role: interactive \? "button" : undefined/);
  assert.match(source, /"aria-expanded": interactive \? String\(!collapsed\) : undefined/);
  assert.match(source, /event\.key === "Enter" \|\| event\.key === " "/);
  assert.match(source, /toggleProjectCollapsed\(key\)/);
  assert.match(source, /icon\("ChevronRight", \{ size: 12 \}\)/);
});

test("折叠状态只存 key 列表并走 saveLocal 持久化", async () => {
  const sessions = await readClientFiles(["views/sessions.ts"]);
  const state = await readClientFiles(["core/state.ts"]);
  assert.match(sessions, /export function isProjectCollapsed\(key: string\): boolean/);
  assert.match(sessions, /state\.projCollapsed = isProjectCollapsed\(key\)/);
  assert.match(sessions, /saveLocal\(\);\s*\n\s*renderSessions\(\)/);
  assert.match(state, /LS_PROJ_COLLAPSED/);
  assert.match(state, /projCollapsed/);
  // 折叠后不再渲染子项：避免靠 CSS 隐藏导致列表语义与可访问性错位
  assert.match(sessions, /if \(collapsed\) continue;/);
  // 未归属组用独立 key，切换项目/搜索时不会与真实 projectId 撞车
  assert.match(sessions, /const other = \{ key: ORPHAN_GROUP_KEY/);
});

test("搜索时强制展开分组，避免命中结果被折叠藏起来", async () => {
  const source = await readClientFiles(["views/sessions.ts"]);
  assert.match(source, /const collapsed = !term && isProjectCollapsed\(group\.key\);/);
  assert.match(source, /collapsed, Boolean\(term\)\)\)/);
  const css = await readClientCss();
  assert.match(css, /\.proj-group-head\.static \{ cursor: default; \}/);
});

test("分组头样式：caret 旋转、悬停高亮并尊重 reduced-motion", async () => {
  const css = await readClientCss();
  assert.match(css, /\.proj-group-head:not\(\.collapsed\) \.g-caret \{ transform: rotate\(90deg\); \}/);
  assert.match(css, /\.proj-group-head:hover \{ background: var\(--bg-hover\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.proj-group-head \.g-caret \{ transition: none; \}/);
});
