/**
 * ============================================================
 * agent/platform-capabilities.ts — 可跨 Profile 显式装配的平台插件
 * ============================================================
 * 职责：把 Browser Use / Computer Use 这类与业务领域无关、但具有改世界能力的
 * 工具做成显式白名单扩展。只有调用方 Profile 主动引用本模块时才会装配；
 * 它不是全局工具表，也不会把找房 / 求职 / 开发工具带到其它 Agent。
 */
import type { StructuredToolInterface } from "@langchain/core/tools";
import { browserTools } from "../tools-browser.js";
import { computerTools } from "../tools-computer.js";
import { isPluginEnabled } from "../plugin-state.js";
import { generalApprovals } from "./approvals.js";
import type { ApprovalDescriptions } from "./profile.js";

const PLATFORM_TOOL_SETS: Array<{ id: "browser" | "computer"; tools: StructuredToolInterface[] }> = [
  { id: "browser" as const, tools: browserTools },
  { id: "computer" as const, tools: computerTools },
];

const PLATFORM_APPROVAL_NAMES = [
  "browser_act",
  "computer_click",
  "computer_type",
  "computer_key",
  "computer_scroll",
] as const;

/** 只返回当前已启用的平台工具；关闭的插件不会进入任何 Profile。 */
export function activePlatformTools(): StructuredToolInterface[] {
  return PLATFORM_TOOL_SETS
    .filter((entry) => isPluginEnabled(entry.id))
    .flatMap((entry) => entry.tools);
}

/** 平台能力的审批项按实际装配工具收敛，避免留下悬空审批。 */
export function activePlatformApprovals(): ApprovalDescriptions {
  const names = new Set(activePlatformTools().map((item) => item.name));
  return Object.fromEntries(
    PLATFORM_APPROVAL_NAMES
      .filter((name) => names.has(name))
      .map((name) => [name, generalApprovals[name]]),
  );
}

/** 在领域提示词后追加平台能力边界；未启用时返回空串。 */
export function platformCapabilityPrompt(): string {
  const enabled: string[] = [];
  if (isPluginEnabled("browser")) enabled.push("Browser Use（浏览器观察与操作）");
  if (isPluginEnabled("computer")) enabled.push("Computer Use（Windows 桌面观察与操作）");
  if (!enabled.length) return "";
  return `- 平台插件已启用：${enabled.join("、")}。仅在用户明确要求浏览器或桌面操作时使用；先观察再动作，动作仍受会话权限与高风险审批约束。当请求本身就是平台操作时，不要套用当前 Agent 的领域澄清门槛；平台结果也不得冒充领域数据源。`;
}
