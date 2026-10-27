/**
 * ui-interactions.test.ts — 对话框 / 菜单 / Toast 关键交互契约
 * ============================================================
 * DOM 交互由浏览器人工验收；这里守源码中不能回退的结构：焦点陷阱与恢复、
 * Esc/方向键、点外关闭、Toast 暂停/显式关闭，以及禁止重新引入四套私有定位器。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const read = (path: string): Promise<string> => readFile(new URL(`../../src/client/${path}`, import.meta.url), "utf8");

test("dialog 队列、焦点陷阱、inert 与焦点恢复均在统一实现中", async () => {
  const source = await read("ui/dialog.ts");
  assert.match(source, /queue: QueuedDialog\[\]/);
  assert.match(source, /function trapTab\(/);
  assert.match(source, /setAttribute\("inert"/);
  assert.match(source, /previousFocus/);
  assert.match(source, /previous\?\.focus\(\)/);
  assert.match(source, /aria-describedby/);
});

test("浮动菜单统一处理点外关闭、Esc、方向键与焦点返回", async () => {
  const source = await read("ui/menu.ts");
  assert.match(source, /pointerdown/);
  assert.match(source, /event\.key === "Escape"/);
  assert.match(source, /ArrowDown/);
  assert.match(source, /anchor\.focus\(\)/);
  assert.match(source, /document\.body\.appendChild\(menu\)/);
});

test("Toast 支持暂停、继续、显式关闭且不注入 HTML", async () => {
  const source = await read("ui/toast.ts");
  assert.match(source, /pointerenter/);
  assert.match(source, /pointerleave/);
  assert.match(source, /aria-label": "关闭提示"/);
  assert.doesNotMatch(source, /innerHTML/);
  assert.match(source, /h\("span", \{ class: "ui-toast-message" \}, message\)/);
});
