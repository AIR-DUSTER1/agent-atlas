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
  browser_act: (a) => {
    const action = String(a.action ?? "操作");
    if (action === "press") return `在 Browser Use 页面发送按键 ${String(a.key ?? "未指定")}`;
    if (action === "type") return `在 Browser Use 元素 ${String(a.ref ?? "未指定")} 输入 ${String(a.text ?? "").length} 字符${a.submit ? "并提交" : ""}`;
    if (action === "select") return `在 Browser Use 元素 ${String(a.ref ?? "未指定")} 选择 ${String(a.value ?? "未指定")}`;
    return `点击 Browser Use 页面元素 ${String(a.ref ?? "未指定")}`;
  },
  delegate_agent: (a) => {
    const tools = Array.isArray(a.tools) ? a.tools.map(String).filter(Boolean) : [];
    const prompt = String(a.prompt ?? "").replace(/\s+/g, " ").slice(0, 120);
    return `委派子代理 ${String(a.agent ?? "未指定")}：${String(a.task ?? "").slice(0, 80)}；` +
      `工具 ${tools.join("、") || "无"}；专项提示词「${prompt || "未提供"}」` +
      "（一次委派 = 多轮模型调用，子代理在独立上下文中自动执行所选工具）";
  },
};

export const estateApprovals: ApprovalDescriptions = {
  house_appoint: (a) =>
    `提交贝壳带看预约：房源 ${String(a.houseId)}，${String(a.date)}${a.start ? ` ${String(a.start)}-${String(a.end ?? "18")} 时` : ""}`,
  house_contact: (a) =>
    `向贝壳经纪人（ID ${String(a.agentUcid)}，${String(a.biz ?? "")}${String(a.mode) === "rent" ? "租房" : "买房"}）发起加微：${String(a.reason)}`,
};

export const jobApprovals: ApprovalDescriptions = {
  job_collect: (a) => {
    const keywords = Array.isArray(a.keywords) ? a.keywords.map(String).filter(Boolean).join("、") : "";
    const salary = typeof a.salaryMin === "number" && typeof a.salaryMax === "number"
      ? `${a.salaryMin}-${a.salaryMax}K`
      : "未指定薪资";
    const platforms = Array.isArray(a.platforms) && a.platforms.length ? a.platforms.map(String).join("、") : "四平台全部";
    return `抓取招聘岗位：${String(a.city ?? "未指定城市")} / ${keywords || "未指定方向"} / ${salary} / ` +
      `${String(a.years ?? "?")} 年经验；平台 ${platforms}（约 3-5 分钟，会访问招聘站点）`;
  },
  job_enrich: (a) =>
    `补岗位详情：逐条打开岗位页抓 JD 全文、地址与 HR 活跃（最多 ${String(a.limit ?? 10)} 条，会访问招聘站点）`,
  job_diagnose: (a) => {
    const platforms = Array.isArray(a.platforms) && a.platforms.length ? a.platforms.map(String).join("、") : "四平台全部";
    return `诊断招聘站点结构：${platforms}${a.apply === true ? "，并固化真实验证通过的选择器（会写入 selectors.json）" : "，只读检查，不固化选择器"}`;
  },
  job_greet_save: (a) => {
    const count = Array.isArray(a.items) ? a.items.length : 0;
    return `写回招呼语：${count} 条，更新求职岗位清单并重新生成 Excel 报告（只写本地数据目录）`;
  },
};
