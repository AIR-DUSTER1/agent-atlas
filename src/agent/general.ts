/**
 * ============================================================
 * general.ts — 通用 Agent（应用的默认形态）
 * ============================================================
 * 产品定位：本项目不只是学习 Demo，而是一个可正常使用的 Agent 应用。
 * 这个图就是「正常使用逻辑」的合成形态，把各学习示例的能力组合到一起：
 *
 *   - ReAct 循环（示例 1）：思考 → 调用工具 → 观察结果 → 继续思考
 *   - Checkpointer 记忆（示例 2）：同一会话多轮共享上下文
 *   - 人工审批（示例 3）：send_email 等高风险工具执行前 interrupt，等用户批准
 *   - 文件上下文（files.ts）：用户 📎 附加的文件内容随消息进入上下文
 *   - 需求理解 / 澄清 / 反思（workflow.ts）：先确认需求，再执行 ReAct，最后检查结果
 *
 * 与示例的差异：示例是「拆解版」（有的故意不带 checkpointer 展示无记忆的
 * 行为差异），这里全部按真实使用的方式组装。
 */
import { calculator, getCurrentTime, getWeather, sendEmail } from "../tools.js";
import { terminal, readFileTool, writeFileTool, listDirTool, grepSearch } from "../tools-dev.js";
import { retrieveDocs } from "../tools-rag.js";
import { generalApprovals } from "./approvals.js";
import type { AgentProfile } from "./profile.js";
import { createWorkflowGraph } from "./workflow.js";

const tools = [
  // 基础工具
  calculator, getCurrentTime, getWeather, sendEmail,
  // 编程/开发工具（terminal 与 write_file 为高风险，走人工审批）
  terminal, readFileTool, writeFileTool, listDirTool, grepSearch,
  // 知识库检索（外部 RAG 服务，只读低风险，直接执行）
  retrieveDocs,
];

const SYSTEM_PROMPT = [
  "你是一个实用的中文 AI 编程助手，运行在 LangGraph.js 的 ReAct 循环上，工作目录是当前项目根。",
  "- 需要计算、查时间、查天气时调用对应工具，不要凭空编造事实",
  "- 编程任务优先使用开发工具：terminal 执行命令（构建/测试/git），read_file 读代码，" +
    "grep_search 搜索代码，list_dir 看目录结构，write_file 创建或修改文件",
  "- 用户问及项目文档、需求/设计说明、团队资料等知识库内容时，调用 retrieve_docs 检索" +
    "（外部 RAG 服务，只读）；片段带来源与分数，回答请标注来源，检索不到就如实说明",
  "- read_file / list_dir / grep_search 直接执行；terminal 和 write_file 是高风险操作，" +
    "系统会在你调用后自动请求用户确认，你无需额外追问",
  "- 用户附加了文件时，基于附件内容回答（在消息中以「--- 附件 N: 名 ---」标注，可能超长截断）",
  "- 发送邮件同样属于高风险操作，会先请求用户确认",
  "- 回答简洁准确，代码放在 Markdown 代码块里",
].join("\n");

/** 通用 profile 的能力边界：只含开发 / 知识库 / 基础工具，绝不包含 house_*。 */
export const generalProfile: AgentProfile = {
  id: "general",
  displayName: "通用 Agent",
  systemPrompt: SYSTEM_PROMPT,
  tools,
  approvalDescriptions: generalApprovals,
};

export function createAgentGraph() {
  // 模型与 checkpointer 都在建图时创建；换配置后由 sessions.rebuildIfStale 重建
  return createWorkflowGraph(generalProfile);
}
