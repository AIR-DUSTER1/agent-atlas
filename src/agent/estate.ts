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
import { isPluginEnabled } from "../plugin-state.js";
import type { ModelRuntimeConfig } from "../model-runtime.js";

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
  "5) 找到候选后给出倾向性结论（结论 → 依据取舍 → 风险 → 下一步动作各一条）；房源明细、户型图和地理位置由前端结论表格承接，正文不要重复逐项罗列。",
  "— 区位是找房调研的默认交付：只要出现 2 个以上候选小区，必须调用 house_map 对比分布；单候选也优先调用并说明位置取舍。",
  "— 户型图同样是默认交付：对最值得推荐且已拿到真实 houseId 的房源调用 house_lookup(action=material)；拿不到图片/VR 时如实说明，不得用文字示意图冒充。",
  "— 两次调用都要保留工具结果给前端生成“房源 / 户型图 / 地理位置”对比表，不要只在最终文字里概括。",
  "— house_lookup(detail) 返回 location、house_lookup(material) 返回 images 时，前端会按 houseId 把户型图和位置放进最终结论表格。最终文字不要重复贴裸 URL，不能把已有 location 说成“地图未定位”，也不要手工画大表或暴露内部 houseId。",
  "— house_map 只用于跨小区对比；若详情已含 location.lat/lng，必须原样传入 items，禁止让 Nominatim 重新猜地址。单个候选已有详情地图时不要重复调用 house_map。",
  "— 贝壳不保证返回分间卧室面积：字段缺失时标“待核实”，用建筑面积单价作为替代口径并明确二者不同；不要编造达标结论，也不要在同一数据缺口上反复重试，流程步骤应标 skipped 并写明原因。",
  "6) 结论文字只讲首选、取舍、命中/未命中与风险；前端表格会展示 3—5 条房源的租金、户型、户型图和位置。禁止输出连续 8 位以上的 houseId / 房源编号，用小区名 + 户型 + 面积 + 租金标识房源。",
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
    "- 城市与租买方向常常同时缺失：放进同一个 questions 数组一次问完，不要分两轮追。",
    "- 预算、区域、通勤、户型可在用户说「先随便看看」时放宽，不要连续追问。",
    "- 预约带看缺少真实 houseId、日期或时段时不得把动作视为可执行。",
    "- 经纪人 ID 必须来自真实工具结果，禁止用姓名或推断值替代。",
  ].join("\n"),
  reviewerGuidance: [
    "房产回答补充检查：",
    "- 是否混淆租房与买房、具体房源价格与宏观均价。",
    "- 是否编造房源、价格、houseId、经纪人 ID、图片或链接。最终回答出现原始 houseId / 连续 8 位以上内部编号时判失败。",
    "- 是否把未审批、未执行的预约或加微描述成已完成。",
    "- 工具结果已有 location/images 时，回答不得再声称无法定位；前端会按 houseId 在最终结论表格中展示对应户型图与位置，不要求文字重复链接。",
    "- 数据源确实缺少分间面积时，如实标待核实并给出替代口径不算失败；编造达标或对同一缺口无限重试才失败。",
    "- 地图定位来源、行情口径和统计限制是否如实说明。",
  ].join("\n"),
  contextPolicy: {
    maxRecentMessages: 10_000,
    maxToolResultChars: 5_000,
  },
};

/** 运行时 profile：插件关闭时保留诚实的空能力边界，不把 house_* 工具带进图。 */
export function estateProfileWithPlugins(): AgentProfile {
  if (isPluginEnabled("estate")) return estateProfile;
  return {
    ...estateProfile,
    systemPrompt: `${SYSTEM_PROMPT}\n- 当前找房数据源插件已停用；不要调用 house_* 工具，请提示用户到「设置 → 插件」启用。`,
    tools: [calculator, getCurrentTime],
    approvalDescriptions: {},
  };
}

export function createEstateGraph(sessionId?: string, modelRuntime?: ModelRuntimeConfig) {
  // 与通用 Agent 共用同一套编排：需求理解 → 澄清 → ReAct → 反思
  return createWorkflowGraph(estateProfileWithPlugins(), undefined, { sessionId, modelRuntime });
}
