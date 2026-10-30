/**
 * tests/integration/subagents.test.ts — 子代理配置 API 端到端回归
 * ============================================================
 * 守住设置页依赖的契约：默认种子、CRUD、启停、继承/固定模型、非法模型拒绝。
 * 全部运行在临时配置目录与 mock 模式，不调用真实模型。
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startServer, type RunningServer } from "../helpers/server.js";

let srv: RunningServer;

before(async () => { srv = await startServer(); });
after(async () => { await srv?.stop(); });

async function json(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(srv.base + path, init);
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

function body(value: unknown): RequestInit {
  return {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  };
}

test("子代理默认目录、创建、编辑启停与删除", async () => {
  const initial = await json("/api/subagents");
  assert.equal(initial.status, 200);
  assert.ok(initial.body.agents.some((agent: any) => agent.id === "general"));
  assert.ok(initial.body.agents.some((agent: any) => agent.id === "estate"));

  const created = await json("/api/subagents", {
    method: "POST",
    ...body({
      name: "代码审查员",
      description: "审查改动并定位回归风险",
      enabled: true,
      model: { mode: "inherit" },
    }),
  });
  assert.equal(created.status, 200);
  const agent = created.body.agents.find((item: any) => item.name === "代码审查员");
  assert.ok(agent?.id?.startsWith("sub-"));
  assert.equal(agent.model.mode, "inherit");
  assert.equal(agent.modelAvailable, true);

  const updated = await json(`/api/subagents/${agent.id}`, {
    method: "PATCH",
    ...body({ enabled: false, name: "回归审查员" }),
  });
  assert.equal(updated.status, 200);
  const changed = updated.body.agents.find((item: any) => item.id === agent.id);
  assert.equal(changed.name, "回归审查员");
  assert.equal(changed.enabled, false);

  const removed = await json(`/api/subagents/${agent.id}`, { method: "DELETE" });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.agents.some((item: any) => item.id === agent.id), false);
});

test("子代理固定模型引用有效，失效引用与坏输入被拒绝", async () => {
  const config = await json("/api/config");
  const provider = config.body.providers?.[0];
  const model = provider?.models?.[0];
  assert.ok(provider && model, "测试环境应有默认供应商与模型");

  const created = await json("/api/subagents", {
    method: "POST",
    ...body({
      name: "固定模型代理",
      description: "使用指定模型完成独立任务",
      model: { mode: "fixed", providerId: provider.id, modelId: model.id },
    }),
  });
  assert.equal(created.status, 200);
  const agent = created.body.agents.find((item: any) => item.name === "固定模型代理");
  assert.equal(agent.model.mode, "fixed");
  assert.equal(agent.modelAvailable, true);

  const invalidModel = await json("/api/subagents", {
    method: "POST",
    ...body({
      name: "坏模型代理",
      description: "应被拒绝",
      model: { mode: "fixed", providerId: "missing", modelId: "missing" },
    }),
  });
  assert.equal(invalidModel.status, 400);
  assert.match(invalidModel.body.error, /不存在/);

  const invalidEnabled = await json(`/api/subagents/${agent.id}`, {
    method: "PATCH",
    ...body({ enabled: "false" }),
  });
  assert.equal(invalidEnabled.status, 400);
  assert.match(invalidEnabled.body.error, /布尔/);

  await json(`/api/subagents/${agent.id}`, { method: "DELETE" });
});
