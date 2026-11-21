/**
 * ============================================================
 * modules/permission-modes.ts — 会话权限模式的纯数据
 * ============================================================
 * 职责：权限模式的 id / 文案 / 说明单一来源。
 * 为什么独立成模块：legacy 桥（views/navigation.ts，在 1:1 过渡树上）与
 * Vue store（stores/topbar.ts，含 pinia）都要用它。放在 store 里会让 1:1
 * 静态图出现裸包名 pinia，整条浏览器模块链会崩（M4 红线）。
 *
 * 语义：只读 = 改世界工具一律拒绝；审批 = 高风险先确认（默认）；
 * 自主 = AI 判断当前操作是否高风险；自动 = 全部直接执行。
 */
import type { PermissionModeId } from "./types.js";

export interface PermissionMode {
  id: PermissionModeId;
  label: string;
  desc: string;
}

export const PERMISSION_MODES: PermissionMode[] = [
  { id: "readonly", label: "只读", desc: "只允许只读工具：写文件 / 执行命令 / 发消息 / 控制电脑一律拒绝" },
  { id: "approve", label: "审批", desc: "高风险操作执行前弹审批卡片，人工批准才执行（默认）" },
  { id: "autonomous", label: "自主", desc: "AI 判断当前操作风险：高风险才申请人工审批，低风险直接执行（评估失败按高风险）" },
  { id: "auto", label: "自动", desc: "全部工具直接执行，不再逐项审批（信任当前会话时使用）" },
];
