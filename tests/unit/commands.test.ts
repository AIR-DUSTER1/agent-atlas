/**
 * commands.test.ts — 用户自定义命令回归
 * ============================================================
 * 守四条：
 *   1. 增删改查、同名覆盖与显式编辑（含改名）；坏数据（缺字段 / 非法名）给中文错误；
 *   2. 命令名白名单：非法字符、内置命令名（compact）一律拒；
 *   3. 上限：条数与模板长度都有硬上限，超了明确报错；
 *   4. 占位符展开：{{selection}} / {{date}}。
 *
 * 用临时 WEB_CONFIG_FILE 隔离，不碰开发者真实 .web-config.json。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = await mkdtemp(join(tmpdir(), "agent-cmd-"));
const configFile = join(dir, "web-config.json");
process.env.WEB_CONFIG_FILE = configFile;

const { listCommands, saveCommand, createCommand, updateCommand, deleteCommand, expandTemplate } = await import("../../src/server/commands.js");

test.after(async () => {
  delete process.env.WEB_CONFIG_FILE;
  await rm(dir, { recursive: true, force: true });
});

test("新增命令后可列出；同名再保存是覆盖而不是追加", async () => {
  const created = await saveCommand({
    name: "review",
    title: "审查改动",
    description: "审查当前 diff 并指出风险",
    template: "请审查以下改动：\n{{selection}}",
  });
  assert.equal(created.created, true);
  assert.equal(created.command.name, "review");

  let all = await listCommands();
  assert.equal(all.length, 1);
  assert.equal(all[0].title, "审查改动");

  // 同名覆盖
  const updated = await saveCommand({ name: "review", template: "改过的模板" });
  assert.equal(updated.created, false);
  all = await listCommands();
  assert.equal(all.length, 1, "同名保存必须覆盖，不能变成两条");
  assert.equal(all[0].template, "改过的模板");
});

test("命令名白名单：非法字符与内置命令名都被拒", async () => {
  for (const bad of ["带中文", "has space", "/slash", "", "a".repeat(41)]) {
    await assert.rejects(
      () => saveCommand({ name: bad, template: "x" }),
      /命令名/,
      `${JSON.stringify(bad)} 应被拒绝`
    );
  }
  await assert.rejects(
    () => saveCommand({ name: "compact", template: "x" }),
    /内置命令名/
  );
});

test("模板为空 / 超长都给中文错误", async () => {
  await assert.rejects(() => saveCommand({ name: "empty", template: "   " }), /模板不能为空/);
  await assert.rejects(
    () => saveCommand({ name: "huge", template: "字".repeat(8_001) }),
    /不能超过/
  );
});

test("删除命令：存在则移除，不存在返回 removed=false", async () => {
  await saveCommand({ name: "deploy", template: "部署步骤：{{date}}" });
  const del = await deleteCommand("deploy");
  assert.equal(del.removed, true);
  assert.ok(!del.commands.some((c) => c.name === "deploy"));

  const again = await deleteCommand("deploy");
  assert.equal(again.removed, false, "重复删除不应报错，只是没删到");
});

test("编辑命令支持改名；与已有命令重名或原命令不存在时明确处理", async () => {
  await saveCommand({ name: "edit-source", title: "旧标题", template: "旧模板" });
  const updated = await updateCommand("edit-source", {
    name: "edit-target",
    title: "新标题",
    description: "改名后的命令",
    template: "新模板 {{date}}",
  });
  assert.ok(updated);
  assert.equal(updated.name, "edit-target");
  const all = await listCommands();
  assert.ok(!all.some((command) => command.name === "edit-source"));
  assert.equal(all.find((command) => command.name === "edit-target")?.template, "新模板 {{date}}");

  await saveCommand({ name: "edit-conflict", template: "另一个命令" });
  await assert.rejects(
    () => updateCommand("edit-target", { name: "edit-conflict", template: "冲突" }),
    /已存在/
  );
  assert.equal(await updateCommand("missing-command", { name: "never", template: "x" }), null);
});

test("显式创建拒绝重名，避免静默覆盖已有命令", async () => {
  await createCommand({ name: "create-once", title: "第一次", template: "模板一" });
  await assert.rejects(
    () => createCommand({ name: "create-once", title: "第二次", template: "模板二" }),
    /已存在/
  );
  const all = await listCommands();
  assert.equal(all.find((command) => command.name === "create-once")?.title, "第一次");
});

test("占位符展开：{{selection}} 与 {{date}}", () => {
  const out = expandTemplate("审查：{{selection}}\n日期：{{date}}", "diff 内容");
  assert.match(out, /审查：diff 内容/);
  assert.match(out, /日期：\d{4}-\d{2}-\d{2}/);
  // 没有 selection 时替换成空串（不留下字面占位符）
  const noSel = expandTemplate("审查：{{selection}}");
  assert.equal(noSel, "审查：");
});

test("坏配置文件不会让设置页炸：非法条目被静默丢弃", async () => {
  await writeFile(configFile, JSON.stringify({
    commands: [
      { name: "ok", template: "正常" },
      { name: "", template: "缺名字" },
      { name: "no-template" },
      { name: "bad name", template: "名字有空格" },
      { name: "compact", template: "占内置名" },
      "不是对象",
      null,
    ],
  }), "utf8");
  const all = await listCommands();
  assert.equal(all.length, 1, "只应保留合法的那一条");
  assert.equal(all[0].name, "ok");
});
