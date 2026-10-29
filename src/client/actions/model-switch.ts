/**
 * model-switch.ts — 目标模型上下文窗口守门
 * ============================================================
 * 参考 ZCode：切换到更小窗口模型前，用当前会话最后一次主模型 usage
 * （input+output）对比目标窗口扣除输出预留后的可用输入容量。
 * 超限时先压缩当前上下文；聊天记录仍保留，模型可见历史换成摘要。
 */
import { state } from "../core/state.js";
import { uiAlert, uiConfirm } from "../ui/dialog.js";
import { fmtTokens } from "../modules/format.js";

/** 目标模型至少要给输出保留的空间；与当前工作台常见 maxTokens 8192 对齐。 */
const MODEL_SWITCH_OUTPUT_RESERVE_TOKENS = 8_192;

export async function prepareModelSwitch(providerId: string, modelId: string): Promise<boolean> {
  const provider = (state.config?.providers || []).find((item) => item.id === providerId);
  const model = (provider?.models || []).find((item) => item.id === modelId);
  const contextWindow = model?.contextWindow;
  const sid = state.currentId;
  const used = sid ? state.usage[sid]?.contextTokens : undefined;
  if (!contextWindow || !used) return true;

  const available = Math.max(0, contextWindow - MODEL_SWITCH_OUTPUT_RESERVE_TOKENS);
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
    `当前会话上下文 ${fmtTokens(used)} tokens，超过 ${targetName} 的可用输入 ${fmtTokens(available)} tokens（窗口 ${fmtTokens(contextWindow)}，输出预留 ${fmtTokens(MODEL_SWITCH_OUTPUT_RESERVE_TOKENS)}）。\n` +
    "将先压缩当前上下文再切换；完整聊天记录仍保留。",
    { title: "压缩后切换模型", okText: "压缩并切换", danger: true }
  );
  if (!confirmed) return false;

  const { compactContext } = await import("./compact.js");
  return compactContext();
}
