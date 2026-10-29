/**
 * estate-tool-errors.test.ts — 贝壳业务失败不能伪装成成功
 * ============================================================
 * 守：CLI exit 0 但 JSON 顶层 ok:false/error 时，必须识别为业务失败。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { beikeBusinessError } from "../../src/server/estate.js";

test("贝壳 JSON 业务失败识别：ok:false / error 字符串", () => {
  assert.equal(
    beikeBusinessError({ error: "Unknown tool: 'rent_market_search'", ok: false }),
    "Unknown tool: 'rent_market_search'",
  );
  assert.equal(beikeBusinessError({ error: "参数不完整" }), "参数不完整");
  assert.equal(beikeBusinessError({ ok: true, data: "正常结果" }), null);
  assert.equal(beikeBusinessError("<参考数据>"), null);
});
