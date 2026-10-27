/**
 * checkpoint.test.ts — 持久化检查点（F0）回归
 * ============================================================
 * 守四条语义：
 *   1. put/putWrites 落盘后，新实例回放能还原同一 thread 状态
 *      （含消息类实例：不能退化成 plain object）；
 *   2. deleteThread 的效果跨实例成立（删了就是删了）；
 *   3. 坏行（硬杀半行）跳过不炸，其余行照常回放；
 *   4. 图级「重启续聊」：两个 saver 实例 = 两次进程生命，
 *      第二实例上的新图第三轮仍能看到第一实例写入的消息；
 *   5. compact 只按行格式过滤：删线程整组丢弃、每线程留最近 K 个。
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HumanMessage } from "@langchain/core/messages";
import { AIMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import {
  PersistentSaver,
  getCheckpointSaver,
  resetCheckpointSaver,
} from "../../src/checkpoint.js";
import { createWorkflowGraph, type WorkflowChatModel } from "../../src/agent/workflow.js";
import type { AgentProfile } from "../../src/agent/profile.js";

const testProfile: AgentProfile = {
  id: "general",
  displayName: "测试 Agent",
  systemPrompt: "测试系统提示",
  tools: [],
  approvalDescriptions: {},
};

const ANALYSIS_OK = JSON.stringify({
  understood: true,
  brief: "测试需求",
  question: "",
  options: [],
});
const REVIEW_OK = JSON.stringify({ passes: true, reason: "通过", feedback: "" });

/** 记录收到的 invoke 输入的假模型（FakeListChatModel 不暴露输入，这里自己攒一个） */
class SpyModel {
  seen: unknown[] = [];
  private index = 0;
  constructor(private readonly replies: string[]) {}
  async invoke(input: unknown): Promise<AIMessage> {
    this.seen.push(input);
    const reply = this.replies[this.index];
    this.index += 1;
    return new AIMessage(reply ?? "（回复耗尽）");
  }
}

function spyModels(agent: SpyModel): { agent: unknown; analyst: unknown; reviewer: unknown } {
  return { agent, analyst: agent, reviewer: agent };
}

