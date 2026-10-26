/**
 * tool-risk.test.ts — 自主权限风险评估回归
 * ============================================================
 * 守：严格 JSON 解析；明确低风险才放行；坏输出 / 异常 / 超时一律 fail-closed；
 * 审查提示包含工具参数与当前用户意图，但不绑定/执行任何工具。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createToolRiskAssessor,
  parseToolRiskAssessment,
  type ToolRiskJudgeModel,
} from "../../src/agent/tool-risk.js";

test("风险 JSON：明确 low/high 可解析，未知或缺字段按高风险", () => {
  assert.deepEqual(parseToolRiskAssessment('{"highRisk":false,"reason":"仅在项目内新建文件"}'), {
    highRisk: false,
    reason: "仅在项目内新建文件",
  });
  assert.equal(parseToolRiskAssessment('```json\n{"high_risk":true,"reason":"删除生产目录"}\n```').highRisk, true);
  assert.equal(parseToolRiskAssessment('{"reason":"没有结论"}').highRisk, true);
  assert.equal(parseToolRiskAssessment("完全不是 JSON").failed, true);
});

test("审查器把用户意图与参数交给模型，明确低风险才直接放行", async () => {
  let seenInput = "";
  let seenSignal: AbortSignal | undefined;
  const model: ToolRiskJudgeModel = {
    async invoke(input, options) {
      seenInput = JSON.stringify(input);
      seenSignal = options?.signal;
      return {
        content: '{"highRisk":false,"reason":"只清理项目内可再生成的缓存"}',
        usage_metadata: { input_tokens: 300, output_tokens: 20, total_tokens: 320, input_token_details: { cache_read: 100 } },
      } as never;
    },
  };
  const assess = createToolRiskAssessor(model);
  const result = await assess({
    toolName: "terminal",
    description: "执行 rm -rf .cache",
    args: { command: "rm -rf .cache" },
    userIntent: "清理项目里可以重新生成的缓存文件",
    profileId: "general",
  });
  assert.equal(result.highRisk, false);
  assert.match(seenInput, /清理项目里可以重新生成的缓存文件/);
  assert.match(seenInput, /rm -rf \.cache/);
  assert.ok(seenSignal, "风险审查网络调用必须带超时信号");
  assert.deepEqual(result.usage, { inputTokens: 300, outputTokens: 20, totalTokens: 320, cacheReadTokens: 100 });
});

test("审查模型异常或返回坏 JSON 时按高风险处理", async () => {
  const throwing: ToolRiskJudgeModel = {
    async invoke() { throw new Error("gateway timeout"); },
  };
  const invalid: ToolRiskJudgeModel = {
    async invoke() { return { content: "not json" }; },
  };
  const thrown = await createToolRiskAssessor(throwing)({
    toolName: "send_email",
    description: "发送邮件",
    args: { to: "a@example.com" },
  });
  const malformed = await createToolRiskAssessor(invalid)({
    toolName: "write_file",
    description: "覆盖文件",
    args: { path: "a.txt" },
  });
  assert.equal(thrown.highRisk, true);
  assert.equal(thrown.failed, true);
  assert.match(thrown.reason, /gateway timeout/);
  assert.equal(malformed.highRisk, true);
  assert.equal(malformed.failed, true);
});