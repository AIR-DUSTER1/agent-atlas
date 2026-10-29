/**
 * memory.test.ts — 长期记忆作用域、迁移与工具隔离回归
 * ============================================================
 * 守：v1 数组无损升级 v2、坏文件隔离、general/estate 不互读、
 * workflow 只注入当前 profile 的记忆，以及工具写入不越界。
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
  listMemoriesAsync,
  memoryStoreStatus,
} from "../../src/memory-store.js";
import { memorySave, memoryRecall, createMemoryTools } from "../../src/tools-memory.js";
import { buildAgentContext } from "../../src/agent/context-builder.js";
import { subagentProfileOf } from "../../src/agent/subagent.js";
import { generalProfile } from "../../src/agent/general.js";
import { estateProfile } from "../../src/agent/estate.js";
import type { AgentProfile } from "../../src/agent/profile.js";

const testProfile: AgentProfile = {
  id: "general",
  displayName: "测试 Agent",
  systemPrompt: "测试系统提示",
  tools: [],
  approvalDescriptions: {},
};

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

test("v1 数组自动迁移 v2：原字段保留，旧记忆默认归入 general", async () => {
  const { dir, file } = await freshStore();
  try {
    await writeFile(file, JSON.stringify([
      { id: "m1", key: "测试命令", content: "npm test", createdAt: 1, updatedAt: 2, source: "agent" },
    ]), "utf8");
    resetMemoryStore();
    assert.equal(await loadMemories("general"), 1);
    assert.equal(memoryStoreStatus().state, "migrated");
    assert.equal(memoryStoreStatus().migratedFrom, 1);
    const general = await listMemoriesAsync("general");
    assert.equal(general[0].id, "m1");
    assert.deepEqual(general[0].scope, { profileId: "general", userId: "local" });
    assert.equal(general[0].status, "active");

    const persisted = JSON.parse(await readFile(file, "utf8")) as {
      schemaVersion: number;
      entries: Array<{ scope: { profileId: string } }>;
    };
    assert.equal(persisted.schemaVersion, 2);
    assert.equal(persisted.entries[0].scope.profileId, "general");
    assert.equal(await loadMemories("estate"), 0, "旧数据不能被房产 Agent 继承");
  } finally {
    await dropStore(dir);
  }
});

test("存储核心：同 scope 同 key 更新保留 id，跨 scope 不覆盖", async () => {
  const { dir, file } = await freshStore();
  try {
    const first = await saveMemory("回答风格", "结论先行", "agent", "general");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await saveMemory("回答风格", "结论先行，少用列表", "user", "general");
    assert.equal(second.id, first.id);
    const estate = await saveMemory("回答风格", "房产回答要带风险提示", "user", "estate");
    assert.notEqual(estate.id, first.id);
    assert.equal(await loadMemories("general"), 1);
    assert.equal(await loadMemories("estate"), 1);
    assert.equal(listMemories("general").length, 1);
    assert.equal(listMemories("estate").length, 1);

    const persisted = JSON.parse(await readFile(file, "utf8")) as { schemaVersion: number; entries: unknown[] };
    assert.equal(persisted.schemaVersion, 2);
    assert.equal(persisted.entries.length, 2);
  } finally {
    await dropStore(dir);
  }
});

test("作用域删除：不能用 general 默认值删除 estate 记忆", async () => {
  const { dir } = await freshStore();
  try {
    const estate = await saveMemory("房源偏好", "只看整租", "user", "estate");
    assert.equal(await deleteMemory(estate.id), false);
    assert.equal(await deleteMemory(estate.id, "estate"), true);
    assert.equal(await loadMemories("estate"), 0);
  } finally {
    await dropStore(dir);
  }
});

test("输入校验与坏文件隔离：坏 JSON 改名 .corrupt，不静默覆盖原文", async () => {
  const { dir, file } = await freshStore();
  try {
    await assert.rejects(() => saveMemory("  ", "内容", "agent"), /主题/);
    await assert.rejects(() => saveMemory("主题", "", "agent"), /内容/);
    await assert.rejects(() => saveMemory("k".repeat(51), "内容", "agent"), /主题过长/);
    await writeFile(file, "{ 不是 JSON", "utf8");
    resetMemoryStore();
    assert.equal(await loadMemories(), 0);
    assert.equal(memoryStoreStatus().state, "corrupt");
    assert.ok(memoryStoreStatus().quarantinedTo);
    const names = await readdir(dir);
    assert.ok(names.some((name) => name.includes(".corrupt-")), "原坏文件必须保留为隔离副本");
  } finally {
    await dropStore(dir);
  }
});

test("注入只含当前 scope：general 记忆不会进入 estate system 注记", async () => {
  const { dir } = await freshStore();
  try {
    await saveMemory("回答风格", "结论先行", "agent", "general");
    await saveMemory("房产口吻", "必须说明数据来源", "user", "estate");
    const generalNote = await memoryNoteForPrompt({ profileId: "general", query: "回答 风格" });
    const estateNote = await memoryNoteForPrompt({ profileId: "estate", query: "房产 口吻" });
    assert.match(generalNote ?? "", /结论先行/);
    assert.doesNotMatch(generalNote ?? "", /数据来源/);
    assert.match(estateNote ?? "", /数据来源/);
    assert.doesNotMatch(estateNote ?? "", /结论先行/);

    const context = buildAgentContext({
      profile: testProfile,
      messages: [new HumanMessage("以后回答先给结论")],
      memoryNote: generalNote ?? undefined,
    });
    const systemNotes = context.messages.filter((message) => message.getType() === "system");
    assert.equal(systemNotes.length, 2);
    assert.match(String(systemNotes[1].content), /跨会话长期记忆/);
  } finally {
    await dropStore(dir);
  }
});

test("工具：按闭包 scope 读写，成功/失败均返回中文文本", async () => {
  const { dir } = await freshStore();
  try {
    const saved = await memorySave.invoke({ key: "称呼", content: "称呼用户为老李" });
    assert.match(String(saved), /已记住.*称呼/);
    const tooLong = await memorySave.invoke({ key: "称呼", content: "x".repeat(600) });
    assert.match(String(tooLong), /内容过长/);
    const hit = await memoryRecall.invoke({ query: "称呼" });
    assert.match(String(hit), /老李/);

    const estateTools = createMemoryTools("estate");
    await estateTools.memorySave.invoke({ key: "城市", content: "用户在上海" });
    assert.match(String(await estateTools.memoryRecall.invoke({ query: "上海" })), /上海/);
    assert.doesNotMatch(String(await memoryRecall.invoke({ query: "上海" })), /用户在上海/);
  } finally {
    await dropStore(dir);
  }
});

test("轻量检索：多词 OR、大小写不敏感、空查询返回当前 scope 最新条目", async () => {
  const { dir } = await freshStore();
  try {
    await saveMemory("Editor", "Use VSCode", "agent", "general");
    await saveMemory("天气", "用户在北京", "agent", "general");
    const hits = await searchMemories("editor 北京", 10, "general");
    assert.equal(hits.length, 2);
    assert.equal((await searchMemories("", 1, "general")).length, 1);
  } finally {
    await dropStore(dir);
  }
});

test("工具挂载隔离：general 挂记忆工具，estate 与子 Agent 均不挂", () => {
  const generalNames = generalProfile.tools.map((item) => item.name);
  assert.ok(generalNames.includes("memory_save"));
  assert.ok(generalNames.includes("memory_recall"));

  const estateNames = estateProfile.tools.map((item) => item.name);
  assert.ok(!estateNames.includes("memory_save"), "租房 Agent 默认不能写长期记忆");
  assert.ok(!estateNames.includes("memory_recall"), "租房 Agent 默认不能读长期记忆工具");

  const subNames = subagentProfileOf(generalProfile).tools.map((item) => item.name);
  assert.ok(!subNames.includes("memory_save"));
  assert.ok(!subNames.includes("memory_recall"));
  assert.ok(!subNames.includes("delegate_agent"));
});
