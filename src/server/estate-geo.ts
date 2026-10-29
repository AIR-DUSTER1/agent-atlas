/**
 * ============================================================
 * estate-geo.ts — 区位对比地图：地址 → 坐标 + 免 key 地图直链
 * ============================================================
 * 职责：用 Nominatim（OSM 免费无 key）把候选小区/地址解析成经纬度，
 * 再组装 OSM embed iframe 与高德 / 腾讯 / 百度三家的 marker 直链。
 * 设计立场：
 *  - 公开服务限约 1 req/s：全局串行队列 + 最小间隔，绝不并发打；
 *  - 结果进内存缓存（上限 200 条），重复查询不再打网络；
 *  - 解析失败的候选**不丢弃**：改为带搜索直链的「未定位」条目，交前端展示；
 *  - 所有直链都是免 key 的官方 Web 入口（不引 SDK、不需要前端依赖）。
 */

import { PRODUCT_NAME, PRODUCT_USER_AGENT } from "../product.js";

const GEOCODE_TIMEOUT_MS = 8_000;         // 单次 Nominatim 请求
const GEOCODE_MIN_INTERVAL_MS = 1_100;    // 公开服务限约 1 req/s，排队串行
const GEOCODE_CACHE_MAX = 200;            // 地址 → 坐标缓存上限
const GEOCODE_MAX_ITEMS = 6;              // 单次地图对比最多同时定位几个点

/** Nominatim 要求带可识别的 UA，否则可能被拒 */
const NOMINATIM_UA = `${PRODUCT_USER_AGENT} (local agent tools)`;

// ---------------------------------------------------------------------------
// 区位 geocode：Nominatim（无 key）+ 串行限速 + 内存缓存
// 出口形状（tools-estate.ts 组装给前端专属渲染）：
//   { points:[{name,address,lat,lng,links}], geoMissing:[...], embedUrl, city }
// ---------------------------------------------------------------------------
export interface GeocodePoint {
  name: string;
  address?: string;
  lat: number;
  lng: number;
  source: string;
  links: { amap: string; qq: string; baidu: string; osm: string };
}

const geocodeCache = new Map<string, { lat: number; lng: number; address: string } | null>();
let geocodeQueue: Promise<void> = Promise.resolve();

function b64(input: string): string {
  return encodeURIComponent(input);
}

/** 三家国内地图 + OSM 的直达链接（无 key；uri 协议链接浏览器直接打开） */
export function buildMapLinks(name: string, lat: number, lng: number, city: string): GeocodePoint["links"] {
  const label = `${name}（${city}）`;
  return {
    amap: `https://uri.amap.com/marker?position=${lng},${lat}&name=${b64(name)}&src=${PRODUCT_NAME}&callnative=0`,
    qq: `https://apis.map.qq.com/uri/v1/marker?marker=coord:${lat},${lng};title:${b64(name)};addr:${b64(city)}&referer=${PRODUCT_NAME}`,
    baidu: `https://api.map.baidu.com/marker?location=${lat},${lng}&title=${b64(name)}&content=${b64(label)}&output=html&src=${PRODUCT_NAME}`,
    osm: `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=16/${lat}/${lng}`,
  };
}

/** 未定位的点也给出「名称搜索直链」（不需要坐标） */
export function searchLinks(name: string, city: string): GeocodePoint["links"] {
  return {
    amap: `https://uri.amap.com/search?keyword=${b64(name)}&city=${b64(city)}&src=${PRODUCT_NAME}`,
    qq: `https://apis.map.qq.com/uri/v1/search?keyword=${b64(name)}&region=${b64(city)}&referer=${PRODUCT_NAME}`,
    baidu: `https://api.map.baidu.com/place/search?query=${b64(name)}&region=${b64(city)}&output=html&src=${PRODUCT_NAME}`,
    osm: `https://www.openstreetmap.org/search?query=${b64(city + " " + name)}`,
  };
}

async function nominatimFetch(query: string): Promise<{ lat: number; lng: number; address: string } | null> {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&accept-language=zh&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: { "User-Agent": NOMINATIM_UA, "Accept-Language": "zh" },
    signal: AbortSignal.timeout(GEOCODE_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const rows = (await res.json()) as Array<{ lat?: string; lon?: string; display_name?: string }>;
  const hit = Array.isArray(rows) ? rows[0] : undefined;
  const lat = Number(hit?.lat);
  const lng = Number(hit?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng, address: String(hit?.display_name ?? "") };
}

/** 单点定位：缓存命中直接回，未命中则进串行队列（≥1.1s 间隔）。失败返回 null（不抛） */
export function geocodeAddress(name: string, city: string): Promise<{ lat: number; lng: number; address: string } | null> {
  const key = `${city}|${name}`;
  if (geocodeCache.has(key)) return Promise.resolve(geocodeCache.get(key) ?? null);
  const run = geocodeQueue.then(async () => {
    const started = Date.now();
    try {
      const r = await nominatimFetch(`${city} ${name}`);
      geocodeCache.set(key, r);
      if (geocodeCache.size > GEOCODE_CACHE_MAX) {
        geocodeCache.delete(geocodeCache.keys().next().value as string);
      }
      return r;
    } catch {
      geocodeCache.set(key, null); // 网络失败也别短时间内重试
      return null;
    } finally {
      // 无论成败都垫够节奏时间，保证上游 1 req/s 限速不被单点超时击穿
      const wait = Math.max(0, GEOCODE_MIN_INTERVAL_MS - (Date.now() - started));
      await new Promise((sleepP) => setTimeout(sleepP, wait));
    }
  });
  geocodeQueue = run.then(() => undefined, () => undefined);
  return run;
}

export const GEOCODE_LIMITS = { maxItems: GEOCODE_MAX_ITEMS };

/** 多点对比结果组装（tools-estate.ts 的 house_map 调用） */
export async function buildCompareMap(
  items: Array<{ name: string; address?: string }>,
  city: string
): Promise<{
  points: GeocodePoint[];
  geoMissing: Array<{ name: string; links: GeocodePoint["links"] }>;
  embedUrl: string;
  city: string;
}> {
  const capped = items.slice(0, GEOCODE_MAX_ITEMS);
  const located: GeocodePoint[] = [];
  const missing: Array<{ name: string; links: GeocodePoint["links"] }> = [];
  for (const item of capped) {
    const target = item.address?.trim() || item.name;
    const hit = await geocodeAddress(target, city);
    if (hit) {
      located.push({
        name: item.name,
        address: hit.address,
        lat: hit.lat,
        lng: hit.lng,
        source: "nominatim",
        links: buildMapLinks(item.name, hit.lat, hit.lng, city),
      });
    } else {
      missing.push({ name: item.name, links: searchLinks(target, city) });
    }
  }
  // OSM embed iframe：bbox 覆盖全部已定位点（留 ~0.02° 边距）；单点附加 marker
  let embedUrl = "";
  if (located.length) {
    const lats = located.map((p) => p.lat);
    const lngs = located.map((p) => p.lng);
    const pad = 0.02;
    const minLat = Math.min(...lats) - pad;
    const maxLat = Math.max(...lats) + pad;
    const minLng = Math.min(...lngs) - pad;
    const maxLng = Math.max(...lngs) + pad;
    const one = located[0];
    embedUrl =
      `https://www.openstreetmap.org/export/embed.html?bbox=${minLng},${minLat},${maxLng},${maxLat}&layer=mapnik` +
      (located.length === 1 ? `&marker=${one.lat},${one.lng}` : "");
  }
  return { points: located, geoMissing: missing, embedUrl, city };
}
