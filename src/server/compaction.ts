/**
 * compaction.ts — 会话上下文压缩（/compact）
 * ============================================================
 * 把当前会话的 turnHistory 压成一段摘要，随后重建图 / 换 threadId，
 * 下一轮真图调用只注入摘要而不是全部旧消息。
 * 模型摘要失败（无 Key / 网关异常 / 超时）时退回本地摘录，保证命令始终可用。
 */
import { randomUUID } from "node:crypto";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { config } from "../config.js";
import { createChatModel } from "../llm.js";
import { clearModelRetryRecords, invokeWithModelRetry } from "../model-retry.js";
import { getCheckpointSaver } from "../checkpoint.js";
import { log } from "./logging.js";
import { buildGraph, currentConfigVersion, type Session, type TurnRecord } from "./sessions.js";
import { journalCompact } from "./session-store.js";

const MAX_TRANSCRIPT_CHARS = 80_000; // 送进摘要模型的原文上限
const MAX_SUMMARY_CHARS = 4_000;     // 摘要最终落库上限
const MAX_SUMMARY_TURNS = 40;        // 最多取最近多少轮
const COMPACT_TIMEOUT_MS = 60_000;   // 模型摘要超时

export interface CompactResult {
  summary: string;
  beforeChars: number;
  afterChars: number;
  usedModel: boolean;
}

function assistantText(record: TurnRecord): string {
  const ai = record.events
    .filter((event) => event.type === "ai_message")
    .map((event) => (event as { content: string }).content.trim())
    .filter(Boolean);
  if (ai.length) return ai.join("\n");
  return record.events
    .filter((event) => event.type === "token")
    .map((event) => (event as { text: string }).text)
    .join("")
    .trim();
}

/** 从最新一轮往前取，确保超长会话也优先保留最近上下文 */
function buildTranscript(records: TurnRecord[]): { transcript: string; beforeChars: number } {
  const blocks: string[] = [];
  let chars = 0;
  for (let i = records.length - 1; i >= 0 && blocks.length < MAX_SUMMARY_TURNS; i -= 1) {
    const record = records[i];
    const ai = assistantText(record);
    const block = `【用户】${record.user}\n【助手】${ai || "（本轮没有文本输出）"}`;
    if (chars + block.length > MAX_TRANSCRIPT_CHARS) {
      if (!blocks.length) blocks.push(block.slice(0, MAX_TRANSCRIPT_CHARS));
      break;
    }
    blocks.push(block);
    chars += block.length;
  }
  blocks.reverse();
  return { transcript: blocks.join("\n\n"), beforeChars: chars };
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part) {
        return String((part as { text?: unknown }).text ?? "");
      }
      return "";
    })
    .join("");
}

async function summarizeWithModel(transcript: string, sessionId: string): Promise<string> {
  const model = createChatModel(0, { sessionId });
  try {
    // 压缩也走同一重试策略；这里没有 SSE 消费者，结束后必须清空观测队列。
    const response = await invokeWithModelRetry(
      () => model.invoke([
        new SystemMessage(
          "你是会话上下文压缩器。把用户与助手的对话压缩成一段中文摘要，供后续对话继续使用。" +
          "必须保留：用户目标、已确认的事实与偏好、涉及的文件/路径、工具执行的关键结论、待办与未决问题。" +
          "不要编造，不要输出寒暄或 Markdown 标题，直接输出摘要正文。"
        ),
        new HumanMessage(transcript),
      ], { signal: AbortSignal.timeout(COMPACT_TIMEOUT_MS) }),
      { sessionId }
    );
    return contentToText(response.content).trim();
  } finally {
    clearModelRetryRecords(sessionId);
  }
}

/** 无模型时退回本地摘录：保留最近用户诉求与助手结论，仍能显著缩小注入体积 */
function localSummary(records: TurnRecord[]): string {
  const lines = records.slice(-12).map((record) => {
    const ai = assistantText(record).slice(0, 500);
    return `- 用户：${record.user.slice(0, 300)}${ai ? `\n  助手：${ai}` : ""}`;
  });
  return `较早对话摘录（未调用模型）：\n${lines.join("\n")}`;
}

export async function compactSession(session: Session): Promise<CompactResult> {
  if (session.kind === "external") throw new Error("外部 Agent 会话不支持压缩上下文");
  if (session.pendingApproval) throw new Error("当前会话有待审批或待确认操作，请先处理后再压缩上下文");
  if (!session.turnHistory.length) throw new Error("当前会话还没有可压缩的对话");

  const { transcript, beforeChars } = buildTranscript(session.turnHistory);
  if (!transcript.trim()) throw new Error("当前会话还没有可压缩的文本内容");

  let summary = "";
  let usedModel = false;
  if (config.apiKey) {
    try {
      summary = await summarizeWithModel(transcript, session.threadId);
      usedModel = Boolean(summary);
    } catch (err) {
      log("warn", "context_compact_failed", {
        sessionId: session.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (!summary) summary = localSummary(session.turnHistory);
  summary = summary.slice(0, MAX_SUMMARY_CHARS);

  // 旧图 / 旧 threadId 的线程记忆处理：产品图的持久检查点随换线程一并删除
  // （摘要已接管上下文，旧 thread 留在 checkpoints.ndjson 只会无限增长）；
  // 新线程以注入的摘要为起点，模型不再看到被压缩掉的原始消息。
  const nextThreadId = `web-${randomUUID()}`;
  const compactedTurnId = session.turnHistory.at(-1)?.turnId ?? null;
  if (session.kind === "agent" || session.kind === "estate") {
    void getCheckpointSaver().deleteThread(session.threadId);
  }
  session.graph = buildGraph(session.kind, session.demo, nextThreadId);
  session.threadId = nextThreadId;
  session.configVersion = currentConfigVersion();
  session.pendingApproval = null;
  session.resumeUninjected = false;
  session.contextSummary = summary;
  session.contextSummaryInjected = false;
  session.lastCompactTurnId = compactedTurnId;
  journalCompact(session.id, nextThreadId, summary, {
    beforeChars,
    afterChars: summary.length,
    usedModel,
    lastCompactTurnId: compactedTurnId,
  });

  return {
    summary,
    beforeChars,
    afterChars: summary.length,
    usedModel,
  };
}
