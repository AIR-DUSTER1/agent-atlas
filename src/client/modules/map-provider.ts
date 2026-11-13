/**
 * ============================================================
 * modules/map-provider.ts — 地图提供方坐标与原生瓦片适配
 * ============================================================
 * 职责：把服务端 /api/config 的地图配置转成浏览器可直接加载的瓦片 URL、世界像素与
 * 定位点。不同提供方只在这里处理坐标系、投影和 y 轴差异，结论渲染不写提供方分支。
 * 设计立场：全部使用原生瓦片图片直接渲染，绝不创建 iframe；配置缺失时回退高德。
 */
import type {
  MapCoordinateSystem,
  MapProviderId,
  MapRuntimeConfig,
} from "./types-api.js";

const PI = Math.PI;
const X_PI = PI * 3000 / 180;
const BAIDU_ZOOM_BASE = 18;

export const DEFAULT_MAP_CONFIG: MapRuntimeConfig = {
  provider: "amap",
  label: "高德地图",
  tileUrl: "https://{s}.is.autonavi.com/appmaptile?style=8&x={x}&y={y}&z={z}",
  subdomains: ["webst01", "webst02", "webst03", "webst04"],
  coordinateSystem: "gcj02",
  projection: "web-mercator",
  yAxis: "xyz",
  zoom: 14,
  tileSize: 256,
};

export interface MapCoordinate {
  lat: number;
  lng: number;
}

export interface ProjectedMapPoint extends MapCoordinate {
  worldX: number;
  worldY: number;
}

function validProvider(value: unknown): value is MapProviderId {
  return value === "amap" || value === "tencent" || value === "baidu" || value === "osm" || value === "custom";
}

