/**
 * ============================================================
 * server/routes/routing.ts — 路由配置接口
 * ============================================================
 * GET  /api/routing         配置 + 依赖状态（Key 只给是否已设置）
 * PUT  /api/routing         保存配置（阈值 / 后端 / 上限）
 * POST /api/routing/test    用一段样例文本跑一次真实决策，返回各层结果
 *
 * 设计立场：
 *  - test 端点同样不耗真实配额以外的东西：它复用配置里的模型，
 *    用户主动点「测试」才发一次请求；不提供后台定时探测；
 *  - 所有错误转中文并带 400，前端直接展示，不需要自己翻译。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody } from "../http-body.js";
import { routingSnapshot, saveRoutingSettings } from "../routing-settings.js";
import { runRouteStep } from "../../routing/route-step.js";
import { getEnabledSubagents } from "../../subagent-state.js";
import { buildRoutingCandidates } from "../../routing/candidates.js";
import { scoreRoutingCandidates } from "../../routing/rules.js";
import { getRoutingSettings } from "../../routing/state.js";

const MAX_TEST_TEXT = 2_000;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

export function handleGetRouting(res: ServerResponse): void {
  sendJson(res, 200, routingSnapshot());
}

export async function handleSaveRouting(res: ServerResponse, req: IncomingMessage): Promise<void> {
  try {
    const body = JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>;
    sendJson(res, 200, await saveRoutingSettings(body));
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * 试跑一次决策：把规则分、最终结论都摊开，便于调阈值。
 * 说明：这会真的调用一次决策后端（用户主动触发，可能是云 API 费用）。
 */
export async function handleTestRouting(res: ServerResponse, req: IncomingMessage): Promise<void> {
  try {
    const body = JSON.parse((await readBody(req)) || "{}") as { text?: unknown };
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) throw new Error("请填写一段用于测试的用户请求文本");
    if (text.length > MAX_TEST_TEXT) throw new Error(`测试文本不能超过 ${MAX_TEST_TEXT} 个字符`);

    const agents = getEnabledSubagents();
    const candidates = buildRoutingCandidates(agents);
    const settings = getRoutingSettings();
    const ruleScores = scoreRoutingCandidates(
      candidates.map((candidate) => ({
        agentId: candidate.agentId,
        name: candidate.name,
        keywords: candidate.routing.keywords,
        notSuitableFor: candidate.routing.notSuitableFor,
        ...(candidate.routing.category ? { category: candidate.routing.category } : {}),
      })),
      text,
    );

    // 测试端点无视 enabled：用户点「测试」就是想看结果，不该被开关挡住。
    const result = await runRouteStep({
      text,
      sessionKind: "agent",
      handoffCount: 0,
      settingsOverride: { ...settings, enabled: true },
    });

    sendJson(res, 200, {
      decision: result.decision,
      usedModel: result.usedModel,
      usedVector: result.usedVector,
      ruleScores: ruleScores.map((item) => ({
        agentId: item.agentId,
        name: item.name,
        score: Number(item.score.toFixed(3)),
        hits: item.hits,
        negatives: item.negatives,
      })),
      candidateCount: candidates.length,
    });
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}
