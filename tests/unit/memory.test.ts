/**
 * memory.test.ts — 跨会话长期记忆（F1）回归
 * ============================================================
 * 守四条语义：
 *   1. 存储核心：同 key 覆盖更新（id 稳定）、上限拒绝、回放容错；
 *   2. 注入：memoryNoteForPrompt 上限 30 条 + 溢出提示，
 *      buildAgentContext 把记忆注记拼进第二条 system；
 *   3. 工具：memory_save 成功/失败都返回中文文本（不 throw 穿透图），
 *      memory_recall 关键词命中与空结果；
 *   4. 子 Agent 隔离：subagentProfileOf 剔除记忆工具。
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HumanMessage } from "@langchain/core/messages";
import {
  resetMemoryStore,
  loadMemories,
  saveMemory,
  deleteMemory,
  searchMemories,
  memoryNoteForPrompt,
  listMemories,
} from "../../src/memory-store.js";
import { memorySave, memoryRecall } from "../../src/tools-memory.js";
import { buildAgentContext } from "../../src/agent/context-builder.js";
import { subagentProfileOf } from "../../src/agent/subagent.js";
import { generalProfile } from "../../src/agent/general.js";
import type { AgentProfile } from "../../src/agent/profile.js";

const testProfile: AgentProfile = {
  id: "general",
  displayName: "测试 Agent",
  systemPrompt: "测试系统提示",
  tools: [],
  approvalDescriptions: {},
};

/** 每个用例独立临时文件（env 须在 resetMemoryStore 之前设好） */
async function freshStore(): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), "agent-mem-"));
  const file = join(dir, "memories.json");
  process.env.MEMORIES_FILE = file;
  resetMemoryStore();
  return { dir, file };
}

async function dropStore(dir: string): Promise<void> {
  delete process.env.MEMORIES_FILE;
  resetMemoryStore();
  await rm(dir, { recursive: true, force: true });
}

test("存储核心：同 key 覆盖更新，id 稳定、时间刷新", async () => {
  const { dir, file } = await freshStore();
  try {
    const first = await saveMemory("回答风格", "结论先行", "agent");
    await new Promise((r) => setTimeout(r, 5)); // updatedAt 至少可区分
    const second = await saveMemory("回答风格", "结论先行，少用列表", "user");
    assert.equal(second.id, first.id, "同 key 更新应保留稳定 id");
    assert.equal(listMemories().length, 1);
    assert.equal(listMemories()[0].content, "结论先行，少用列表");
    assert.equal(listMemories()[0].source, "user");

    // 落盘可读（小白名单全量重写）
    const persisted = JSON.parse(await readFile(file, "utf8")) as Array<{ key: string }>;
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].key, "回答风格");
  } finally {
    await dropStore(dir);
  }
});

test("存储核心：空值/超长给中文错误，delete 不存在的 id 返回 false", async () => {
  const { dir } = await freshStore();
  try {
    await assert.rejects(() => saveMemory("  ", "内容", "agent"), /主题/);
    await assert.rejects(() => saveMemory("主题", "", "agent"), /内容/);
    await assert.rejects(() => saveMemory("k".repeat(51), "内容", "agent"), /主题过长/);
    assert.equal(await deleteMemory("no-such-id"), false);
  } finally {
    await dropStore(dir);
  }
});

test("回放：坏文件不炸、降级为空记忆；正常文件恢复条目", async () => {
  const { dir, file } = await freshStore();
  try {
    await writeFile(file, "{ 不是 JSON", "utf8");
    resetMemoryStore();
    assert.equal(await loadMemories(), 0);
    assert.equal(memoryNoteForPrompt(), null);

    await writeFile(file, JSON.stringify([
      { id: "m1", key: "测试命令", content: "npm test", createdAt: 1, updatedAt: 1, source: "agent" },
      { id: "bad", key: "", content: "坏条目被跳过" },
    ]), "utf8");
    resetMemoryStore();
    assert.equal(await loadMemories(), 1);
    assert.match(memoryNoteForPrompt() ?? "", /测试命令/);
  } finally {
    await dropStore(dir);
  }
});

test("注入注记：上限 30 条 + 溢出提示；进入 buildAgentContext 的 system", async () => {
  const { dir } = await freshStore();
  try {
    for (let i = 0; i < 32; i++) {
      await saveMemory(`主题${i}`, `内容${i}`, "agent");
    }
    const note = memoryNoteForPrompt();
    assert.ok(note);
    assert.match(note, /主题31/);
    assert.ok(!note.includes("主题0") || !note.includes("主题1\n"), "最旧的两条不进注入清单");
    assert.match(note, /另有 2 条较早的记忆未注入/);

    const context = buildAgentContext({
      profile: testProfile,
      messages: [new HumanMessage("你好")],
      memoryNote: note,
    });
    const systemNotes = context.messages.filter((m) => m.getType() === "system");
    assert.equal(systemNotes.length, 2, "固定提示 + 注记 system");
    assert.match(String(systemNotes[1].content), /跨会话长期记忆/);
  } finally {
    await dropStore(dir);
  }
});

test("工具：memory_save 成功与失败都是中文文本；memory_recall 命中/空", async () => {
  const { dir } = await freshStore();
  try {
    const saved = await memorySave.invoke({ key: "称呼", content: "称呼用户为老李" });
    assert.match(String(saved), /已记住.*称呼/);

    const tooLong = await memorySave.invoke({ key: "称呼", content: "x".repeat(600) });
    assert.match(String(tooLong), /内容过长/);

    const hit = await memoryRecall.invoke({ query: "称呼" });
    assert.match(String(hit), /老李/);

    const miss = await memoryRecall.invoke({ query: "不存在的关键词" });
    assert.match(String(miss), /没有/);
  } finally {
    await dropStore(dir);
  }
});

test("检索：多词 OR 匹配、大小写不敏感", async () => {
  const { dir } = await freshStore();
  try {
    await saveMemory("Editor", "Use VSCode", "agent");
    await saveMemory("天气", "用户在北京", "agent");
    const hits = searchMemories("editor 北京");
    assert.equal(hits.length, 2);
  } finally {
    await dropStore(dir);
  }
});

test("工具挂载与子 Agent 隔离：general 挂记忆工具，子 profile 剔除", async () => {
  const names = generalProfile.tools.map((item) => item.name);
  assert.ok(names.includes("memory_save"));
  assert.ok(names.includes("memory_recall"));

  const sub = subagentProfileOf(generalProfile);
  const subNames = sub.tools.map((item) => item.name);
  assert.ok(!subNames.includes("memory_save"), "子 Agent 不能写用户长期记忆");
  assert.ok(!subNames.includes("memory_recall"));
  assert.ok(!subNames.includes("delegate_agent"), "深度 1 保持不变");
});
