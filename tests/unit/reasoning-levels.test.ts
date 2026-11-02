/** reasoning-levels.test.ts — DeepSeek / GLM 只暴露供应商原生思考档位 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { detectDialect, getDialect, resolveReasoning } from "../../src/reasoning.js";

function levelIds(dialectId: "deepseek-thinking" | "zhipu-thinking"): string[] {
  return getDialect(dialectId).levels.map((level) => level.id);
}

test("DeepSeek 只暴露原生 none / low / high / max", () => {
  assert.deepEqual(levelIds("deepseek-thinking"), ["default", "none", "low", "high", "max"]);
  for (const level of ["none", "low", "high", "max"]) {
    const resolved = resolveReasoning(
      { dialect: "deepseek-thinking", level },
      { model: "deepseek-v4.1-flash", protocol: "openai" },
    );
    assert.equal(resolved.level, level);
    assert.deepEqual(resolved.params, { reasoning_effort: level });
  }
  assert.equal(
    resolveReasoning(
      { dialect: "deepseek-thinking", level: "medium" },
      { model: "deepseek-v4.1-flash", protocol: "openai" },
    ).params,
    null,
  );
});

test("GLM-5.3 只暴露原生 low / high / max，且不支持关闭思考", () => {
  assert.deepEqual(levelIds("zhipu-thinking"), ["default", "low", "high", "max"]);
  for (const level of ["low", "high", "max"]) {
    const resolved = resolveReasoning(
      { dialect: "zhipu-thinking", level },
      { model: "glm-5.3", protocol: "openai" },
    );
    assert.equal(resolved.level, level);
    assert.deepEqual(resolved.params, { reasoning_effort: level });
  }
  assert.equal(
    resolveReasoning(
      { dialect: "zhipu-thinking", level: "disabled" },
      { model: "glm-5.3", protocol: "openai" },
    ).params,
    null,
  );
});

test("模型名仍能自动识别 DeepSeek / GLM 方言", () => {
  assert.equal(detectDialect({ model: "deepseek-v4.1-flash", protocol: "openai" }), "deepseek-thinking");
  assert.equal(detectDialect({ model: "glm-5.3-flash", protocol: "openai" }), "zhipu-thinking");
});