function validCoordinateSystem(value: unknown): value is MapCoordinateSystem {
  return value === "wgs84" || value === "gcj02" || value === "bd09";
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** 服务端配置可能是旧进程的缺省形状；前端逐字段校验并回退，坏配置不会拖垮整张结论表。 */
export function resolveMapConfig(raw?: MapRuntimeConfig | null): MapRuntimeConfig {
  if (!raw) return DEFAULT_MAP_CONFIG;
  const provider = validProvider(raw.provider) ? raw.provider : DEFAULT_MAP_CONFIG.provider;
  const tileUrl = typeof raw.tileUrl === "string" && /^https:\/\//i.test(raw.tileUrl.trim())
    ? raw.tileUrl.trim()
    : DEFAULT_MAP_CONFIG.tileUrl;
  return {
    provider,
    label: typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : DEFAULT_MAP_CONFIG.label,
    tileUrl,
    subdomains: Array.isArray(raw.subdomains)
      ? raw.subdomains.filter((item): item is string => typeof item === "string" && /^[a-z0-9.-]+$/i.test(item))
      : DEFAULT_MAP_CONFIG.subdomains,
    coordinateSystem: validCoordinateSystem(raw.coordinateSystem) ? raw.coordinateSystem : DEFAULT_MAP_CONFIG.coordinateSystem,
    projection: raw.projection === "baidu" ? "baidu" : "web-mercator",
    yAxis: raw.yAxis === "tms" ? "tms" : "xyz",
    zoom: finite(raw.zoom) ? Math.max(3, Math.min(18, Math.round(raw.zoom))) : DEFAULT_MAP_CONFIG.zoom,
    tileSize: finite(raw.tileSize) ? Math.max(128, Math.min(512, Math.round(raw.tileSize))) : DEFAULT_MAP_CONFIG.tileSize,
  };
}

export function mapLinkKey(provider: MapProviderId): string {
  return provider === "tencent" ? "qq" : provider;
}

function outOfChina(lng: number, lat: number): boolean {
  return !(lng > 73.66 && lng < 135.05 && lat > 3.86 && lat < 53.55);
}

function transformLat(x: number, y: number): number {
  let value = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  value += (20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2 / 3;
  value += (20 * Math.sin(y * PI) + 40 * Math.sin(y / 3 * PI)) * 2 / 3;
  value += (160 * Math.sin(y / 12 * PI) + 320 * Math.sin(y * PI / 30)) * 2 / 3;
  return value;
}

function transformLng(x: number, y: number): number {
  let value = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  value += (20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2 / 3;
  value += (20 * Math.sin(x * PI) + 40 * Math.sin(x / 3 * PI)) * 2 / 3;
  value += (150 * Math.sin(x / 12 * PI) + 300 * Math.sin(x / 30 * PI)) * 2 / 3;
  return value;
}

export function wgs84ToGcj02(point: MapCoordinate): MapCoordinate {
  if (outOfChina(point.lng, point.lat)) return { ...point };
  let deltaLat = transformLat(point.lng - 105, point.lat - 35);
  let deltaLng = transformLng(point.lng - 105, point.lat - 35);
  const radLat = point.lat / 180 * PI;
  let magic = Math.sin(radLat);
  magic = 1 - 0.00669342162296594323 * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  deltaLat = deltaLat * 180 / ((6335552.717000426 / (magic * sqrtMagic)) * PI);
  deltaLng = deltaLng * 180 / ((6378245 / (sqrtMagic * Math.cos(radLat))) * PI);
  return { lat: point.lat + deltaLat, lng: point.lng + deltaLng };
}

export function gcj02ToBd09(point: MapCoordinate): MapCoordinate {
  const z = Math.sqrt(point.lng * point.lng + point.lat * point.lat) + 0.00002 * Math.sin(point.lat * X_PI);
  const theta = Math.atan2(point.lat, point.lng) + 0.000003 * Math.cos(point.lng * X_PI);
  return {
    lng: z * Math.cos(theta) + 0.0065,
    lat: z * Math.sin(theta) + 0.006,
  };
}

export function toMapCoordinate(lat: number, lng: number, system: MapCoordinateSystem): MapCoordinate {
  const wgs = { lat, lng };
  if (system === "wgs84") return wgs;
  const gcj = wgs84ToGcj02(wgs);
  return system === "bd09" ? gcj02ToBd09(gcj) : gcj;
}

const BAIDU_LL_BAND = [75, 60, 45, 30, 15, 0] as const;
const BAIDU_LL_TO_MC = [
  [-0.0015702102444, 111320.7020616939, 1704480524535203, -10338987376042340, 26112667856603880, -35149669176653700, 26595700718403920, -10725012454188240, 1800819912950474, 82.5],
  [0.0008277824516172526, 111320.7020463578, 647795574.6671607, -4082003173.641316, 10774905663.51142, -15171875531.51559, 12053065338.62167, -5124939663.577472, 913311935.9512032, 67.5],
  [0.00337398766765, 111320.7020202162, 4481351.045890365, -23393751.19931662, 79682215.47186455, -115964993.2797253, 97236711.15602145, -43661946.33752821, 8477230.501135234, 52.5],
  [0.00220636496208, 111320.7020209128, 51751.86112841131, 3796837.749470245, 992013.7397791013, -1221952.21711287, 1340652.697009075, -620943.6990984312, 144416.9293806241, 37.5],
  [-0.0003441963504368392, 111320.7020576856, 278.2353980772752, 2485758.690035394, 6070.750963243378, 54821.18345352118, 9540.606633304236, -2710.55326746645, 1405.483844121726, 22.5],
  [-0.0003218135878613132, 111320.7020701615, 0.00369383431289, 823725.6402795718, 0.46104986909093, 2351.343141331292, 1.58060784298199, 8.77738589078284, 0.37238884252424, 7.45],
] as const;

function bd09ToBaiduMercator(point: MapCoordinate): { x: number; y: number } {
  let factors = BAIDU_LL_TO_MC[BAIDU_LL_TO_MC.length - 1];
  for (let index = 0; index < BAIDU_LL_BAND.length; index += 1) {
    if (Math.abs(point.lat) > BAIDU_LL_BAND[index]) {
      factors = BAIDU_LL_TO_MC[index];
      break;
    }
  }
  const scaledLat = Math.abs(point.lat) / factors[9];
  const x = factors[0] + factors[1] * Math.abs(point.lng);
  let y = factors[2];
  for (let power = 1; power <= 6; power += 1) y += factors[power + 2] * scaledLat ** power;
  return {
    x: point.lng < 0 ? -x : x,
    y: point.lat < 0 ? -y : y,
  };
}

function webMercatorWorldPixel(point: MapCoordinate, config: MapRuntimeConfig): { x: number; y: number } {
  const worldSize = config.tileSize * 2 ** config.zoom;
  const latitude = Math.max(-85.05112878, Math.min(85.05112878, point.lat));
  return {
    x: (point.lng + 180) / 360 * worldSize,
    y: (1 - Math.asinh(Math.tan(latitude * PI / 180)) / PI) / 2 * worldSize,
  };
}

export function projectMapPoint(lat: number, lng: number, rawConfig?: MapRuntimeConfig | null): ProjectedMapPoint {
  const config = resolveMapConfig(rawConfig);
  const coordinate = toMapCoordinate(lat, lng, config.coordinateSystem);
  if (config.projection === "baidu") {
    const mercator = bd09ToBaiduMercator(coordinate);
    const scale = 2 ** (BAIDU_ZOOM_BASE - config.zoom);
    return { ...coordinate, worldX: mercator.x / scale, worldY: mercator.y / scale };
  }
  const pixel = webMercatorWorldPixel(coordinate, config);
  return { ...coordinate, worldX: pixel.x, worldY: pixel.y };
}

export function mapTileUrl(tileX: number, tileY: number, config: MapRuntimeConfig): string {
  const normalized = resolveMapConfig(config);
  const requestY = normalized.yAxis === "tms" ? 2 ** normalized.zoom - 1 - tileY : tileY;
  const subdomains = normalized.subdomains;
  const subdomain = subdomains.length
    ? subdomains[Math.abs(tileX + tileY + normalized.zoom) % subdomains.length] || subdomains[0] || ""
    : "";
  return normalized.tileUrl
    .replaceAll("{s}", subdomain)
    .replaceAll("{x}", String(tileX))
    .replaceAll("{y}", String(requestY))
    .replaceAll("{z}", String(normalized.zoom));
}