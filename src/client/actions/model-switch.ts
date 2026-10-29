/**
 * model-switch.ts — 目标模型上下文窗口守门
 * ============================================================
 * 切换到更小窗口模型前，用当前会话最后一次主请求的 input usage 对比
 * 目标模型的输入预算（窗口扣除输出预留与安全余量）。
 * 超限时先压缩当前上下文；聊天记录仍保留，模型可见历史换成摘要。
 */
import { state } from "../core/state.js";
import { uiAlert, uiConfirm } from "../ui/dialog.js";
import { fmtTokens } from "../modules/format.js";

export async function prepareModelSwitch(providerId: string, modelId: string): Promise<boolean> {
  const provider = (state.config?.providers || []).find((item) => item.id === providerId);
  const model = (provider?.models || []).find((item) => item.id === modelId);
  const contextWindow = model?.contextWindow;
  const sid = state.currentId;
  const used = sid ? state.usage[sid]?.contextTokens : undefined;
  if (!contextWindow || !used) return true;

  // 预算口径以服务端随 config 下发的同一份 ContextBudget 为准；
  // 不再在前端硬编码 8192 输出预留，否则换模型后的守门会和真实裁剪不一致。
  const available = model?.contextInputBudget ?? Math.max(0, contextWindow - 8_192);
  const outputReserve = model?.outputReserveTokens ?? 8_192;
  if (used <= available) return true;
  const targetName = model?.displayName || model?.name || "目标模型";
  if (sid && state.streams[sid]) {
    uiAlert(
      `当前会话上下文 ${fmtTokens(used)} tokens，超过 ${targetName} 扣除输出预留后的可用 ${fmtTokens(available)} tokens。` +
      "请等本轮生成结束后再切换。",
      "需先压缩上下文"
    );
    return false;
  }

  const confirmed = await uiConfirm(
    `当前会话上下文 ${fmtTokens(used)} tokens，超过 ${targetName} 的可用输入 ${fmtTokens(available)} tokens（窗口 ${fmtTokens(contextWindow)}，输出预留 ${fmtTokens(outputReserve)}）。\n` +
    "将先压缩当前上下文再切换；完整聊天记录仍保留。",
    { title: "压缩后切换模型", okText: "压缩并切换", danger: true }
  );
  if (!confirmed) return false;

  const { compactContext } = await import("./compact.js");
  return compactContext();
}
