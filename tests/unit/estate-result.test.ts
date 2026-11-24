/**
 * ============================================================
 * estate-result.test.ts — 贝壳原始文本的富结果归一化
 * ============================================================
 * 守：详情里的小区经纬度、material 里的图片 URL 必须变成稳定字段，
 * 供前端直接渲染；地址 geocode 失败不能覆盖贝壳已有的精确坐标。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractEstateImageUrls,
  extractEstateLocation,
  extractEstateSearchListings,
  extractEstateVrUrl,
  normalizeEstateDetail,
  normalizeEstateMaterial,
  parseEstateCoordinate,
} from "../../src/server/estate-result.js";
import { buildCompareMap } from "../../src/server/estate-geo.js";
import { mergeEstateListings } from "../../src/tools-estate.js";

const IMAGE_ONE = "https://ke-image.ljcdn.com/frame/floorplan.jpg!m_fit,h_843,w_1125,l_fbk_v1,lo_0.22,f_jpg";
const IMAGE_TWO = "https://ke-image.ljcdn.com/frame/living-room.webp?x=1";
const VR_URL = "https://realsee.com/vr/tour-100001";

function detailPayload(): string {
  return [
    "<参考数据>",
    JSON.stringify({
      基础信息: { 小区名: "测试花园", 房型: "2室1厅", 楼栋经纬度: "出于隐私保护，不方便透露" },
      小区信息: {
        小区名称: "测试花园",
        小区别名: "测试路 1 号,测试别名",
        小区经纬度: "120.123456,36.123456",
      },
    }),
    "</参考数据>",
    "<metadata>{\"entity_ids\":[\"10001\"],\"rent_codes\":[\"QD2232327398555123712\"]}</metadata>",
  ].join("\n");
}

test("详情归一化：贝壳小区经纬度直接生成单点地图与多地图链接", () => {
  const location = extractEstateLocation(detailPayload(), "青岛");
  assert.ok(location);
  assert.equal(location.label, "测试花园");
  assert.equal(location.address, "测试路 1 号");
  assert.equal(location.lat, 36.123456);
  assert.equal(location.lng, 120.123456);
  assert.equal(location.precision, "community");
  assert.match(location.embedUrl, /marker=36\.123456,120\.123456/);
  assert.match(location.links.amap, /position=120\.123456,36\.123456/);

  const normalized = normalizeEstateDetail(detailPayload(), "10001", "青岛", "rent") as Record<string, any>;
  assert.equal(normalized.action, "detail");
  assert.equal(normalized.houseId, "10001");
  assert.equal(normalized.rentCode, "QD2232327398555123712");
  assert.equal(normalized.detailUrl, "https://qd.zu.ke.com/zufang/QD2232327398555123712.html");
  assert.equal(normalized.presentation.map, true);
  assert.match(normalized.note, /直接渲染地图卡/);
});

test("楼栋经纬度可用时优先于小区中心点", () => {
  const raw = JSON.stringify({
    小区信息: { 小区名称: "测试花园", 小区经纬度: "120.123456,36.123456" },
    基础信息: { 楼栋经纬度: "120.124000,36.124000" },
  });
  const location = extractEstateLocation(raw, "青岛");
  assert.ok(location);
  assert.equal(location.precision, "building");
  assert.equal(location.lat, 36.124);
  assert.equal(location.lng, 120.124);
});

test("坐标解析兼容经纬度反序与非法值", () => {
  assert.deepEqual(parseEstateCoordinate("120.42,36.12"), { lat: 36.12, lng: 120.42 });
  assert.deepEqual(parseEstateCoordinate("36.12,120.42"), { lat: 36.12, lng: 120.42 });
  assert.equal(parseEstateCoordinate("出于隐私保护"), null);
  assert.equal(parseEstateCoordinate("200,36"), null);
});

test("material 归一化：图片与官方 VR 链接都进入稳定字段", () => {
  const raw = JSON.stringify({ 10001: { 房源图片: { 户型图片: IMAGE_ONE, 客厅图片: IMAGE_TWO }, vr: VR_URL } }) +
    `\n重复：${IMAGE_ONE}\n不安全：http://example.test/a.jpg`;
  assert.deepEqual(extractEstateImageUrls(raw), [IMAGE_ONE, IMAGE_TWO]);
  assert.equal(extractEstateVrUrl(raw), VR_URL);
  const normalized = normalizeEstateMaterial(raw, "10001") as Record<string, any>;
  assert.equal(normalized.action, "material");
  assert.equal(normalized.count, 2);
  assert.deepEqual(normalized.images, [IMAGE_ONE, IMAGE_TWO]);
  assert.equal(normalized.vr, VR_URL);
  assert.equal(normalized.presentation.images, 2);
  assert.equal(normalized.presentation.vr, true);
  assert.match(normalized.note, /直接展示/);
});

test("搜索文本归一化同时支持租房与买房字段，并保留 VR 入口", () => {
  const raw = [
    "<参考数据><租赁房源>",
    "<100001>",
    JSON.stringify({ 摘要信息: {
      户型信息: "2室1厅，出租面积90㎡，朝向南，整租",
      区位交通: "位于崂山区西韩板块测试花园小区，距离地铁站步行8分钟",
      房源亮点: "有VR，有钥匙",
      VR链接: VR_URL,
      租赁价格: "月租金2400元/月",
    } }),
    "</100001>",
    "<100002>",
    JSON.stringify({ 摘要信息: {
      户型信息: "3室2厅，建筑面积120㎡，朝向南/北",
      区位交通: "位于崂山区测试花园小区，距离地铁站步行6分钟",
      房源亮点: "无VR",
      总价: "300万元",
    } }),
    "</100002>",
    "</租赁房源></参考数据>",
  ].join("\n");
  const rows = extractEstateSearchListings(raw);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    id: "100001", title: "测试花园 · 2室1厅 · 90㎡", layout: "2室1厅", area: "90㎡",
    price: "月租金2400元/月", addressText: "位于崂山区西韩板块测试花园小区，距离地铁站步行8分钟",
    community: "测试花园", vr: VR_URL, hasVr: true,
  });
  assert.equal(rows[1]?.price, "300万元");
  assert.equal(rows[1]?.area, "120㎡");
  assert.equal(rows[1]?.hasVr, false);
  assert.equal(rows[1]?.vr, undefined);
});

test("搜索结果合并时完整文本字段优先于只有 id 的稀疏对象", () => {
  const merged = mergeEstateListings([
    {
      id: "103149264003",
      title: "依山半岛 · 2室1厅 · 92㎡",
      community: "依山半岛",
      layout: "2室1厅",
      area: "92㎡",
      price: "2800元/月",
      addressText: "崂山区依山半岛小区",
      rentCode: "QD2145328735694356480",
    },
  ], [
    { id: "103149264003", title: "房源 103149264003", hasVr: true },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.title, "依山半岛 · 2室1厅 · 92㎡");
  assert.equal(merged[0]?.community, "依山半岛");
  assert.equal(merged[0]?.layout, "2室1厅");
  assert.equal(merged[0]?.area, "92㎡");
  assert.equal(merged[0]?.price, "2800元/月");
  assert.equal(merged[0]?.hasVr, true);
  assert.equal(merged[0]?.rentCode, "QD2145328735694356480");
});

test("搜索 metadata 的 entity_ids/rent_codes 按顺序映射出详情链接", () => {
  const raw = [
    "<参考数据><租赁房源>",
    "<100001>",
    JSON.stringify({ 摘要信息: { 户型信息: "2室1厅，出租面积90㎡", 租赁价格: "2400元/月" } }),
    "</100001>",
    "<metadata>{\"entity_ids\":[\"100001\"],\"rent_codes\":[\"QD2232327398555123712\"]}</metadata>",
  ].join("\n");
  const rows = extractEstateSearchListings(raw);
  assert.equal(rows[0]?.rentCode, "QD2232327398555123712");
  assert.equal(rows[0]?.detailUrl, undefined);
});

test("有 VR 亮点但无真实链接时不拼旧模板入口", () => {
  const raw = '<100005>' + JSON.stringify({ 摘要信息: { 户型信息: "2室1厅，出租面积80㎡", 房源亮点: "有VR", 租赁价格: "2500元/月" } }) + '</100005>';
  const rows = extractEstateSearchListings(raw);
  assert.equal(rows[0]?.hasVr, true);
  assert.equal(rows[0]?.vr, undefined);
});

test("裸「全景」不算有 VR：普通房源描述不得被误判成有 VR", () => {
  // 回归：VR_POSITIVE_RE 曾把裸「全景」算作正向信号，房源文案里
  // 「小区实景全景拍摄」「楼栋全景展示」会让普通房源全被标成
  // 有 VR 但缺真实入口。全景必须与看房/链接/漫游等 VR 语境共现。
  const plain = ["小区实景全景拍摄于 2023 年", "楼栋全景展示", "周边全景：地铁/商圈/学校"];
  for (const [index, text] of plain.entries()) {
    const raw = `<10010${index}>` + JSON.stringify({ 摘要信息: {
      户型信息: "2室1厅，出租面积88㎡",
      房源亮点: text,
      租赁价格: "3000元/月",
    } }) + `</10010${index}>`;
    const rows = extractEstateSearchListings(raw);
    assert.equal(rows[0]?.hasVr, false, `「${text}」不应判定为有 VR`);
    assert.equal(rows[0]?.vr, undefined);
  }
  // 真阳性不能丢：VR 语境下的全景仍然算
  for (const [index, text] of ["全景看房", "VR看房", "有VR"].entries()) {
    const raw = `<10020${index}>` + JSON.stringify({ 摘要信息: {
      户型信息: "2室1厅，出租面积88㎡",
      房源亮点: text,
      租赁价格: "3000元/月",
    } }) + `</10020${index}>`;
    assert.equal(extractEstateSearchListings(raw)[0]?.hasVr, true, `「${text}」应判定为有 VR`);
  }
});

test("VR 提取只接受 HTTPS 官方真实域名，拒绝旧 houseid 模板", () => {
  const nested = JSON.stringify({ 房源资料: { VR链接: { pcUrl: "//realsee.com/vr/tour-10002" } } });
  assert.equal(extractEstateVrUrl(nested), "https://realsee.com/vr/tour-10002");
  assert.equal(extractEstateVrUrl({ vr_url: "http://realsee.com/vr/tour-10003" }), "");
  assert.equal(extractEstateVrUrl({ vr: "https://evil.example/vr?houseid=10004" }), "");
  assert.equal(extractEstateVrUrl({ vr: "https://ke-image.ljcdn.com/frame/vr-cover.jpg" }), "");
  assert.equal(extractEstateVrUrl({ vr: "https://vr.ke.com/#/vr?houseid=10005" }), "");
});

test("精确坐标不会触发二次 geocode，单点地图保留 marker", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("不应调用 Nominatim");
  }) as typeof fetch;
  try {
    const map = await buildCompareMap([
      { name: "测试花园", address: "测试路 1 号", lat: 36.123456, lng: 120.123456, source: "beike" },
    ], "青岛");
    assert.equal(map.points.length, 1);
    assert.equal(map.points[0]?.source, "beike");
    assert.match(map.embedUrl, /marker=36\.123456,120\.123456/);
    assert.equal(map.geoMissing.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("服务端与前端两份 VR 正向正则必须一致（禁止分裂出两套判定）", async () => {
  // 同一个「有 VR」判断在 server 归一和 client 渲染各有一份实现（前者决定
  // 工具结果里的 hasVr，后者决定结论表是否显示有 VR 但缺真实入口）。两份口径一旦
  // 分叉，就会出现「服务端说有、前端说没有」或反之的鬼影。这里直接比对正则源文。
  const { readFile } = await import("node:fs/promises");
  const pick = (source: string): string => {
    const match = source.match(/VR_POSITIVE_RE = (\/.*?\/i);/s);
    assert.ok(match?.[1], "未找到 VR_POSITIVE_RE 定义");
    return match[1];
  };
  const server = pick(await readFile(new URL("../../src/server/estate-result.ts", import.meta.url), "utf8"));
  const client = pick(await readFile(new URL("../../src/client/modules/conclusion-media.ts", import.meta.url), "utf8"));
  assert.equal(client, server, "两份 VR 正向正则必须逐字一致，改一处必须同步另一处");
  // 裸「全景」是已经踩过的坑，两边都不许把 全景 当成独立的顶层分支。
  // 注意 `VR\s*(?:看房|全景|链接)` 里的 |全景| 是合法共现（VR + 全景），
  // 不能按子串判；这里只拒绝「顶层 → 全景」与「全景 → 顶层」两种裸分支形态。
  const barePanorama = /\)\s*\|全景\)|\|全景\|\s*\(|^\(\?:\|全景|\)\|全景\/i$/;
  for (const [name, re] of [["server", server], ["client", client]] as const) {
    assert.doesNotMatch(re, barePanorama, `${name} 的 VR 正向正则不得把「全景」当独立顶层分支`);
  }
});
