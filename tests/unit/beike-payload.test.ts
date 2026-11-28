/**
 * ============================================================
 * beike-payload.test.ts — 贝壳 CLI 结果信封解包与反转义
 * ============================================================
 * 守真实事故：信封 `{data, ok}` 被整只 JSON.stringify 后引号二次转义，
 * 所有 `"字段"\s*:\s*"值"` 取值正则失配（价格/房型/小区全空）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { beikeText, unescapeBeikeText } from "../../src/shared/beike-payload.js";

const BODY = [
  "<参考数据>",
  "<租赁房源>",
  "<100001>",
  JSON.stringify({ 基础信息: { 小区名: "金水苑小区", 房型: "2室1厅", 出租面积: "82㎡", 租赁价格: "1950元/月" } }),
  "</100001>",
].join("\n");

test("信封只取 data：不再二次 stringify 整只对象", () => {
  const text = beikeText({ data: BODY, ok: true });
  assert.match(text, /"租赁价格"\s*:\s*"1950元\/月"/, "信封解包后必须能直接命中字段正则");
  assert.doesNotMatch(text, /\\"租赁价格\\"/, "不能出现二次转义后的字段名");
});

test("反转义幂等：已是明文时不改动", () => {
  const plain = '"租赁价格": "1950元/月"';
  assert.equal(unescapeBeikeText(plain), plain);
  assert.equal(unescapeBeikeText(""), "");
});

test("还原 \\/ 与 \\u002f 两种斜杠写法", () => {
  assert.equal(unescapeBeikeText("https:\\/\\/a.example\\/x.jpg"), "https://a.example/x.jpg");
  assert.equal(unescapeBeikeText("https:\u002f\u002fa.example\u002fx.jpg"), "https://a.example/x.jpg");
});

test("裸字符串与数组形态都不抛错", () => {
  assert.match(beikeText(BODY), /金水苑小区/);
  assert.equal(typeof beikeText([]), "string");
  assert.equal(beikeText(null), "");
  assert.equal(beikeText(undefined), "");
});
