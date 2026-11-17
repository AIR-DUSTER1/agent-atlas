/**
 * workflow/nodes/stop-notice.ts — 工具要求终止时的用户收尾节点
 * ============================================================
 * 认证失效属于“需要人处理”而不是“任务做完了”，静默 END 会让界面只剩红色失败卡。
 */
import { AIMessage } from "@langchain/core/messages";
import { stopNoticeText } from "../message-utils.js";
import { latestToolStopResult } from "../../turn-stop.js";
import type { WorkflowStateType } from "../state.js";

export function createStopNoticeNode() {
  return async function stopNoticeNode(state: WorkflowStateType) {
    const stop = latestToolStopResult(state.messages);
    if (!stop) return {};
    return { messages: [new AIMessage(stopNoticeText(stop))] };
  };
}