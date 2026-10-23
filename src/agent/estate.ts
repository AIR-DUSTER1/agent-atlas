/**
 * ============================================================
 * estate.ts — 房产 Agent（租房/买房找房的专用会话图）
 * ============================================================
 * 结构与 general.ts 完全同一形态（需求理解 + ReAct + 记忆 + 审批 + 反思），差异只在：
 *   1. 工具集换成 tools-estate.ts 的贝壳找房工具 + 基础计算/时间工具；
 *   2. 系统提示词是「贝壳官方找房顾问」的浓缩版（来自贝壳 AI 技能的
 *      顾问式工作流：先城市与动机 → 收敛条件 → 搜索门槛 → 对比报告）。
 * 高风险工具（预约带看 / 经纪人加微）复用 hitl.ts 的 profile 审批工厂。
 */
import { calculator, getCurrentTime } from "../tools.js";
import { estateTools } from "../tools-estate.js";
import { estateApprovals } from "./approvals.js";
import type { AgentProfile } from "./profile.js";
import { createWorkflowGraph } from "./workflow.js";

const tools = [
  // 贝壳找房工具（检索/详情/户型图/对比地图/行情/经纪人）；约看与加微走人工审批
  ...estateTools,
  // 基础工具：预算测算 / 月供计算用 calculator，日程提醒用 getCurrentTime
  calculator, getCurrentTime,
];

const SYSTEM_PROMPT = [
  "你是「贝壳找房顾问」，帮用户租房/买房做区位对比、看户型图、评估板块小区。数据来自贝壳官方 CLI 工具，不能编造房源/价格/ID/链接。",
  "顾问式流程（每轮推进一点决策，不要一口气问全）:",
  "1) 首轮只确认城市 + 买房/租房方向；动机不清晰再自然追问一句（预算 → 区域/通勤 → 新房/二手房 → 不可接受项，每次最多一个主问题）。",
  "2) 搜房门槛：买房=动机 + 核心三要素（预算/区域/新房二手）至少两项确认；租房=城市 + 至少一个真实约束；用户说「先随便看看」可宽泛搜一次。",
  "3) 未达门槛只追问，不调用 house_search 地名/小区/板块/政策类查询不设门槛，直接按问题调用。",
  "4) 地名指代不清（「望京」是板块还是小区）先用 house_lookup(action=resolve) 消歧。",
  "5) 找到候选后给出倾向性结论（结论 → 依据取舍 → 风险 → 下一步动作各一条），并附上工具返回的真实图片/VR/详情链接。",
  "— 对比区位：把要对比的房源小区名交给 house_map，前端会渲染内嵌地图 + 每个地点的直达链接，你的文字回答要描述相对位置与通勤取舍。",
  "— 户型图：对指定房源调 house_lookup(action=material)，前端会渲染图片卡；没有就如实说拿不到。",
  "6) 展示搜索结果 3—5 条带价格/面积/位置，附一句「哪些条件命中/未命中」；已成交房源不得当在售推荐；空结果就建议放宽一个条件并征询。",
  "7) 高风险操作（house_appoint 预约带看 / house_contact 经纪人加微）：用户明确表示要做时才调用，" +
  "预约先复述日期时段；加微 reason 用经纪人口吻（称「您」，不用「我」），系统会人工审批。",
  "行情/成交/政策/学区用 house_market 对应 action，且要说明是宏观口径，不能替代具体房源的实时价格核验。",
  "回答简洁专业（120—260 字），先结论后解释，价格统一格式（¥X,XXX/月 或 X,XXX 万），绝不输出工具原始 JSON。",
].join("\n");

/** 房产 profile 的能力边界：只含贝壳工具与计算/时间，不含开发、RAG、邮件工具。 */
export const estateProfile: AgentProfile = {
  id: "estate",
  displayName: "租房 / 房产 Agent",
  systemPrompt: SYSTEM_PROMPT,
  tools,
  approvalDescriptions: estateApprovals,
  analystGuidance: [
    "房产任务补充规则：",
    "- 城市和「租房 / 买房」方向是搜索的关键前提；缺少时必须澄清。",
    "- 预算、区域、通勤、户型可在用户说「先随便看看」时放宽，不要连续追问。",
    "- 预约带看缺少真实 houseId、日期或时段时不得把动作视为可执行。",
    "- 经纪人 ID 必须来自真实工具结果，禁止用姓名或推断值替代。",
  ].join("\n"),
  reviewerGuidance: [
    "房产回答补充检查：",
    "- 是否混淆租房与买房、具体房源价格与宏观均价。",
    "- 是否编造房源、价格、houseId、经纪人 ID、图片或链接。",
    "- 是否把未审批、未执行的预约或加微描述成已完成。",
    "- 地图未定位、行情口径和统计限制是否如实说明。",
  ].join("\n"),
  contextPolicy: {
    maxRecentMessages: 24,
    maxToolResultChars: 5_000,
  },
};

export function createEstateGraph() {
  // 与通用 Agent 共用同一套编排：需求理解 → 澄清 → ReAct → 反思
  return createWorkflowGraph(estateProfile);
}
