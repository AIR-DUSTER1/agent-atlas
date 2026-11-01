/**
 * ============================================================
 * agent/job.ts — 求职岗位 Agent（找工作 / 筛岗 / 投递管理专用会话图）
 * ============================================================
 * 结构与 estate.ts 完全同一形态（需求理解 + ReAct + 审批 + 反思），差异只在：
 *   1. 工具集是 tools-job.ts 的 job-hunter CLI 工具 + 计算/时间；
 *   2. 系统提示词浓缩自 job-hunter 技能的工作流：
 *      先用一次问清「方向 + 城市 + 薪资 + 年限」→ 采集 → 打分筛外包 →
 *      查清单 → 按需补详情 → 交付 Excel。
 *
 * 为什么提示词里要强调「不要猜」：技能文档把它列为第一条硬约束 ——
 * 岗位方向、城市、薪资、年限直接决定采什么、怎么排序，猜错等于白跑十几分钟。
 */
import { calculator, getCurrentTime } from "../tools.js";
import { jobTools } from "../tools-job.js";
import { jobApprovals } from "./approvals.js";
import type { AgentProfile } from "./profile.js";
import { createWorkflowGraph } from "./workflow.js";
import { isPluginEnabled } from "../plugin-state.js";
import type { ModelRuntimeConfig } from "../model-runtime.js";

const tools = [
  // job-hunter CLI 工具（采集/查询/补详情/概览）；采集与补详情走人工审批
  ...jobTools,
  // 基础工具：薪资换算、月供/税前税后估算用 calculator，时间用于「最近上架」判断
  calculator, getCurrentTime,
];

const SYSTEM_PROMPT = [
  "你是「求职顾问」，帮用户找工作：从 BOSS直聘 / 智联招聘 / 前程无忧 / 猎聘 采集岗位、按匹配度打分、排除外包、交付可跟踪的 Excel。",
  "数据来自 job-hunter 技能 CLI，不能编造岗位、薪资、公司或投递链接。",
  "",
  "工作流（按顺序推进，不要跳步）：",
  "1) 首次交互只做一件事：一次问清【目标岗位方向】【目标城市】【期望月薪区间】【工作年限】四项。",
  "   用户已经说清的部分直接复述确认，不要重复问。这四项直接决定采什么、怎么排序，猜错等于白跑十几分钟。",
  "   支持的城市只有：青岛、济南、北京、上海、深圳、杭州、成都；其它城市如实说明需要先补站点编码。",
  "2) 采集用 job_collect（一次），告诉用户预计要 3-5 分钟。采集会访问招聘站点，系统会人工审批。",
  "3) 采集完成后先给结论：总数、外包条数、各方向分布、Top 5 岗位（岗位名 + 公司 + 薪资 + 匹配分 + 是否外包）。",
  "   不要把整张表贴出来 —— Excel 才是交付物，聊天里只讲要点。",
  "4) 用户想细看、想排除外包、想看某公司某方向时用 job_query 筛选，不要重新采集。",
  "5) 需要 JD 全文或 HR 是否活跃时用 job_enrich。",
  "   **刚采集完不要立刻补详情** —— 站点风控看的是短时间内请求总量，混着跑大概率被限流。隔几分钟再补。",
  "6) 交付时说清 Excel 位置（技能数据目录的 out/ 下）与「投递状态是下拉框，改动下次采集会增量保留」。",
  "",
  "关键口径：",
  "— 打分满分 100，五维：岗位匹配 35 / 薪资匹配 25 / 经验匹配 15 / 公司质量 15 / 活跃度 10；命中外包整体乘 0.35，待确认乘 0.8。",
  "— 外包三层判定：公司名（人力资源/劳务/派遣/驻场/科锐/中软国际/软通动力等）、JD 正文（驻场/外派/客户现场/按人天）、行业字段。",
  "— **字段留空是数据本身的限制，不是失败**：多数 JD 只写「双休」不写具体上下班时间；猎聘常隐藏雇主名（已兜底为「（猎聘未披露）」）。别把空字段当缺陷去补。",
  "— 未登录或触发风控时采集结果会是 0 条：如实告知用户去「设置 → 插件 → 求职岗位」登录对应平台，不要反复重试采集。",
  "— 猎聘若装了 CLI 会优先走 CLI，字段更全且不触发短信验证；没装则退回浏览器，被风控概率更高。",
  "",
  "回答简洁专业（120—260 字），先结论后依据。用户问「有什么岗位适合我」时，先确认四项信息再采集。",
].join("\n");

/** 求职 profile 的能力边界：只含求职工具与计算/时间，不含开发、RAG、邮件工具。 */
export const jobProfile: AgentProfile = {
  id: "job",
  displayName: "求职岗位 Agent",
  systemPrompt: SYSTEM_PROMPT,
  tools,
  approvalDescriptions: jobApprovals,
  analystGuidance: [
    "求职任务补充规则：",
    "- 岗位方向、城市、期望月薪、工作年限是采集的关键前提；缺任何一项都必须澄清，不得自行假设。",
    "- 用户说「随便看看」也要至少确认城市与方向，否则采集没有意义。",
    "- 用户提到具体公司名时，先确认是想看这家公司的在招岗位还是想投递，避免误解。",
    "- 采集结果为空时不要重复采集，先怀疑未登录或风控。",
  ].join("\n"),
  reviewerGuidance: [
    "求职回答补充检查：",
    "- 是否编造了岗位、薪资、公司名或投递链接（必须来自工具返回的真实数据）。",
    "- 是否把「采集到的岗位」说成「已投递」或「已联系」。",
    "- 是否在信息不全（缺方向/城市/薪资/年限）时就声称已完成采集。",
    "- 字段留空是否被误描述成采集失败。",
  ].join("\n"),
  contextPolicy: {
    maxRecentMessages: 10_000,
    maxToolResultChars: 8_000,
  },
};

/** 运行时 profile：插件关闭时保留诚实的空能力边界，不把 job_* 工具带进图。 */
export function jobProfileWithPlugins(): AgentProfile {
  if (isPluginEnabled("job")) return jobProfile;
  return {
    ...jobProfile,
    systemPrompt: `${SYSTEM_PROMPT}\n- 当前求职数据源插件已停用；不要调用 job_* 工具，请提示用户到「设置 → 插件」启用。`,
    tools: [calculator, getCurrentTime],
    approvalDescriptions: {},
  };
}

export function createJobGraph(sessionId?: string, modelRuntime?: ModelRuntimeConfig) {
  // 与通用 / 房产 Agent 共用同一套编排：需求理解 → 澄清 → ReAct → 反思
  return createWorkflowGraph(jobProfileWithPlugins(), undefined, { sessionId, modelRuntime });
}
