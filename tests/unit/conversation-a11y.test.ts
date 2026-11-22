/**
 * conversation-a11y.test.ts — 对话核心的可访问性契约（M4 批次 4.6）
 * ============================================================
 * 守 4.6 计划里的三项要求（迁移后不能退化）：
 *  1. **live region**：消息流是 role=log + aria-live=polite + aria-relevant，
 *     思考卡状态行是 role=status + aria-live=polite；
 *  2. **reduced-motion**：流式相关的过渡必须能被 prefers-reduced-motion 关掉；
 *  3. **回退开关裁定**：1:1 过渡树与旧 h() 块骨架退役后不再保留并行渲染实现，
 *     以「全量测试 + 真实 UI e2e」作为唯一保障 —— 本测试锁定该状态，防止
 *     有人误加一个长期失修的 legacy 分支。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readClientCss, readClientFiles } from "../helpers/client-source.js";
import { readClientIndexHtml } from "../helpers/client-html.js";

test("对话消息流是 live region：role=log + polite + additions", async () => {
  const html = await readClientIndexHtml();
  const messages = html.slice(html.indexOf('id="messages"'), html.indexOf("</div>", html.indexOf('id="messages"')));
  assert.match(messages, /role="log"/, "消息流必须是 log 角色");
  assert.match(messages, /aria-live="polite"/, "流式新增必须被礼貌播报");
  assert.match(messages, /aria-relevant="additions text"/, "只播报新增与文本变化，避免整块重读");
  assert.match(messages, /aria-label="对话消息"/, "live region 必须有可访问名称");
});

test("思考卡状态行是独立 live region，完成后静默", async () => {
  const parts = await readClientFiles(["render/parts.ts"]);
  assert.match(parts, /class: "thinking-meta"/);
  assert.match(parts, /role: "status"/);
  assert.match(parts, /"aria-live": "polite"/);
  // 文案只有流式期间存在（「思考中」），结束即清空并加 hidden，避免播报噪音
  assert.match(parts, /metaEl\.textContent = streaming \? "思考中" : ""/);
  assert.match(parts, /metaEl\.classList\.toggle\("hidden", !streaming\)/);
});

test("流式动画在 prefers-reduced-motion 下全部关闭或停播", async () => {
  const css = await readClientCss();
  const reducedBlocks = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)]
    .map((match) => match[1] ?? "")
    .join("\n");
  // 1) 打字指示器是无限循环 animation —— 必须 animation: none
  assert.match(reducedBlocks, /\.typing i \{[^}]*animation:\s*none/, "打字指示器必须停播");
  // 2) 布局级过渡（消息区平移 / 分组 caret）必须 transition: none
  for (const selector of ["#chat-scroll", ".proj-group-head"]) {
    const needle = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(
      reducedBlocks,
      new RegExp(`${needle}[^{]*\\{[^}]*transition:\\s*none`),
      `${selector} 必须在 reduced-motion 下关闭过渡`,
    );
  }
});

test("不再保留并行的旧渲染实现（4.6 回退开关裁定）", async () => {
  // 1:1 过渡树与旧 h() 块骨架已退役；若有人重新引入 legacy 渲染分支，
  // 它会立刻与后续修复脱节 —— 这里直接挡住。
  const { readdir } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  // Windows 上 URL.pathname 会带盘符前缀（/E:/…），必须用 fileURLToPath 转换
  const clientDir = fileURLToPath(new URL("../../src/client/", import.meta.url));
  // 只按 basename 匹配：views 已按页面重组进 views/<page>/，用路径后缀匹配
  // 会在搬目录后静默失去覆盖（测试仍绿但守门失效，比红更危险）。
  const forbidden = ["messages-legacy.ts", "message-list-legacy.ts"];
  const found: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (forbidden.includes(entry.name)) found.push(path);
    }
  }
  await walk(clientDir);
  assert.deepEqual(found, [], "不允许并行的 legacy 渲染实现");
});
