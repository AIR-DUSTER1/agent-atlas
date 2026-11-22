/**
 * estate-listing-url.test.ts — 贝壳房源详情页链接构造
 * ============================================================
 * 守：① 城市必须能从映射表查到才拼链接（未收录城市降级为纯文字，不跳错城市）；
 *     ② 租房走 zu 子域 + /zufang/，二手房走主站 + /ershoufang/（实测路径）；
 *     ③ houseId 必须纯数字，模型编造的字符串一律拒绝，不拼进 URL。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildListingUrl, CITY_SUBDOMAIN } from "../../src/client/modules/estate-listing-url.js";

test("租房与二手房分别拼到实测存在的路径", () => {
  assert.equal(
    buildListingUrl("青岛", "103154186731", "rent"),
    "https://qd.zu.ke.com/zufang/103154186731.html",
  );
  assert.equal(
    buildListingUrl("青岛", "103118558783", "buy"),
    "https://qd.ke.com/ershoufang/103118558783.html",
  );
});

test("城市名带「市」后缀与空白也能命中", () => {
  assert.equal(buildListingUrl("青岛市", "103154186731"), "https://qd.zu.ke.com/zufang/103154186731.html");
  assert.equal(buildListingUrl(" 北京 ", "101100000001"), "https://bj.zu.ke.com/zufang/101100000001.html");
});

test("未收录城市与缺失城市不拼链接（降级为纯文字）", () => {
  assert.equal(buildListingUrl("某个不存在的地级市", "103154186731"), null);
  assert.equal(buildListingUrl(undefined, "103154186731"), null);
  assert.equal(buildListingUrl("", "103154186731"), null);
});

test("非法 houseId 一律拒绝，不把模型编造内容拼进 URL", () => {
  for (const bad of ["", "abc", "10315", "103154186731<script>", "103154186731/../x", undefined]) {
    assert.equal(buildListingUrl("青岛", bad), null, `应拒绝 houseId=${String(bad)}`);
  }
});

test("映射表里的子域都是合法小写字母段（不含点与斜杠）", () => {
  for (const [city, sub] of Object.entries(CITY_SUBDOMAIN)) {
    assert.match(sub, /^[a-z]{2,10}$/, `${city} 的子域「${sub}」不合法`);
  }
  // 覆盖用户实际用到的青岛，回归时若误删会被这条抓住
  assert.equal(CITY_SUBDOMAIN["青岛"], "qd");
});

test("mergeProperty 的字段白名单必须覆盖 ConclusionProperty 的全部可选字段", async () => {
  // 真实回归：city 与 listingKind 加进 ConclusionProperty 后，mergeProperty 的
  // 字段白名单没同步，被静默丢弃 —— 表格照旧显示「有 VR 标记 · 专属入口未返回」，
  // 而且类型检查完全通过（可选字段缺失不算错）。这类"白名单丢字段"只能靠结构断言抓。
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(
    new URL("../../src/client/modules/conclusion-media.ts", import.meta.url),
    "utf8",
  );
  const iface = source.match(/export interface ConclusionProperty \{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.ok(iface, "未找到 ConclusionProperty 定义");
  const declared = [...iface.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1] as string);
  assert.ok(declared.length >= 10, `字段解析异常：${declared.length}`);

  const whitelist = source.match(
    /for \(const key of \[([^\]]+)\] as const\) \{\s*const value = text\(patch\[key\]\)/,
  )?.[1] ?? "";
  assert.ok(whitelist, "未找到 mergeProperty 的字符串字段白名单");
  const listed = new Set([...whitelist.matchAll(/"(\w+)"/g)].map((m) => m[1] as string));

  // images / location / hasVr / listingKind 有各自的赋值分支或必填，不在字符串白名单里
  const handledElsewhere = new Set(["houseId", "images", "location", "hasVr", "listingKind"]);
  const missing = declared.filter((key) => !listed.has(key) && !handledElsewhere.has(key));
  assert.deepEqual(
    missing,
    [],
    `ConclusionProperty 新增了字段但 mergeProperty 会静默丢弃它们：${missing.join("、")}`,
  );
  // listingKind 必须真的有分支处理（只出白名单不算）
  assert.match(source, /if \(patch\.listingKind\) row\.listingKind = patch\.listingKind/);
});
