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

test("媒体预览支持缩放、拖动、Esc 关闭与焦点恢复", async () => {
  const source = await read("ui/media-preview.ts");
  assert.match(source, /const MIN_SCALE = 0\.5/);
  assert.match(source, /const MAX_SCALE = 4/);
  assert.match(source, /aria-label": "放大预览"/);
  assert.match(source, /event\.deltaY < 0 \? ZOOM_STEP : -ZOOM_STEP/);
  assert.match(source, /pointermove/);
  assert.match(source, /event\.key === "Escape"/);
  assert.match(source, /event\.stopPropagation\(\)/);
  assert.match(source, /event\.key === "\+" \|\| event\.key === "="/);
  assert.match(source, /previous\?\.isConnected\) previous\.focus\(\)/);
  assert.match(source, /surface\.replaceChildren\(content\)/);
  assert.doesNotMatch(source, /innerHTML/);
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

test("消息流不得用 CSS scroll-behavior: smooth（会吞掉用户滚轮）", async () => {
  // 真实回归：CSS 级 smooth 会把所有 JS 的 `scrollTop = ...` 赋值动画化。
  // 流式输出每来一块就发起一次新动画，用户中途滚轮被持续覆盖，松手后视图继续
  // 朝底部跑 —— 表现为「点完回到底部，滚轮滚不动 / 位置又回去了」。
  // 平滑只允许出现在用户主动点「回到底部」的那一次（显式传 behavior）。
  const read2 = (path: string): Promise<string> => readFile(new URL(`../../src/client/${path}`, import.meta.url), "utf8");
  const css = await read2("styles/chat/chat-messages.css");
  assert.doesNotMatch(
    css,
    /#chat-scroll[^{]*\{[^}]*scroll-behavior:\s*smooth/,
    "群聊滚动容器不能全局 smooth：跟随类滚动必须是瞬时，平滑只给显式点击",
  );
  const source = await read2("ui/scroll-to-bottom.ts");
  // 点击按钮时显式传 smooth
  assert.match(source, /behavior:\s*"smooth"/);
  // 必须能在用户滚轮/触摸时中止动画
  assert.match(source, /function cancelScrollAnimation/);
  assert.match(source, /addEventListener\("wheel",\s*interrupt/);
  assert.match(source, /addEventListener\("touchstart",\s*interrupt/);
  assert.match(source, /behavior:\s*"instant"/);
});
