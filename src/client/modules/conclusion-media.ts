/**
 * ============================================================
 * modules/conclusion-media.ts — 房产结论表格的数据归一
 * ============================================================
 * 同一轮会同时出现 search / detail / material / map。这里按 houseId 把
 * 房源事实、户型图、VR 与位置合并成一张表；houseId 仅用于内部匹配，绝不进入
 * 用户可见标题。模型文字里的原始 ID 也由本模块提供确定性脱敏。
 */
import type { AssistantPart } from "./types.js";

const MAX_CONCLUSION_IMAGES = 6;
const MAX_CONCLUSION_PROPERTIES = 5;
const MAX_CONCLUSION_POINTS = 8;
const VR_URL_RE = /(?:https?:)?\/\/[^\s"'<>\\]+/gi;
const VR_KEY_RE = /(?:^|[_-])(?:vr|pano|panorama)(?:$|[_-])|(?:vr|pano|panorama)(?:url|link)|(?:VR|全景)(?:链接|看房|地址)?/i;
const VR_HINT_RE = /(?:\bvr\b|全景|panorama|virtual\s*tour)/i;
const VR_IMAGE_RE = /\.(?:jpe?g|png|webp|gif|avif)(?:[!?]|$)/i;
const VR_HOST_SUFFIXES = ["ke.com", "lianjia.com", "beike.com", "ljcdn.com"] as const;

export interface ConclusionPoint {
  name: string;
  address?: string;
  lat?: number;
  lng?: number;
  precision?: string;
  houseId?: string;
  embedUrl?: string;
  links?: Record<string, string>;
}

export interface ConclusionImage {
  src: string;
  alt: string;
  houseId?: string;
}

export interface ConclusionProperty {
  houseId: string;
  title: string;
  community?: string;
  layout?: string;
  area?: string;
  rent?: string;
  floor?: string;
  orientation?: string;
  decoration?: string;
  address?: string;
  images: ConclusionImage[];
  location?: ConclusionPoint;
  vrUrl?: string;
}

export interface EstateConclusionMedia {
  mapEmbedUrl: string;
  mapTitle: string;
  points: ConclusionPoint[];
  images: ConclusionImage[];
  properties: ConclusionProperty[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safeMapEmbed(raw: unknown): string {
  const value = text(raw);
  return /^https:\/\/www\.openstreetmap\.org\//i.test(value) ? value : "";
}

function safeImage(raw: unknown): string {
  const value = text(raw);
  return /^https:\/\//i.test(value) || /^data:image\/(?:png|jpe?g|gif|webp|svg\+xml);base64,/i.test(value)
    ? value
    : "";
}

function safeVrUrl(raw: unknown): string {
  let value = text(raw)
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

function vrUrlFrom(value: unknown, hinted = false, depth = 0): string {
  if (depth > 12 || value == null) return "";
  if (typeof value === "string") {
    const raw = value.replace(/\\u002f/gi, "/").replace(/\\\//g, "/");
    if (!hinted && !VR_HINT_RE.test(raw)) return "";
    for (const match of raw.matchAll(VR_URL_RE)) {
      const url = safeVrUrl(match[0]);
      if (url) return url;
    }
    return "";
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = vrUrlFrom(item, hinted, depth + 1);
      if (hit) return hit;
    }
    return "";
  }
  const record = asRecord(value);
  if (!record) return "";
  for (const [key, item] of Object.entries(record)) {
    const hit = vrUrlFrom(item, hinted || VR_KEY_RE.test(key), depth + 1);
    if (hit) return hit;
  }
  return "";
}

function inferHouseId(raw: string): string {
  return firstMatch(raw, /<(\d{6,})>/)
    || firstMatch(raw, /"?(\d{9,})"?\s*:/)
    || firstMatch(raw, /"房源ID"\s*:\s*"(\d{6,})"/);
}

function rawImages(raw: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const match of raw.matchAll(/https:\/\/[^\s"'<>\\]+?\.(?:jpe?g|png|webp|gif|avif)(?:[!?][^\s"'<>\\]*)?/gi)) {
    const src = safeImage(match[0].replace(/[),.;]+$/, ""));
    if (src && !seen.has(src)) { seen.add(src); urls.push(src); }
  }
  return urls;
}

function parseCoordinate(raw: string): { lat: number; lng: number } | null {
  const parts = raw.trim().split(/\s*[,，]\s*/);
  if (parts.length !== 2) return null;
  const first = Number(parts[0]);
  const second = Number(parts[1]);
  if (!Number.isFinite(first) || !Number.isFinite(second)) return null;
  let lat = second;
  let lng = first;
  if (Math.abs(first) <= 90 && Math.abs(second) > 90) { lat = first; lng = second; }
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

function locationFromRaw(data: unknown, houseId?: string): ConclusionPoint | null {
  const raw = rawText(data);
  const building = parseCoordinate(field(raw, ["楼栋经纬度"]));
  const community = parseCoordinate(field(raw, ["小区经纬度"]));
  const coordinate = building || community;
  if (!coordinate) return null;
  const name = field(raw, ["小区名称", "小区名"]) || "房源位置";
  const alias = field(raw, ["小区别名"]).split(/[,，]/)[0]?.trim();
  const encoded = encodeURIComponent(name);
  return {
    name,
    ...(alias ? { address: alias } : {}),
    ...coordinate,
    precision: building ? "building" : "community",
    ...(houseId ? { houseId } : {}),
    embedUrl: `https://www.openstreetmap.org/export/embed.html?bbox=${coordinate.lng - 0.012},${coordinate.lat - 0.012},${coordinate.lng + 0.012},${coordinate.lat + 0.012}&layer=mapnik&marker=${coordinate.lat},${coordinate.lng}`,
    links: {
      amap: `https://uri.amap.com/marker?position=${coordinate.lng},${coordinate.lat}&name=${encoded}&src=agentatlas&callnative=0`,
      qq: `https://apis.map.qq.com/uri/v1/marker?marker=coord:${coordinate.lat},${coordinate.lng};title:${encoded}&referer=agentatlas`,
      baidu: `https://api.map.baidu.com/marker?location=${coordinate.lat},${coordinate.lng}&title=${encoded}&output=html&src=agentatlas`,
      osm: `https://www.openstreetmap.org/?mlat=${coordinate.lat}&mlon=${coordinate.lng}#map=16/${coordinate.lat}/${coordinate.lng}`,
    },
  };
}

function stringLinks(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const links: Record<string, string> = {};
  for (const [key, raw] of Object.entries(record)) {
    const href = text(raw);
    if (href) links[key] = href;
  }
  return Object.keys(links).length ? links : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rawText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try { return JSON.stringify(value); } catch { return ""; }
}

function field(raw: string, names: string[]): string {
  for (const name of names) {
    const re = new RegExp(`"${escapeRegExp(name)}"\\s*:\\s*"([^"]+)"`);
    const hit = raw.match(re)?.[1]?.trim();
    if (hit) return hit;
  }
  return "";
}

function firstMatch(raw: string, pattern: RegExp): string {
  return raw.match(pattern)?.[1]?.trim() || "";
}

function propertyTitle(community: string, layout: string, area: string): string {
  return [community, layout, area].filter(Boolean).join(" · ") || "房源详情";
}

/** 从面积/租金中提取数值，只用于和最终回答做轻量匹配。 */
function firstNumber(value: string): string {
  return value.replace(/[,，\s]/g, "").match(/\d+(?:\.\d+)?/)?.[0] || "";
}

/** 分句匹配，避免把回答中另一个房源的面积或租金错误套到当前房源。 */
function normalizedAnswerSegments(answerText: string): string[] {
  return answerText
    .replace(/[,，\s]/g, "")
    .split(/[。；;\n]+/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

/**
 * 最终回答是用户真正看到的结论。只有同一句中同时命中面积、户型和/或租金的
 * 房源才优先进入表格，防止搜索前五条挤掉模型最终推荐的房源。
 */
function propertyMentionScore(property: ConclusionProperty, segments: string[]): number {
  const titleArea = firstMatch(property.title, /([\d.]+\s*(?:㎡|平|m²))/i);
  const area = firstNumber(property.area || titleArea);
  if (!area) return 0;
  const rent = firstNumber(property.rent || "");
  const layout = property.layout || firstMatch(property.title, /(\d+室\d+厅)/);
  const areaRe = new RegExp(`${escapeRegExp(area)}(?:㎡|平|m²)`, "i");
  const rentRe = rent ? new RegExp(`(?:¥|￥)?${escapeRegExp(rent)}(?:元|/月|每月)`, "i") : null;
  let best = 0;
  for (const segment of segments) {
    if (!areaRe.test(segment)) continue;
    let score = 1;
    if (rentRe?.test(segment)) score += 3;
    if (layout && segment.includes(layout)) score += 2;
    best = Math.max(best, score);
  }
  return best;
}

function addUniqueImage(target: ConclusionImage[], seen: Set<string>, raw: unknown, houseId?: string): void {
  if (target.length >= MAX_CONCLUSION_IMAGES) return;
  const src = safeImage(raw);
  if (!src || seen.has(src)) return;
  seen.add(src);
  target.push({
    src,
    alt: `房源${houseId ? "户型图" : "图片"} ${target.length + 1}`,
    ...(houseId ? { houseId } : {}),
  });
}

function parseSearchRaw(data: unknown): Array<Partial<ConclusionProperty> & { houseId: string }> {
  const raw = rawText(data);
  const rows: Array<Partial<ConclusionProperty> & { houseId: string }> = [];
  if (!raw) return rows;
  // 贝壳 search 的 data 是字符串，房源块形如 <103155273255>...</103155273255>。
  const blockRe = /<(\d{6,})>\s*([\s\S]*?)<\/\1>/g;
  for (const match of raw.matchAll(blockRe)) {
    const houseId = match[1] || "";
    const body = match[2] || "";
    const detail = field(body, ["户型信息"]);
    const layout = firstMatch(detail, /(\d+室\d+厅)/);
    const area = firstMatch(detail, /出租面积\s*([\d.]+\s*㎡)/).replace(/\s+/g, "");
    const orientation = firstMatch(detail, /朝向\s*([^，,]+)/);
    const rent = field(body, ["租赁价格"]);
    const traffic = field(body, ["区位交通"]);
    const community = firstMatch(traffic, /板块\s*([^，,。]+?)小区/)
      || firstMatch(traffic, /小区\s*([^，,。]+)/);
    const vrUrl = vrUrlFrom(body);
    rows.push({
      houseId,
      ...(community ? { community } : {}),
      ...(layout ? { layout } : {}),
      ...(area ? { area } : {}),
      ...(rent ? { rent } : {}),
      ...(orientation ? { orientation } : {}),
      ...(traffic ? { address: traffic } : {}),
      ...(vrUrl ? { vrUrl } : {}),
      title: propertyTitle(community, layout, area),
    });
  }
  return rows;
}

function parseListingObjects(listings: unknown): Array<Partial<ConclusionProperty> & { houseId: string }> {
  if (!Array.isArray(listings)) return [];
  const rows: Array<Partial<ConclusionProperty> & { houseId: string }> = [];
  for (const item of listings) {
    const record = asRecord(item);
    const houseId = text(record?.id) || text(record?.houseId);
    if (!houseId) continue;
    const title = text(record?.title) || text(record?.name);
    const rent = text(record?.price);
    const area = text(record?.area);
    const address = text(record?.addressText) || text(record?.address);
    const vrUrl = vrUrlFrom(record);
    rows.push({
      houseId,
      ...(title ? { title } : {}),
      ...(rent ? { rent } : {}),
      ...(area ? { area } : {}),
      ...(address ? { address } : {}),
      ...(vrUrl ? { vrUrl } : {}),
    });
  }
  return rows;
}

function factsFromDetail(data: unknown): Partial<ConclusionProperty> {
  const raw = rawText(data);
  const community = field(raw, ["小区名", "小区名称"]);
  const layout = field(raw, ["房型"]);
  const area = field(raw, ["出租面积"]);
  const rent = field(raw, ["租赁价格"]);
  const floor = field(raw, ["房源所属楼层"]);
  const orientation = field(raw, ["出租朝向"]);
  const decoration = field(raw, ["装修"]);
  const vrUrl = vrUrlFrom(data);
  return {
    ...(community ? { community } : {}),
    ...(layout ? { layout } : {}),
    ...(area ? { area } : {}),
    ...(rent ? { rent } : {}),
    ...(floor ? { floor } : {}),
    ...(orientation ? { orientation } : {}),
    ...(decoration ? { decoration } : {}),
    ...(vrUrl ? { vrUrl } : {}),
    ...(community || layout || area ? { title: propertyTitle(community, layout, area) } : {}),
  };
}

function locationFromPayload(location: Record<string, unknown>, houseId?: string): ConclusionPoint | null {
  const name = text(location.label) || text(location.name);
  const links = stringLinks(location.links);
  if (!name && number(location.lat) === undefined && number(location.lng) === undefined) return null;
  return {
    name: name || "房源位置",
    ...(text(location.address) ? { address: text(location.address) } : {}),
    ...(number(location.lat) !== undefined ? { lat: number(location.lat) } : {}),
    ...(number(location.lng) !== undefined ? { lng: number(location.lng) } : {}),
    ...(text(location.precision) ? { precision: text(location.precision) } : {}),
    ...(houseId ? { houseId } : {}),
    ...(safeMapEmbed(location.embedUrl) ? { embedUrl: safeMapEmbed(location.embedUrl) } : {}),
    ...(links ? { links } : {}),
  };
}

function pointKey(point: ConclusionPoint): string {
  return [point.name, point.address || "", point.lat ?? "", point.lng ?? ""].join("|");
}

function mergeProperty(
  rows: Map<string, ConclusionProperty>,
  order: string[],
  houseId: string,
  patch: Partial<ConclusionProperty>,
): void {
  if (!houseId) return;
  let row = rows.get(houseId);
  if (!row) {
    row = { houseId, title: "", images: [] };
    rows.set(houseId, row);
    order.push(houseId);
  }
  for (const key of ["title", "community", "layout", "area", "rent", "floor", "orientation", "decoration", "address", "vrUrl"] as const) {
    const value = text(patch[key]);
    if (value) row[key] = value;
  }
  if (patch.location) row.location = patch.location;
}

/** 解析并去重；详情地图优先，其次 house_map 的多点分布图。 */
export function collectEstateConclusionMedia(parts: AssistantPart[], answerText = ""): EstateConclusionMedia {
  let detailMap = "";
  let comparisonMap = "";
  let mapTitle = "";
  const points: ConclusionPoint[] = [];
  const pointSeen = new Set<string>();
  const images: ConclusionImage[] = [];
  const imageSeen = new Set<string>();
  const imagesByHouse = new Map<string, ConclusionImage[]>();
  const imageSeenByHouse = new Map<string, Set<string>>();
  const locationsByHouse = new Map<string, ConclusionPoint>();
  const propertyRows = new Map<string, ConclusionProperty>();
  const propertyOrder: string[] = [];
  const examinedHouseIds = new Set<string>();

  const addPoint = (point: ConclusionPoint): void => {
    if (!point.name || points.length >= MAX_CONCLUSION_POINTS) return;
    const key = pointKey(point);
    if (pointSeen.has(key)) return;
    pointSeen.add(key);
    points.push(point);
  };

  const addPropertyImage = (raw: unknown, houseId?: string): void => {
    addUniqueImage(images, imageSeen, raw, houseId);
    if (!houseId) return;
    const list = imagesByHouse.get(houseId) ?? [];
    const seen = imageSeenByHouse.get(houseId) ?? new Set<string>();
    addUniqueImage(list, seen, raw, houseId);
    imagesByHouse.set(houseId, list);
    imageSeenByHouse.set(houseId, seen);
  };

  for (const part of parts) {
    if (part.p !== "tool" || part.result?.isError) continue;
    let payload: Record<string, unknown> | null = null;
    try {
      payload = asRecord(JSON.parse(part.result?.content || ""));
    } catch {
      continue;
    }
    if (!payload) continue;
    const action = text(payload.action);
    const raw = rawText(payload.data);
    const houseId = text(payload.houseId) || inferHouseId(raw) || undefined;

    if (action === "search") {
      const listings = parseListingObjects(payload.listings);
      const parsed = listings.length ? listings : parseSearchRaw(payload.data);
      for (const item of parsed) {
        mergeProperty(propertyRows, propertyOrder, item.houseId, {
          ...item,
          title: text(item.title) || propertyTitle(text(item.community), text(item.layout), text(item.area)),
        });
      }
      continue;
    }

    if (action === "detail") {
      const location = asRecord(payload.location);
      const point = location ? locationFromPayload(location, houseId) : locationFromRaw(payload.data, houseId);
      if (point) {
        locationsByHouse.set(houseId || point.name, point);
        addPoint(point);
        if (point.name) {
          const embed = safeMapEmbed(point.embedUrl || location?.embedUrl);
          if (embed) {
            detailMap = embed;
            mapTitle = "房源所在小区";
          }
        }
      }
      if (houseId) {
        examinedHouseIds.add(houseId);
        const vrUrl = safeVrUrl(payload.vr) || vrUrlFrom(payload);
        mergeProperty(propertyRows, propertyOrder, houseId, {
          ...factsFromDetail(payload.data),
          ...(vrUrl ? { vrUrl } : {}),
          ...(point ? { location: point, address: point.address } : {}),
        });
      }
      const detailImages = Array.isArray(payload.images) ? payload.images : rawImages(raw);
      for (const image of detailImages) addPropertyImage(image, houseId);
      continue;
    }

    if (action === "material") {
      if (houseId) examinedHouseIds.add(houseId);
      const materialImages = Array.isArray(payload.images) ? payload.images : rawImages(raw);
      for (const image of materialImages) addPropertyImage(image, houseId);
      const vrUrl = safeVrUrl(payload.vr) || vrUrlFrom(payload);
      if (houseId && vrUrl) mergeProperty(propertyRows, propertyOrder, houseId, { vrUrl });
      continue;
    }

    if (action === "map") {
      const embed = safeMapEmbed(payload.embedUrl);
      if (embed) comparisonMap = embed;
      const rawPoints = Array.isArray(payload.points) ? payload.points : [];
      for (const raw of rawPoints) {
        const point = asRecord(raw);
        if (!point) continue;
        const normalized = locationFromPayload(point);
        if (normalized) addPoint(normalized);
      }
    }
  }

  const rentValue = (property: ConclusionProperty): number => {
    const match = (property.rent || "").replace(/,/g, "").match(/(\d+(?:\.\d+)?)/);
    return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
  };
  const candidates: ConclusionProperty[] = [];
  for (const id of propertyOrder) {
    const row = propertyRows.get(id);
    if (!row || (!row.title && !row.rent && !row.area && !row.layout && !row.vrUrl)) continue;
    row.images = (imagesByHouse.get(id) ?? []).slice(0, 3);
    row.location = row.location || locationsByHouse.get(id);
    if (!row.title) row.title = propertyTitle(row.community || "", row.layout || "", row.area || "");
    candidates.push(row);
  }

  const answerSegments = normalizedAnswerSegments(answerText);
  const mentioned = candidates
    .map((property, index) => ({ property, index, score: propertyMentionScore(property, answerSegments) }))
    .filter((item) => item.score >= 2)
    .sort((left, right) => right.score - left.score || rentValue(left.property) - rentValue(right.property) || left.index - right.index);
  const fallback = candidates
    .map((property, index) => ({ property, index }))
    .sort((left, right) =>
      Number(examinedHouseIds.has(right.property.houseId)) - Number(examinedHouseIds.has(left.property.houseId))
      || rentValue(left.property) - rentValue(right.property)
      || left.index - right.index
    );
  const properties = (mentioned.length ? mentioned : fallback)
    .slice(0, MAX_CONCLUSION_PROPERTIES)
    .map((item) => item.property)
    .sort((left, right) => rentValue(left) - rentValue(right));

  return {
    mapEmbedUrl: detailMap || comparisonMap,
    mapTitle: mapTitle || (comparisonMap ? "候选房源分布" : ""),
    points,
    images,
    properties,
  };
}

/** 收集本轮工具结果中真实出现的 houseId，用于展示层脱敏。 */
export function collectEstateHouseIds(parts: AssistantPart[]): string[] {
  const ids = new Set<string>();
  for (const part of parts) {
    if (part.p !== "tool") continue;
    let payload: Record<string, unknown> | null = null;
    try { payload = asRecord(JSON.parse(part.result?.content || "")); } catch { continue; }
    if (!payload) continue;
    const raw = rawText(payload.data);
    const direct = text(payload.houseId) || inferHouseId(raw);
    if (/^\d{6,}$/.test(direct)) ids.add(direct);
    for (const row of [...parseListingObjects(payload.listings), ...parseSearchRaw(payload.data)]) {
      if (/^\d{6,}$/.test(row.houseId)) ids.add(row.houseId);
    }
    for (const match of raw.matchAll(/"房源ID"\s*:\s*"(\d{6,})"/g)) ids.add(match[1] || "");
  }
  ids.delete("");
  return [...ids].sort((a, b) => b.length - a.length);
}

/** 去除最终回答中的内部 houseId；表内定位仍保留匹配关系，但不向用户展示编号。 */
export function stripEstateHouseIds(value: string, ids: string[]): string {
  let out = value;
  for (const id of ids) {
    if (!id) continue;
    out = out.replace(new RegExp(`(?:ID\\s*[:：]?\\s*)?${escapeRegExp(id)}`, "gi"), "");
  }
  return out
    .split("\n")
    .map((line) => line.replace(/[ \t]{2,}/g, " ").replace(/\s+([，。；：、])/g, "$1").trimEnd())
    .join("\n");
}
