/**
 * tools-browser.ts — Browser Use 的模型工具契约
 * ============================================================
 * 工具只负责取当前 thread_id 并调用 server/browser-use；浏览器画面由前端工具卡
 * 增强器自动在会话右侧打开。读取/导航直接执行，真正点击、输入、按键和选择进入审批。
 */
import { tool } from "@langchain/core/tools";
import type { ToolRunnableConfig } from "@langchain/core/tools";
import { z } from "zod";
import { isPluginEnabled } from "./plugin-state.js";
import {
  actOnBrowser, navigateBrowser, openBrowser, scrollBrowser, snapshotBrowser,
  type BrowserToolResult,
} from "./server/browser-use.js";

const MAX_RESULT_CHARS = 26_000;

function sessionIdFrom(config?: ToolRunnableConfig): string {
  const threadId = config?.configurable?.thread_id;
  if (typeof threadId !== "string" || !threadId.trim()) {
    throw new Error("Browser Use 只能在有会话上下文的聊天中运行");
  }
  return threadId;
}

function disabled(): string {
  return JSON.stringify({ error: "Browser Use 插件已停用，请先在「设置 → 插件」中启用" });
}

function finalize(action: string, result: BrowserToolResult): string {
  const payload = {
    ok: true,
    action,
    sessionId: result.sessionId,
    browserUse: {
      sessionId: result.sessionId,
      open: true,
      updatedAt: result.state.updatedAt,
      url: result.state.url,
      title: result.state.title,
    },
    state: result.state,
    snapshot: result.snapshot,
    note: "右侧浏览器画面会自动刷新。点击或输入后请重新读取 snapshot，旧 ref 可能失效。",
  };
  const text = JSON.stringify(payload);
  if (text.length <= MAX_RESULT_CHARS) return text;
  return JSON.stringify({
    ok: true,
    action,
    sessionId: result.sessionId,
    browserUse: payload.browserUse,
    state: result.state,
    snapshot: { text: result.snapshot.text.slice(0, 5_000), elements: result.snapshot.elements.slice(0, 40), truncated: true },
    note: "页面快照过长已截断；需要更多内容时滚动或打开更具体的页面。",
  });
}

function failure(action: string, err: unknown): string {
  return JSON.stringify({
    ok: false,
    action,
    error: err instanceof Error ? err.message : String(err),
    note: "Browser Use 操作失败。不要编造页面内容；修正参数或向用户说明。",
  });
}

export const browserOpenTool = tool(
  async ({ url, allowLocalhost }, config) => {
    if (!isPluginEnabled("browser")) return disabled();
    try {
      return finalize("open", await openBrowser(sessionIdFrom(config), url, Boolean(allowLocalhost)));
    } catch (err) {
      return failure("open", err);
    }
  },
  {
    name: "browser_open",
    description:
      "打开 Browser Use 右侧实时浏览器并访问一个 http/https 页面。首次使用或需要换站时调用；" +
      "返回页面文字、可交互元素及其稳定 ref。默认拒绝内网地址，只有用户明确要求访问本机/局域网时才允许 allowLocalhost=true。",
    schema: z.object({
      url: z.string().describe("完整 http/https URL"),
      allowLocalhost: z.boolean().optional().describe("是否允许本机/私网地址，默认 false；仅用户明确要求时设为 true"),
    }),
  },
);

export const browserSnapshotTool = tool(
  async (_input, config) => {
    if (!isPluginEnabled("browser")) return disabled();
    try {
      return finalize("snapshot", await snapshotBrowser(sessionIdFrom(config)));
    } catch (err) {
      return failure("snapshot", err);
    }
  },
  {
    name: "browser_snapshot",
    description:
      "重新读取当前浏览器页面的标题、URL、可见正文和可交互元素 ref。页面变化、操作失败或不确定元素位置时调用；" +
      "后续 browser_act 只能使用这里返回的 ref。",
    schema: z.object({}),
  },
);

export const browserNavigateTool = tool(
  async ({ action }, config) => {
    if (!isPluginEnabled("browser")) return disabled();
    try {
      return finalize(action, await navigateBrowser(sessionIdFrom(config), action));
    } catch (err) {
      return failure(action, err);
    }
  },
  {
    name: "browser_navigate",
    description: "在 Browser Use 中后退或前进；只移动浏览器历史，不执行站点点击。需要刷新时重新 browser_open 当前 URL。",
    schema: z.object({
      action: z.enum(["back", "forward"]).describe("导航动作"),
    }),
  },
);

export const browserScrollTool = tool(
  async ({ direction, amount }, config) => {
    if (!isPluginEnabled("browser")) return disabled();
    try {
      return finalize("scroll", await scrollBrowser(sessionIdFrom(config), direction, amount));
    } catch (err) {
      return failure("scroll", err);
    }
  },
  {
    name: "browser_scroll",
    description: "在 Browser Use 页面中滚动以查看下一屏；随后会返回更新后的文字和元素 ref。",
    schema: z.object({
      direction: z.enum(["up", "down"]).describe("滚动方向"),
      amount: z.number().int().min(100).max(2_000).optional().describe("滚动像素，默认 600"),
    }),
  },
);

export const browserActTool = tool(
  async ({ action, ref, text, key, value, submit }, config) => {
    if (!isPluginEnabled("browser")) return disabled();
    try {
      return finalize(action, await actOnBrowser(sessionIdFrom(config), action, { ref, text, key, value, submit }));
    } catch (err) {
      return failure(action, err);
    }
  },
  {
    name: "browser_act",
    description:
      "对 Browser Use 当前页面执行会改变页面的动作：click/type/press/select。" +
      "click/type/select 必须使用 browser_snapshot 返回的 ref；press 用 key。动作前系统会请求人工审批。",
    schema: z.object({
      action: z.enum(["click", "type", "press", "select"]).describe("动作类型"),
      ref: z.string().optional().describe("snapshot 返回的元素 ref，如 e3；press 可省略"),
      text: z.string().optional().describe("type 要填入的文本"),
      key: z.string().optional().describe("press 的按键，如 Enter、Tab、Control+L"),
      value: z.string().optional().describe("select 要选择的 option value"),
      submit: z.boolean().optional().describe("type 后是否按 Enter 提交"),
    }),
  },
);

export const browserTools = [
  browserOpenTool,
  browserSnapshotTool,
  browserNavigateTool,
  browserScrollTool,
  browserActTool,
];