test("持久化往返：消息类实例跨进程生命不丢", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-ckpt-"));
  const file = join(dir, "checkpoints.ndjson");
  try {
    const saverA = new PersistentSaver(file);
    await saverA.loadFromDisk();
    await saverA.put(
      { configurable: { thread_id: "th-rt" } },
      {
        v: 4,
        id: "ckpt-0001",
        ts: "2026-01-01T00:00:00.000Z",
        channel_values: { messages: [new HumanMessage("我叫小明"), new AIMessage("你好小明")] },
        channel_versions: {},
        versions_seen: {},
      } as never,
      { source: "loop", step: 1, writes: null, parents: {} } as never
    );
    await saverA.flush();

    const saverB = new PersistentSaver(file);
    await saverB.loadFromDisk();
    assert.equal(saverB.hasThread("th-rt"), true);
    const tuple = await saverB.getTuple({ configurable: { thread_id: "th-rt" } });
    assert.ok(tuple, "回放后应能取到该 thread 的最新检查点");
    const messages = (tuple.checkpoint as { channel_values?: { messages?: unknown[] } })
      .channel_values?.messages as Array<{ constructor: { name: string }; content: unknown }>;
    assert.ok(Array.isArray(messages) && messages.length === 2);
    // 消息类必须还原成 LangChain 实例，否则后续轮次的模型请求会把它们当成裸对象
    assert.equal(typeof messages[0].constructor?.name, "string");
    assert.match(String(messages[0].constructor.name), /HumanMessage/);
    assert.match(String(messages[1].constructor.name), /AIMessage/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("deleteThread 跨实例生效", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-ckpt-"));
  const file = join(dir, "checkpoints.ndjson");
  try {
    const saverA = new PersistentSaver(file);
    await saverA.put(
      { configurable: { thread_id: "th-gone" } },
      {
        v: 4,
        id: "ckpt-0001",
        ts: "2026-01-01T00:00:00.000Z",
        channel_values: {},
        channel_versions: {},
        versions_seen: {},
      } as never,
      { source: "loop", step: 1, writes: null, parents: {} } as never
    );
    await saverA.deleteThread("th-gone");
    await saverA.flush();

    const saverB = new PersistentSaver(file);
    await saverB.loadFromDisk();
    assert.equal(saverB.hasThread("th-gone"), false);
    assert.equal(await saverB.getTuple({ configurable: { thread_id: "th-gone" } }), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("坏行容错：半行 JSON 被跳过，其余行照常回放", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-ckpt-"));
  const file = join(dir, "checkpoints.ndjson");
  try {
    // 先用真实 saver 产生一行有效日志
    const saver = new PersistentSaver(file);
    await saver.put(
      { configurable: { thread_id: "th-ok" } },
      {
        v: 4,
        id: "ckpt-0001",
        ts: "2026-01-01T00:00:00.000Z",
        channel_values: {},
        channel_versions: {},
        versions_seen: {},
      } as never,
      { source: "loop", step: 1, writes: null, parents: {} } as never
    );
    await saver.flush();
    // 尾部「追加」垃圾行与半行（模拟硬杀；不能用 writeFile，会覆盖掉有效行）
    await writeFile(file, "不是 JSON\n" + '{"type":"ckpt","thread":"th-x', { encoding: "utf8", flag: "a" });

    const reloaded = new PersistentSaver(file);
    await reloaded.loadFromDisk(); // 不抛错即通过
    assert.equal(reloaded.hasThread("th-ok"), true);
    assert.equal(reloaded.hasThread("th-x"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("图级重启续聊：第二个 saver 实例上的新图仍记得第一实例的消息", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-ckpt-"));
  const file = join(dir, "checkpoints.ndjson");
  // 落盘是 fire-and-forget：没有引用的 saver 可能在 rm 之后才把文件写回来
  // （先删掉 ndjson、再 rmdir 时撞 ENOTEMPTY —— Linux CI 上稳定复现，Windows 上常侥幸赢下竞速）
  let saverA: PersistentSaver | undefined;
  let saverB: PersistentSaver | undefined;
  try {
    // —— 第一次「进程生命」：两轮对话落盘 ——
    const round1 = new SpyModel([ANALYSIS_OK, "你好，小明。", REVIEW_OK]);
    saverA = new PersistentSaver(file);
    const graphA = createWorkflowGraph(testProfile, spyModels(round1) as never, {
      checkpointer: saverA,
    });
    const thread = "th-restart";
    await graphA.invoke(
      { messages: [new HumanMessage("我叫小明")] },
      { configurable: { thread_id: thread } }
    );
    // 落盘是 fire-and-forget：等写链清空，模拟「优雅退出」后再重启
    await saverA.flush();

    // —— 第二次「进程生命」：全新 saver + 全新图实例，续问 ——
    saverB = new PersistentSaver(file);
    await saverB.loadFromDisk();
    assert.equal(saverB.hasThread(thread), true, "重启前必须已把线程落盘");
    const round2 = new SpyModel([ANALYSIS_OK, "你还记得我。", REVIEW_OK]);
    const graphB = createWorkflowGraph(testProfile, spyModels(round2) as never, {
      checkpointer: saverB,
    });
    const result = await graphB.invoke(
      { messages: [new HumanMessage("我叫什么名字？")] },
      { configurable: { thread_id: thread } }
    ) as unknown as { messages: Array<{ content: unknown }> };

    // 模型侧：第二轮收到的上下文里必须有第一轮的消息（记忆跨实例延续）
    const seenText = JSON.stringify(round2.seen);
    assert.match(seenText, /我叫小明/, "新实例的模型输入应包含重启前的用户消息");

    // 状态侧：最终 messages 是两轮的累积
    const contents = result.messages.map((message) => String(message.content));
    assert.ok(contents.some((text) => text.includes("我叫小明")));
    assert.ok(contents.some((text) => text.includes("我叫什么名字")));
  } finally {
    // 必须先等两个实例把在途追加写完再删目录，否则 rmdir 会撞 ENOTEMPTY
    await saverA?.flush();
    await saverB?.flush();
    await rm(dir, { recursive: true, force: true });
  }
});

test("compact：删线程整组丢弃、每线程只留最近 K 个检查点", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-ckpt-"));
  const file = join(dir, "checkpoints.ndjson");
  try {
    // 手工构造行（compact 只按行格式过滤，不反序列化载荷，可以塞占位字节）
    const ckpt = (thread: string, id: string) =>
      JSON.stringify({
        type: "ckpt", thread, ns: "", id, ckptType: "json",
        ckpt: "e30=", metaType: "json", meta: "e30=",
      });
    const write = (thread: string, ckptId: string) =>
      JSON.stringify({
        type: "write", thread, ns: "", ckptId, taskId: "task-1",
        entries: [{ channel: "messages", t: "json", v: "e30=" }],
      });
    const ids = Array.from({ length: 12 }, (_, i) => `ckpt-${String(i).padStart(4, "0")}`);
    const lines = [
      ...ids.map((id) => ckpt("th-keep", id)),        // 12 个 → compact 后留最近 10 个
      write("th-keep", ids[0]),                        // 指向将被丢弃的最旧检查点 → 应消失
      write("th-keep", ids[11]),                       // 指向保留的最新检查点 → 应保留
      ckpt("th-dead", "ckpt-0001"),                    // 后被 delete → 整组消失
      JSON.stringify({ type: "delete", thread: "th-dead" }),
    ];
    await writeFile(file, lines.join("\n") + "\n", "utf8");

    const saver = new PersistentSaver(file);
    await saver.compactNow();
    const compacted = await readFile(file, "utf8");
    const rows = compacted.split("\n").filter(Boolean).map((line) => JSON.parse(line) as {
      type: string; thread: string; id?: string; ckptId?: string;
    });

    const kept = rows.filter((r) => r.type === "ckpt" && r.thread === "th-keep");
    assert.equal(kept.length, 10, "每线程只留最近 10 个检查点");
    assert.ok(kept.every((r) => r.id !== ids[0] && r.id !== ids[1]), "最旧两个被丢弃");
    assert.ok(rows.some((r) => r.type === "write" && r.ckptId === ids[11]), "指向保留检查点的写行保留");
    assert.ok(!rows.some((r) => r.type === "write" && r.ckptId === ids[0]), "指向丢弃检查点的写行消失");
    assert.ok(!rows.some((r) => r.thread === "th-dead"), "已删除线程的行整组消失");
    assert.ok(!rows.some((r) => r.type === "delete"), "delete 行使命完成，不再保留");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("单例工厂：CHECKPOINT_FILE 钩子 + resetCheckpointSaver 重建", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-ckpt-"));
  const file = join(dir, "checkpoints.ndjson");
  try {
    process.env.CHECKPOINT_FILE = file;
    resetCheckpointSaver();
    const saver = getCheckpointSaver();
    assert.equal(saver.hasThread("th-single"), false);
    resetCheckpointSaver();
    assert.notEqual(getCheckpointSaver(), saver, "reset 后应产生新实例");
  } finally {
    resetCheckpointSaver();
    delete process.env.CHECKPOINT_FILE;
    await rm(dir, { recursive: true, force: true });
  }
});

// 隔离副作用：本文件若有人在别处建过单例，别让默认路径泄进真实 .setting/
test("MemorySaver 仍是 workflow 图可注入的轻量选项（编译冒烟）", () => {
  const graph = createWorkflowGraph(testProfile, undefined, { checkpointer: new MemorySaver() });
  assert.ok(graph);
});

test("检查点 compact 后重启续聊仍保留完整会话上下文", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-ckpt-compact-context-"));
  const file = join(dir, "checkpoints.ndjson");
  let saverA: PersistentSaver | undefined;
  let saverB: PersistentSaver | undefined;
  try {
    saverA = new PersistentSaver(file);
    const graphA = createWorkflowGraph(testProfile, spyModels(new SpyModel([ANALYSIS_OK, "记住你叫小明。", REVIEW_OK])) as never, { checkpointer: saverA });
    const thread = "th-compact-context";
    await graphA.invoke({ messages: [new HumanMessage("我叫小明，请记住")] }, { configurable: { thread_id: thread } });
    const graphA2 = createWorkflowGraph(testProfile, spyModels(new SpyModel([ANALYSIS_OK, "好的。", REVIEW_OK])) as never, { checkpointer: saverA });
    await graphA2.invoke({ messages: [new HumanMessage("我们继续聊")] }, { configurable: { thread_id: thread } });
    await saverA.flush();
    const graphA3 = createWorkflowGraph(testProfile, spyModels(new SpyModel([ANALYSIS_OK, "继续。", REVIEW_OK])) as never, { checkpointer: saverA });
    await graphA3.invoke({ messages: [new HumanMessage("第三轮继续")] }, { configurable: { thread_id: thread } });
    await saverA.flush();
    await saverA.compactNow();
    await saverA.flush();

    saverB = new PersistentSaver(file);
    await saverB.loadFromDisk();
    const model = new SpyModel([ANALYSIS_OK, "你叫小明。", REVIEW_OK]);
    const graphB = createWorkflowGraph(testProfile, spyModels(model) as never, { checkpointer: saverB });
    await graphB.invoke({ messages: [new HumanMessage("我叫什么？")] }, { configurable: { thread_id: thread } });
    assert.match(JSON.stringify(model.seen), /我叫小明/);
    assert.match(JSON.stringify(model.seen), /我们继续聊/);
  } finally {
    await saverA?.flush();
    await saverB?.flush();
    await rm(dir, { recursive: true, force: true });
  }
});