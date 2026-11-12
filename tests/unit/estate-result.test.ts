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
  normalizeEstateDetail,
  normalizeEstateMaterial,
  parseEstateCoordinate,
} from "../../src/server/estate-result.js";
import { buildCompareMap } from "../../src/server/estate-geo.js";

const IMAGE_ONE = "https://ke-image.ljcdn.com/frame/floorplan.jpg!m_fit,h_843,w_1125,l_fbk_v1,lo_0.22,f_jpg";
const IMAGE_TWO = "https://ke-image.ljcdn.com/frame/living-room.webp?x=1";

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
    "<metadata>{\"entity_ids\":[\"10001\"]}</metadata>",
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

  const normalized = normalizeEstateDetail(detailPayload(), "10001", "青岛") as Record<string, any>;
  assert.equal(normalized.action, "detail");
  assert.equal(normalized.houseId, "10001");
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

test("material 归一化：https 图片 URL 去重后直接进入 images", () => {
  const raw = JSON.stringify({ 10001: { 房源图片: { 户型图片: IMAGE_ONE, 客厅图片: IMAGE_TWO } } }) +
    `\n重复：${IMAGE_ONE}\n不安全：http://example.test/a.jpg`;
  assert.deepEqual(extractEstateImageUrls(raw), [IMAGE_ONE, IMAGE_TWO]);
  const normalized = normalizeEstateMaterial(raw, "10001") as Record<string, any>;
  assert.equal(normalized.action, "material");
  assert.equal(normalized.count, 2);
  assert.deepEqual(normalized.images, [IMAGE_ONE, IMAGE_TWO]);
  assert.equal(normalized.presentation.images, 2);
  assert.match(normalized.note, /直接展示/);
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
