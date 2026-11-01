/**
 * ============================================================
 * agent/domain-profile.ts — 子代理继承哪个领域 profile
 * ============================================================
 * 职责：把「领域 profile 标识」解析成可复用的提示词与规则来源。
 *
 * 为什么需要它：`buildSubagentProfile()` 原先只用通用的「后台子代理」规则
 * 加主 Agent 临时给的 prompt。路由到房产子代理后，它不知道贝壳顾问工作流
 * （首轮只确认城市与方向、搜索门槛、不得编造 houseId），质量必然低于直接
 * 开一个房产会话。这里把领域知识以「解析函数」的形式暴露，避免
 * tools-team → general 的循环依赖。
 *
 * 设计立场：
 *  - 只返回「提示词与规则」这一部分，不返回工具：工具仍由主 Agent 每次显式赋予，
 *    能力边界不因为继承领域 profile 而放宽；
 *  - general 不在这里登记：它就是默认的后台子代理规则（见 tools-team.ts），
 *    额外登记一份只会造成两处漂移。
 */
import { estateProfileWithPlugins } from "./estate.js";
import type { AgentProfile, AgentProfileId } from "./profile.js";

/** 领域 profile 的提示词来源；null = 使用默认子代理规则。 */
export function resolveDomainProfile(id: AgentProfileId | undefined): AgentProfile | null {
  if (id === "estate") return estateProfileWithPlugins();
  return null;
}
