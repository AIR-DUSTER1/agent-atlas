/**
 * session-kinds.test.ts — 会话类型能力判定的一致性守门
 * ============================================================
 * 守：新增 Agent 类型时，「哪些会话有 Agent 执行力」这个判断只能有一处来源。
 *
 * 背景（真实缺陷）：加求职 Agent 时，`kind === "agent" || kind === "estate"`
 * 这个判断散落在四处各自手写，只改了 SessionKind 联合与建图分支，漏掉三处：
 *   1. 前端权限 chip 不显示 → 求职会话根本没有权限切换入口；
 *   2. 压缩后不清理旧 checkpoint 线程 → checkpoints.ndjson 无限增长；
 *   3. 重启后不注入历史 → 求职会话多轮记忆丢失。
 * 这个用例扫描源码，禁止再手写这类白名单。
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { isAgentKind as serverIsAgentKind } from "../../src/server/sessions.js";
import { isAgentKind as clientIsAgentKind } from "../../src/client/modules/session-kind.js";

const ROOT = join(fileURLToPath(new URL("../../", import.meta.url)));
const SRC = join(ROOT, "src");

async function listTs(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await listTs(path));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

test("服务端与前端对「有 Agent 执行力的会话」判定一致，且都包含 job", () => {
  for (const kind of ["agent", "estate", "job"] as const) {
    assert.equal(serverIsAgentKind(kind), true, `服务端应把 ${kind} 视为 Agent 会话`);
    assert.equal(clientIsAgentKind(kind), true, `前端应把 ${kind} 视为 Agent 会话`);
  }
  for (const kind of ["demo", "external"] as const) {
    assert.equal(serverIsAgentKind(kind), false, `${kind} 不应被视为 Agent 会话`);
    assert.equal(clientIsAgentKind(kind), false, `${kind} 不应被视为 Agent 会话`);
  }
  assert.equal(serverIsAgentKind(null), false);
  assert.equal(clientIsAgentKind(undefined), false);
});

test("源码里不得再手写 agent/estate 双值白名单（必须走 isAgentKind）", async () => {
  // 允许出现的地方：
  //   - 判定函数自身：server/sessions.ts、client/modules/session-kind.ts；
  //   - kind → profile 的逐项映射：agent/profile.ts、client/modules/agent-profile.ts
  //     （每个 kind 映射到不同 profile，本来就必须逐个列出，且已覆盖 job）；
  //   - routing/route-step.ts：求职会话有意不参与子代理路由（领域固定、无需再派）。
  const ALLOWED = new Set([
    "server/sessions.ts",
    "client/modules/session-kind.ts",
    "agent/profile.ts",
    "client/modules/agent-profile.ts",
    "routing/route-step.ts",
  ]);
  const violations: string[] = [];
  // 匹配 kind === "agent" ... kind === "estate" 这种成对硬编码（允许中间有 || 与换行）
  const pattern = /kind\s*===\s*"agent"[\s\S]{0,60}?kind\s*===\s*"estate"/g;
  const reverse = /kind\s*===\s*"estate"[\s\S]{0,60}?kind\s*===\s*"agent"/g;
  for (const file of await listTs(SRC)) {
    const rel = file.slice(SRC.length + 1).replaceAll("\\", "/");
    if (ALLOWED.has(rel)) continue;
    const source = await readFile(file, "utf8");
    for (const re of [pattern, reverse]) {
      re.lastIndex = 0;
      if (re.test(source)) violations.push(rel);
    }
  }
  assert.deepEqual([...new Set(violations)], [], `以下文件手写了 agent/estate 白名单，请改用 isAgentKind：${violations.join(", ")}`);
});

test("求职会话在权限拦截上走同一套裁决", async () => {
  const { resolveToolPermission } = await import("../../src/agent/permission.js");
  const { jobApprovals } = await import("../../src/agent/approvals.js");
  // 只读模式：登记审批的工具（job_collect）必须被拒绝
  assert.equal(resolveToolPermission("readonly", "job_collect", jobApprovals), "deny");
  // 审批模式（默认）：必须先弹出审批
  assert.equal(resolveToolPermission("approve", "job_collect", jobApprovals), "interrupt");
  // 自动模式：直接执行
  assert.equal(resolveToolPermission("auto", "job_collect", jobApprovals), "run");
  // 只读工具（计算器）在只读模式仍可用
  assert.equal(resolveToolPermission("readonly", "calculator", jobApprovals), "run");
});

/**
 * 审批按钮「点不动」的两个成因都曾在线上出现：
 *   1. interrupt 到达后前端仍认为该会话在生成，decideApproval 首行静默 return；
 *   2. 静默 return 让用户完全看不到反馈，看起来就是按钮坏了。
 * 这里用源码结构断言把两处对策固定住。
 */
