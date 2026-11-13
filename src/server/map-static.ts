/**
 * ============================================================
 * map-static.ts — 国内地图官方静态图服务端代理
 * ============================================================
 * 职责：把结论地图的 provider、坐标、缩放和卡片尺寸转成高德/腾讯/百度
 * 官方静态图请求，在服务端携带 Web 服务 Key 取回图片后返回浏览器。
 * 设计立场：Key 不进 DOM / 浏览器网络；不加载地图 JS SDK，不引入
 * unsafe-eval 或内部 iframe。上游失败时返回明确错误，前端继续使用原生瓦片降级。
 */
import type { ServerResponse } from "node:http";
import { config } from "../config.js";
import { log } from "./logging.js";

const AMAP_STATIC_ENDPOINT = "https://restapi.amap.com/v3/staticmap";
const TENCENT_STATIC_ENDPOINT = "https://apis.map.qq.com/ws/staticmap/v2/";
const BAIDU_STATIC_ENDPOINT = "https://api.map.baidu.com/staticimage/v2";
const STATIC_MAP_REQUEST_TIMEOUT_MS = 15_000;
const MAX_STATIC_IMAGE_BYTES = 2_000_000; // 单张静态图上限，防止异常响应撑爆内存
const STATIC_MAP_MAX_ZOOM = 18;
const MAP_SIZES = {
  compact: { width: 600, height: 360, amap: "600*360", tencent: "600*360" },
  full: { width: 900, height: 480, amap: "900*480", tencent: "900*480" },
} as const;

export type StaticMapProvider = "amap" | "tencent" | "baidu";

export interface StaticMapInput {
  provider: StaticMapProvider;
  lat: number;
  lng: number;
  zoom: number;
  variant: keyof typeof MAP_SIZES;
}

const KEY_ENV_NAMES: Record<StaticMapProvider, string> = {
  amap: "AMAP_WEB_SERVICE_KEY",
  tencent: "TENCENT_MAP_KEY",
  baidu: "BAIDU_MAP_AK",
};

const PROVIDER_LABELS: Record<StaticMapProvider, string> = {
  amap: "高德",
  tencent: "腾讯",
  baidu: "百度",
};

function isStaticMapProvider(value: string): value is StaticMapProvider {
  return value === "amap" || value === "tencent" || value === "baidu";
}

function coordinate(url: URL, name: "lat" | "lng", min: number, max: number): number {
  const raw = url.searchParams.get(name)?.trim();
  const value = Number(raw);
  if (!raw || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`地图参数 ${name} 无效`);
  }
  return value;
}

/** URL 参数只接受三家固定 provider、有限坐标与两个固定尺寸，避免代理沦为任意抓图器。 */
export function parseStaticMapQuery(url: URL): StaticMapInput {
  const rawProvider = (url.searchParams.get("provider") || "amap").trim().toLowerCase();
  if (!isStaticMapProvider(rawProvider)) throw new Error("地图参数 provider 无效");
  const rawVariant = url.searchParams.get("variant") || "full";
  if (rawVariant !== "compact" && rawVariant !== "full") throw new Error("地图参数 variant 无效");
  const rawZoom = url.searchParams.get("zoom");
  const parsedZoom = Number(rawZoom);
  const zoom = rawZoom !== null && Number.isFinite(parsedZoom)
    ? Math.min(STATIC_MAP_MAX_ZOOM, Math.max(3, Math.round(parsedZoom)))
    : 14;
  return {
    provider: rawProvider,
    lat: coordinate(url, "lat", -90, 90),
    lng: coordinate(url, "lng", -180, 180),
    zoom,
    variant: rawVariant,
  };
}

function amapStaticUrl(input: StaticMapInput, key: string): string {
  const location = `${input.lng.toFixed(6)},${input.lat.toFixed(6)}`;
  const query = new URLSearchParams({
    location,
    zoom: String(Math.min(17, input.zoom)),
    size: MAP_SIZES[input.variant].amap,
    scale: "2",
    markers: `mid,0xE5604F,A:${location}`,
    traffic: "0",
    key,
  });
  return `${AMAP_STATIC_ENDPOINT}?${query.toString()}`;
}

