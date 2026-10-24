/**
 * ============================================================
 * permission.ts — 会话级权限模式（工具执行的统一闸门）
 * ============================================================
 * 权限模式是「当前会话采用什么权限进行会话」的单一事实来源：
 *   readonly 只读：一切「改世界」工具（= 审批登记项）直接拒绝执行；
 *   approve 审批：默认 —— 审批登记项先 interrupt 等用户点头；
 *   auto     自动：全部工具直接执行，不再逐项审批。
 *
 * 判定基准刻意复用 profile 的 approvalDescriptions：会「改世界」的操作
 * 必然登记审批，因此「审批项 = 只读模式禁用项」，不再维护第二份清单。
 * 本文件是纯函数层（agent 层），不感知 server；实际拦截在 hitl.ts 执行节点。
 */
import type { ApprovalDescriptions } from "./profile.js";

export type PermissionMode = "readonly" | "approve" | "auto";

/** resolveToolPermission 的三种裁决：直接执行 / 先审批 / 只读拒绝 */
export type ToolPermissionAction = "run" | "interrupt" | "deny";

export const PERMISSION_MODES: PermissionMode[] = ["readonly", "approve", "auto"];

export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  readonly: "只读",
  approve: "审批",
  auto: "自动",
};

export const PERMISSION_MODE_DESCRIPTIONS: Record<PermissionMode, string> = {
  readonly: "只允许只读工具，写文件 / 执行命令 / 发消息 / 控制电脑一律拒绝",
  approve: "高风险操作执行前弹出审批卡片，人工批准才执行（默认）",
  auto: "全部工具直接执行，不再逐项审批（信任当前会话时使用）",
};

export function isPermissionMode(value: unknown): value is PermissionMode {
  return value === "readonly" || value === "approve" || value === "auto";
}

/**
 * 单个工具在当前权限模式下的裁决。
 * 旧调用方不传 mode 时按 approve 处理，与引入权限模式之前的行为完全一致。
 */
export function resolveToolPermission(
  mode: PermissionMode | undefined,
  toolName: string,
  approvalDescriptions: ApprovalDescriptions
): ToolPermissionAction {
  const registered = Boolean(approvalDescriptions[toolName]);
  if (mode === "readonly") return registered ? "deny" : "run";
  if (mode === "auto") return "run";
  return registered ? "interrupt" : "run";
}

/** 只读模式下拒绝执行的 ToolMessage 文案（模型可读，让其转述而非反复重试） */
export function readonlyDenyText(toolName: string): string {
  return `当前会话为「只读」权限，工具「${toolName}」属于会修改系统的高风险操作，已被拒绝执行。` +
    `请只用只读工具（读文件 / 列目录 / 搜索 / 检索 / 截屏 / 计算等）完成任务，` +
    `需要写操作时向用户说明：可在输入框上方把权限切回「审批」或「自动」。`;
}

/** 注入 agent 系统提示的权限说明；approve 是默认行为，不额外占 token */
export function permissionModeNote(mode: PermissionMode | undefined): string {
  if (mode === "readonly") {
    return "【权限模式】当前会话为只读：write_file / terminal / send_email / 电脑控制等" +
      "高风险工具都会被系统直接拒绝，请规划只读方案，不要发起写操作调用。";
  }
  if (mode === "auto") {
    return "【权限模式】当前会话为自动执行：工具调用将直接执行、不再逐项审批。" +
      "仍应只在确有必要时调用高风险工具，并在回答中说明做过什么。";
  }
  return "";
}