test("interrupt 到达即解除流占用，审批不必等 SSE 尾部", async () => {
  const events = await readFile(join(SRC, "client", "stream", "events.ts"), "utf8");
  assert.match(events, /releaseStreamAfterInterrupt\(sid, ablock\)/, "addInterrupt 必须主动解除流占用");
  assert.match(events, /stream\.ablock !== ablock/, "只解除确实属于这个块的流");
  const turn = await readFile(join(SRC, "client", "stream", "turn.ts"), "utf8");
  // 收尾必须是「按流对象身份」删，而不是按 ablock 删 —— 否则会把 resume 新登记的那条删掉
  assert.match(turn, /state\.streams\[sid\] === stream/);
  assert.match(turn, /finalize\(ablock, sid, stream\)/);
});

test("审批/澄清被流占用挡住时必须给出可见提示，不得静默返回", async () => {
  const approvals = await readFile(join(SRC, "client", "actions", "approvals.ts"), "utf8");
  assert.match(approvals, /function blockedReason\(\)/, "必须集中判定占用原因");
  assert.match(approvals, /toast\(blocked, "warning"\)/, "被挡住时要提示用户");
  // 旧的静默写法不得回归
  assert.doesNotMatch(
    approvals,
    /if \(state\.currentId && \(state\.streams\[state\.currentId\] \|\| state\.compacting\[state\.currentId\]\)\) return;/,
    "不得回到静默 return"
  );
});

/**
 * 求职 Agent 此前只作为「会话形态」存在，没有注册成可委派的子代理：
 * 设置页只列出 general / estate，主 Agent 也没法把求职任务派给专项子代理。
 * 这里守住三件事：种子里有 job、路由名片可用、领域提示词能解析到。
 */
test("求职 Agent 是内置子代理，带可参与路由的名片与领域提示词", async () => {
  const state = await import("../../src/subagent-state.js");
  const job = state.DEFAULT_SUBAGENTS.find((item) => item.id === "job");
  assert.ok(job, "内置子代理种子必须包含 job");
  assert.equal(job.enabled, true, "求职子代理默认启用");
  assert.equal(job.builtIn, true);
  // 有路由名片才会被规则层/决策模型挑中；空名片等于「不参与竞争」
  assert.ok(job.routing.keywords.length >= 5, "求职子代理必须有足够的关键词名片");
  assert.equal(job.routing.domainProfile, "job");
  assert.ok(job.routing.category);
  assert.ok(job.routing.notSuitableFor.length > 0, "必须声明不适用场景，避免抢走找房任务");

  // 领域 profile 要能解析出求职顾问提示词（否者委派出去的子代理不知道四项意图规则）
  const { resolveDomainProfile } = await import("../../src/agent/domain-profile.js");
  const domain = resolveDomainProfile("job");
  assert.ok(domain, "job 领域 profile 必须可解析");
  assert.match(domain!.systemPrompt, /求职/);
});

test("求职子代理与房产子代理的关键词名片不重叠", async () => {
  const { DEFAULT_SUBAGENTS } = await import("../../src/subagent-state.js");
  const job = DEFAULT_SUBAGENTS.find((item) => item.id === "job");
  const estate = DEFAULT_SUBAGENTS.find((item) => item.id === "estate");
  assert.ok(job && estate);
  const overlap = job!.routing.keywords.filter((word) => estate!.routing.keywords.includes(word));
  assert.deepEqual(overlap, [], `求职与房产子代理不应共用关键词（会让路由二选一犯难）：${overlap.join("、")}`);
});

test("设置页领域下拉提供 job 选项，且提交时不被静默丢弃", async () => {
  const html = await readFile(join(SRC, "client", "index.html"), "utf8");
  assert.match(html, /<option value="job">/, "领域下拉必须有 job 选项");
  const form = await readFile(join(SRC, "client", "views", "settings-subagents.ts"), "utf8");
  // 曾硬编码只认 estate，选 job 会被静默丢成「通用后台子代理提示词」
  assert.match(form, /picked === "job"/);
});

test("工具卡在等审批时显示「待审批」而不是「运行中」", async () => {
  const events = await readFile(join(SRC, "client", "stream", "events.ts"), "utf8");
  assert.match(events, /markAwaitingApproval\(ablock, payload\.toolName, true\)/);
  const parts = await readFile(join(SRC, "client", "render", "parts.ts"), "utf8");
  assert.match(parts, /part\.awaitingApproval/);
  assert.match(parts, /待审批/);
  // 审批决定后必须清掉标记，否则卡片永远停在「待审批」
  const approvals = await readFile(join(SRC, "client", "actions", "approvals.ts"), "utf8");
  assert.match(approvals, /clearAwaitingApproval\(part\.req\.toolName\)/);
});
