/**
 * ============================================================
 * server/estate-result.ts — 贝壳 CLI 文本结果的领域归一化
 * ============================================================
 * 贝壳 detail / material 返回的是带 `<metadata>` 尾巴的文本块，图片与坐标
 * 又嵌在多层 JSON 字符串里。这里把“模型要读的业务事实”和“前端要画的富结果”
 * 归一成稳定契约，避免每个调用方各自猜字段。
 * 设计立场：只接受 https 图片；坐标按贝壳国内数据的“经度,纬度”解析并校验范围；
 * 原始数据仍随结果返回给模型，归一字段只用于可靠渲染，不篡改业务事实。
 */
import { buildMapLinks, buildPointMapEmbed, type GeocodePoint } from "./estate-geo.js";

const MAX_ESTATE_IMAGES = 12;
const MAX_STRING_DEPTH = 12;
const IMAGE_URL_RE = /https:\/\/[^\s"'<>\\]+?\.(?:jpe?g|png|webp|gif|avif)(?:[!?][^\s"'<>\\]*)?/gi;
const VR_URL_RE = /(?:https?:)?\/\/[^\s"'<>\\]+/gi;
const VR_KEY_RE = /(?:^|[_-])(?:vr|pano|panorama)(?:$|[_-])|(?:vr|pano|panorama)(?:url|link)|(?:VR|全景)(?:链接|看房|地址)?/i;
const VR_HINT_RE = /(?:\bvr\b|全景|panorama|virtual\s*tour)/i;
const VR_IMAGE_RE = /\.(?:jpe?g|png|webp|gif|avif)(?:[!?]|$)/i;
const VR_HOST_SUFFIXES = ["ke.com", "lianjia.com", "beike.com", "ljcdn.com"] as const;

export interface EstateLocation {
  lat: number;
  lng: number;
  label: string;
  address?: string;
  source: "beike";
  precision: "building" | "community";
  embedUrl: string;
  links: GeocodePoint["links"];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function collectStrings(value: unknown, output: string[], depth = 0): void {
  if (depth > MAX_STRING_DEPTH || value == null) return;
  if (typeof value === "string") {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, output, depth + 1);
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  for (const item of Object.values(record)) collectStrings(item, output, depth + 1);
}

/** 从文本/对象任意层级提取安全图片 URL；保留返回顺序并去重。 */
export function extractEstateImageUrls(value: unknown): string[] {
  const strings: string[] = [];
  collectStrings(value, strings);
  const images: string[] = [];
  const seen = new Set<string>();
  for (const text of strings) {
    for (const match of text.matchAll(IMAGE_URL_RE)) {
      const url = match[0].replace(/[),.;]+$/, "");
      if (!url || seen.has(url)) continue;
      seen.add(url);
      images.push(url);
      if (images.length >= MAX_ESTATE_IMAGES) return images;
    }
  }
  return images;
}

function normalizeEstateVrUrl(raw: string): string {
  let value = raw.trim()
    .replace(/\\u002f/gi, "/")
    .replace(/\\\//g, "/")
    .replace(/&amp;/gi, "&")
    .replace(/[),.;，。；]+$/, "");
  if (value.startsWith("//")) value = `https:${value}`;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return "";
    const host = url.hostname.toLowerCase();
    if (!VR_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return "";
    if (VR_IMAGE_RE.test(url.pathname)) return "";
    return url.toString();
  } catch {
    return "";
  }
}

/** 从 material/detail 任意嵌套字段提取贝壳官方 VR 链接；只接受官方域名和 HTTPS。 */
export function extractEstateVrUrl(value: unknown): string {
  const scan = (current: unknown, hinted: boolean, depth: number): string => {
    if (depth > MAX_STRING_DEPTH || current == null) return "";
    if (typeof current === "string") {
      const text = current.replace(/\\u002f/gi, "/").replace(/\\\//g, "/");
      if (!hinted && !VR_HINT_RE.test(text)) return "";
      for (const match of text.matchAll(VR_URL_RE)) {
        const url = normalizeEstateVrUrl(match[0]);
        if (url) return url;
      }
      return "";
    }
    if (Array.isArray(current)) {
      for (const item of current) {
        const hit = scan(item, hinted, depth + 1);
        if (hit) return hit;
      }
      return "";
    }
    const record = asRecord(current);
    if (!record) return "";
    for (const [key, item] of Object.entries(record)) {
      const hit = scan(item, hinted || VR_KEY_RE.test(key), depth + 1);
      if (hit) return hit;
    }
    return "";
  };
  return scan(value, false, 0);
}

/** 解析国内常见的“经度,纬度”字符串；兼容少量“纬度,经度”返回值。 */
export function parseEstateCoordinate(raw: string | undefined): { lat: number; lng: number } | null {
  if (!raw) return null;
  const parts = raw.trim().split(/\s*[,，]\s*/);
  if (parts.length !== 2) return null;
  const first = Number(parts[0]);
  const second = Number(parts[1]);
  if (!Number.isFinite(first) || !Number.isFinite(second)) return null;
  let lat = second;
  let lng = first;
  if (Math.abs(first) <= 90 && Math.abs(second) > 90) {
    lat = first;
    lng = second;
  }
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

function matchJsonStringField(strings: string[], field: string): string {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`"${escaped}"\\s*:\\s*"([^"]+)"`);
  for (const text of strings) {
    const hit = text.match(re)?.[1]?.trim();
    if (hit) return hit;
  }
  return "";
}

function firstAddressPart(raw: string): string {
  return raw.split(/[,，]/)[0]?.trim() || raw.trim();
}

/** 优先用小区坐标；贝壳隐藏楼栋坐标时仍能给出可核对的社区位置。 */
export function extractEstateLocation(data: unknown, city: string): EstateLocation | null {
  const strings: string[] = [];
  collectStrings(data, strings);
  const buildingCoordinate = parseEstateCoordinate(matchJsonStringField(strings, "楼栋经纬度"));
  const communityCoordinate = parseEstateCoordinate(matchJsonStringField(strings, "小区经纬度"));
  const coordinate = buildingCoordinate || communityCoordinate;
  if (!coordinate) return null;
  const precision = buildingCoordinate ? "building" : "community";
  const label = matchJsonStringField(strings, "小区名称")
    || matchJsonStringField(strings, "小区名")
    || city;
  const alias = matchJsonStringField(strings, "小区别名");
  const address = alias ? firstAddressPart(alias) : undefined;
  return {
    ...coordinate,
    label,
    ...(address ? { address } : {}),
    source: "beike",
    precision,
    embedUrl: buildPointMapEmbed(coordinate.lat, coordinate.lng),
    links: buildMapLinks(label, coordinate.lat, coordinate.lng, city),
  };
}

export function normalizeEstateDetail(data: unknown, houseId: string, city: string): Record<string, unknown> {
  const location = extractEstateLocation(data, city);
  const images = extractEstateImageUrls(data);
  const vr = extractEstateVrUrl(data);
  return {
    action: "detail",
    houseId,
    city,
    ...(location ? { location } : {}),
    ...(images.length ? { images } : {}),
    ...(vr ? { vr } : {}),
    presentation: { map: Boolean(location), images: images.length, vr: Boolean(vr) },
    data,
    note: location
      ? `位置来自贝壳详情的${location.precision === "building" ? "楼栋" : "小区"}经纬度；前端会直接渲染地图卡，地图失败时仍可用 location.links 核对。`
      : "贝壳详情未返回可解析的小区经纬度；需要地图时请把已知精确坐标传给 house_map 的 items.lat/lng，避免重新按地址猜测。",
  };
}

export function normalizeEstateMaterial(data: unknown, houseId: string): Record<string, unknown> {
  const images = extractEstateImageUrls(data);
  const vr = extractEstateVrUrl(data);
  return {
    action: "material",
    houseId,
    images,
    count: images.length,
    ...(vr ? { vr } : {}),
    presentation: { images: images.length, vr: Boolean(vr) },
    data,
    note: images.length || vr
      ? `${images.length ? "图片已归一为 images" : "VR 已归一为 vr"}，前端会直接展示；最终回答不要只贴裸 URL。`
      : "贝壳 material 未返回可展示的图片或 VR URL，请如实说明，不要编造图片或 VR 地址。",
  };
}
