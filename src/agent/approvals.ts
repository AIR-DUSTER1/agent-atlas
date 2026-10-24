/**
 * approvals.ts — 按 Agent profile 拆分的审批策略
 * ============================================================
 * 审批文案属于能力边界，不放进全局表：general 只登记通用高风险工具，
 * estate 只登记房产对外动作。工具名未在本 profile 登记时不会触发审批，
 * 但若也不在 profile.tools 中，执行节点会 fail-closed 拒绝。
 */
import type { ApprovalDescriptions } from "./profile.js";

export const demoApprovals: ApprovalDescriptions = {
  send_email: (a) => `向 ${String(a.to)} 发送邮件，主题是「${String(a.subject)}」`,
};

export const generalApprovals: ApprovalDescriptions = {
  ...demoApprovals,
  terminal: (a) => `在项目根目录执行命令：${String(a.command)}`,
  write_file: (a) => `写入文件「${String(a.path)}」（${String(a.content ?? "").length} 字符）`,
  computer_click: (a) =>
    `点击屏幕坐标 (${String(a.x)}, ${String(a.y)})${a.double ? "（双击）" : ""}${a.button === "right" ? "（右键）" : ""}`,
  computer_type: (a) => `向当前窗口输入 ${String(a.text ?? "").length} 字符文本：${String(a.text ?? "").slice(0, 40)}`,
  computer_key: (a) => `发送组合按键 ${String(a.combo)}`,
  computer_scroll: (a) => `在鼠标位置${a.direction === "up" ? "向上" : "向下"}滚动 ${String(a.lines ?? 3)} 行`,
};

export const estateApprovals: ApprovalDescriptions = {
  house_appoint: (a) =>
    `提交贝壳带看预约：房源 ${String(a.houseId)}，${String(a.date)}${a.start ? ` ${String(a.start)}-${String(a.end ?? "18")} 时` : ""}`,
  house_contact: (a) =>
    `向贝壳经纪人（ID ${String(a.agentUcid)}，${String(a.biz ?? "")}${String(a.mode) === "rent" ? "租房" : "买房"}）发起加微：${String(a.reason)}`,
};