function tencentStaticUrl(input: StaticMapInput, key: string): string {
  const location = `${input.lat.toFixed(6)},${input.lng.toFixed(6)}`;
  const query = new URLSearchParams({
    center: location,
    zoom: String(input.zoom),
    size: MAP_SIZES[input.variant].tencent,
    scale: "2",
    markers: `size:mid|color:red|label:A|${location}`,
    key,
  });
  return `${TENCENT_STATIC_ENDPOINT}?${query.toString()}`;
}

function baiduStaticUrl(input: StaticMapInput, key: string): string {
  const size = MAP_SIZES[input.variant];
  const location = `${input.lng.toFixed(6)},${input.lat.toFixed(6)}`;
  const query = new URLSearchParams({
    center: location,
    width: String(size.width),
    height: String(size.height),
    zoom: String(input.zoom),
    markers: location,
    markerStyles: "l,0xE5604F",
    ak: key,
  });
  return `${BAIDU_STATIC_ENDPOINT}?${query.toString()}`;
}

/** 使用固定官方主机构造请求；导出便于单测校验参数，绝不用于前端直连。 */
export function buildStaticMapUrl(input: StaticMapInput, key: string): string {
  if (input.provider === "tencent") return tencentStaticUrl(input, key);
  if (input.provider === "baidu") return baiduStaticUrl(input, key);
  return amapStaticUrl(input, key);
}

function staticMapKey(provider: StaticMapProvider): string {
  if (provider === "tencent") return config.mapStatic.tencentWebServiceKey;
  if (provider === "baidu") return config.mapStatic.baiduWebServiceKey;
  return config.mapStatic.amapWebServiceKey;
}

function respondError(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: message }));
}

/** GET /api/map/static；成功直接返回图片，任何上游异常都不把 Key 或原始响应带给浏览器。 */
export async function handleStaticMap(res: ServerResponse, url: URL): Promise<void> {
  let input: StaticMapInput;
  try {
    input = parseStaticMapQuery(url);
  } catch (err) {
    respondError(res, 400, err instanceof Error ? err.message : "地图参数无效");
    return;
  }

  const key = staticMapKey(input.provider);
  if (!key) {
    respondError(res, 503, `未配置 ${KEY_ENV_NAMES[input.provider]}，${PROVIDER_LABELS[input.provider]}结论地图将使用原生瓦片降级`);
    return;
  }

  try {
    const upstream = await fetch(buildStaticMapUrl(input, key), {
      headers: { Accept: "image/png,image/jpeg,image/webp" },
      signal: AbortSignal.timeout(STATIC_MAP_REQUEST_TIMEOUT_MS),
    });
    const contentType = (upstream.headers.get("content-type") || "").split(";")[0]?.trim().toLowerCase() || "";
    if (!upstream.ok || !contentType.startsWith("image/")) {
      log("warn", "static_map_upstream_rejected", { provider: input.provider, status: upstream.status, contentType });
      respondError(res, 502, `${PROVIDER_LABELS[input.provider]}静态地图暂时不可用，已回退原生瓦片`);
      return;
    }
    const declaredLength = Number(upstream.headers.get("content-length") || 0);
    if (declaredLength > MAX_STATIC_IMAGE_BYTES) {
      respondError(res, 502, "静态地图响应过大");
      return;
    }
    const image = Buffer.from(await upstream.arrayBuffer());
    if (image.byteLength > MAX_STATIC_IMAGE_BYTES) {
      respondError(res, 502, "静态地图响应过大");
      return;
    }
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": String(image.byteLength),
      "Cache-Control": "private, max-age=300",
    });
    res.end(image);
  } catch (err) {
    log("warn", "static_map_failed", {
      provider: input.provider,
      message: err instanceof Error ? err.message : String(err),
    });
    respondError(res, 502, `${PROVIDER_LABELS[input.provider]}静态地图暂时不可用，已回退原生瓦片`);
  }
}
