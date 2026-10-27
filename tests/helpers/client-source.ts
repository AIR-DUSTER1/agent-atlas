/**
 * ============================================================
 * tests/helpers/client-source.ts — 读取前端源码全文（供结构断言用）
 * ============================================================
 * 为什么需要：一批单测用「正则匹配源码」守护 UI 结构约定（例如思考卡必须
 * 默认折叠、审批卡必须有 collapsed 状态）。前端从单个 app.js 拆成
 * src/client/ 下多模块后，这些测试需要一次性拿到全部源码。
 *
 * 立场：
 *  - 只读 .ts 源码，不读构建产物（产物是 tsconfig 输出，断言产物等于断言编译器）；
 *  - 列出的文件就是「前端全部实现」，新增模块要加进 CLIENT_SOURCES，
 *    否则结构断言会漏掉它（有意为之：清单可见、可审）。
 */
import { readFile } from "node:fs/promises";

/** 前端源码清单（相对 src/client/），按目录分组便于审阅 */
export const CLIENT_SOURCES = [
  // 入口与核心
  "main.ts",
  "core/state.ts",
  "core/dom.ts",
  "core/api.ts",
  // 无业务 UI 原语
  "ui/safe-url.ts",
  "ui/h.ts",
  "ui/icon.ts",
  "ui/button.ts",
  "ui/input.ts",
  "ui/field.ts",
  "ui/card.ts",
  "ui/empty.ts",
  // 协议与纯函数模块
  "modules/format.ts",
  "modules/ui-dialog.ts",
  "modules/chat-flow.ts",
  "modules/agent-profile.ts",
  "modules/plugin-registry.ts",
  "modules/types.ts",
  "modules/types-api.ts",
  "modules/types-ui.ts",
  // 渲染层
  "render/parts.ts",
  "render/messages.ts",
  "render/tool-enhancers.ts",
  // 流与动作
  "stream/events.ts",
  "stream/turn.ts",
  "actions/approvals.ts",
  "actions/compact.ts",
  // 视图层
  "views/navigation.ts",
  "views/sessions.ts",
  "views/projects.ts",
  "views/shell.ts",
  "views/external.ts",
  "views/composer-bar.ts",
  "views/attachments.ts",
  "views/rag.ts",
  "views/estate.ts",
  "views/settings.ts",
  "views/settings-backup.ts",
  "views/settings-memories.ts",
  "views/settings-stats.ts",
  "views/model-store.ts",
  "views/model-panel.ts",
  "views/model-form.ts",
  "views/model-actions.ts",
  "views/model-menu.ts",
  // 输入框菜单
  "composer/menu.ts",
  // 第三方隔离 wrapper（业务只允许从这里使用 npm 前端库）
  "vendor/chart.ts",
  "vendor/icons.ts",
  "vendor/markdown.ts",
  "vendor/highlight.ts",
];

/** 读取全部前端源码并拼成一段文本（保留文件边界注释，便于定位断言来源） */
export async function readClientSource(): Promise<string> {
  const root = new URL("../../src/client/", import.meta.url);
  const parts = await Promise.all(
    CLIENT_SOURCES.map(async (name) => {
      const text = await readFile(new URL(name, root), "utf8");
      return `\n/* ==== src/client/${name} ==== */\n${text}`;
    })
  );
  return parts.join("\n");
}

/** 只读某几个前端文件（断言范围更精确时用） */
export async function readClientFiles(names: string[]): Promise<string> {
  const root = new URL("../../src/client/", import.meta.url);
  const parts = await Promise.all(
    names.map(async (name) => {
      const text = await readFile(new URL(name, root), "utf8");
      return `\n/* ==== src/client/${name} ==== */\n${text}`;
    })
  );
  return parts.join("\n");
}
