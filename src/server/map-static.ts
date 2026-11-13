/**
 * ============================================================
 * map-static.ts — 高德官方静态地图服务端代理
 * ============================================================
 * 职责：把结论地图的坐标、缩放和卡片尺寸转成高德静态地图请求，在服务端
 * 携带 Web 服务 Key 取回 PNG 后返回浏览器。
 * 设计立场：Key 不进 DOM / 浏览器网络；不加载 JS SDK，不引入 unsafe-eval
 * 或内部 iframe。上游失败时返回明确错误，前端继续使用原生瓦片降级。
 */
import type { ServerResponse } from "node:http";
import { config } from "../config.js";
import { log } from "./logging.js";

const AMAP_STATIC_ENDPOINT = "https://restapi.amap.com/v3/staticmap";
const AMAP_REQUEST_TIMEOUT_MS = 15_000;
const MAX_AMAP_IMAGE_BYTES = 2_000_000; // 单张静态图上限，防止异常响应撑爆内存
const AMAP_MAX_ZOOM = 17;
const MAP_SIZES = {
  compact: "600*360",
  full: "900*480",
} as const;

export interface AmapStaticMapInput {
  lat: number;
  lng: number;
  zoom: number;
  variant: keyof typeof MAP_SIZES;
}

function coordinate(url: URL, name: "lat" | "lng", min: number, max: number): number {
  const raw = url.searchParams.get(name);
  const value = Number(raw);
  if (!raw || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`地图参数 ${name} 无效`);
  }
  return value;
}

/** URL 参数只接受有限坐标与两个固定尺寸，避免把代理变成任意图片抓取器。 */
export function parseAmapStaticMapQuery(url: URL): AmapStaticMapInput {
  const rawVariant = url.searchParams.get("variant") || "full";
  if (rawVariant !== "compact" && rawVariant !== "full") throw new Error("地图参数 variant 无效");
  const rawZoom = Number(url.searchParams.get("zoom"));
  const zoom = Number.isFinite(rawZoom) ? Math.min(AMAP_MAX_ZOOM, Math.max(3, Math.round(rawZoom))) : 14;
  return {
    lat: coordinate(url, "lat", -90, 90),
    lng: coordinate(url, "lng", -180, 180),
    zoom,
    variant: rawVariant,
  };
}

/** 使用服务端 Key 构造固定主机地址；导出便于单测校验参数，不用于前端直连。 */
export function buildAmapStaticMapUrl(input: AmapStaticMapInput, key: string): string {
  const location = `${input.lng.toFixed(6)},${input.lat.toFixed(6)}`;
  const query = new URLSearchParams({
    location,
    zoom: String(input.zoom),
    size: MAP_SIZES[input.variant],
    scale: "2",
    markers: `mid,0xE5604F,A:${location}`,
    traffic: "0",
    key,
  });
  return `${AMAP_STATIC_ENDPOINT}?${query.toString()}`;
}

function respondError(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: message }));
}

/** GET /api/map/static；成功直接返回图片，任何上游异常都不把 Key 或原始响应带给浏览器。 */
export async function handleAmapStaticMap(res: ServerResponse, url: URL): Promise<void> {
  let input: AmapStaticMapInput;
  try {
    input = parseAmapStaticMapQuery(url);
  } catch (err) {
    respondError(res, 400, err instanceof Error ? err.message : "地图参数无效");
    return;
  }

  const key = config.mapStatic.amapWebServiceKey;
  if (!key) {
    respondError(res, 503, "未配置 AMAP_WEB_SERVICE_KEY，结论地图将使用原生瓦片降级");
    return;
  }

  try {
    const upstream = await fetch(buildAmapStaticMapUrl(input, key), {
      headers: { Accept: "image/png,image/jpeg,image/webp" },
      signal: AbortSignal.timeout(AMAP_REQUEST_TIMEOUT_MS),
    });
    const contentType = (upstream.headers.get("content-type") || "").split(";")[0]?.trim().toLowerCase() || "";
    if (!upstream.ok || !contentType.startsWith("image/")) {
      log("warn", "amap_static_map_upstream_rejected", { status: upstream.status, contentType });
      respondError(res, 502, "高德静态地图暂时不可用，已回退原生瓦片");
      return;
    }
    const declaredLength = Number(upstream.headers.get("content-length") || 0);
    if (declaredLength > MAX_AMAP_IMAGE_BYTES) {
      respondError(res, 502, "高德静态地图响应过大");
      return;
    }
    const image = Buffer.from(await upstream.arrayBuffer());
    if (image.byteLength > MAX_AMAP_IMAGE_BYTES) {
      respondError(res, 502, "高德静态地图响应过大");
      return;
    }
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": String(image.byteLength),
      "Cache-Control": "private, max-age=300",
    });
    res.end(image);
  } catch (err) {
    log("warn", "amap_static_map_failed", {
      message: err instanceof Error ? err.message : String(err),
    });
    respondError(res, 502, "高德静态地图暂时不可用，已回退原生瓦片");
  }
}
