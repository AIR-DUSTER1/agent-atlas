/**
 * ============================================================
 * actions/compact.ts — 压缩上下文（/compact）
 * ============================================================
 * 职责：把当前会话压成摘要（服务端调用模型），并在消息流里插入一条
 * notice 块展示前后字符数与摘要。
 * 设计立场：
 *  - compacting 与 streaming 只对同一会话互斥；不同会话仍可并行；
 *  - 失败不抛穿透：notice 块改成「压缩失败」并展示原因，用户可继续聊；
 *  - 压缩成功后清掉本地 usage（上下文已重算），容量条随之隐藏。
 */

import { autoGrowImpl } from "../core/dom.js";
import { api } from "../core/api.js";
import { saveLocal, state, transcript } from "../core/state.js";
import { uiAlert } from "../ui/dialog.js";
import { mountBlock, renderNoticeBlock } from "../render/messages.js";
import { scrollBottom } from "../core/dom.js";
import { syncComposerState } from "../stream/turn.js";
import { updateContextBar } from "../views/composer-bar.js";
import type { NoticeBlock } from "../modules/types.js";

export async function compactContext(): Promise<void> {
  const sid = state.currentId;
  if (!sid || state.streams[sid] || state.compacting[sid]) return;
  const cur = state.sessions.find((s) => s.id === sid);
  if (cur?.stale) { uiAlert("历史会话不可压缩，请新建会话", "提示"); return; }

  const block: NoticeBlock = {
    t: "notice",
    title: "正在压缩上下文",
    text: "正在把当前会话整理成摘要，请稍候…",
    loading: true,
  };
  state.compacting[sid] = true;
  transcript(sid).push(block);
  mountBlock(block);
  scrollBottom(true);
  syncComposerState(sid);

  try {
    const res = await api<{ beforeChars?: number; afterChars?: number; summary?: string }>(
      `/api/sessions/${sid}/compact`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }
    );
    block.loading = false;
    block.title = "上下文已压缩";
    block.text = `原对话约 ${Number(res.beforeChars || 0).toLocaleString("zh-CN")} 字符 → 摘要 ${Number(res.afterChars || 0).toLocaleString("zh-CN")} 字符。后续对话会自动使用这份摘要。`;
    block.summary = res.summary || "";
    renderNoticeBlock(block);
    delete state.usage[sid];
    if (sid === state.currentId) updateContextBar();
  } catch (err) {
    block.loading = false;
    block.title = "压缩失败";
    block.text = (err as Error).message;
    renderNoticeBlock(block);
  } finally {
    delete state.compacting[sid];
    syncComposerState(sid);
    saveLocal();
    if (sid === state.currentId) autoGrowImpl();
  }
}
