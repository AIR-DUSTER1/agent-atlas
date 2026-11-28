/**
 * ============================================================
 * modules/conclusion-media.ts — 房产结论表格的数据归一
 * ============================================================
 * 同一轮会同时出现 search / detail / material / map。这里按 houseId 把
 * 房源事实、价格、户型图、VR 与位置合并成一张表；houseId 仅用于内部匹配，绝不进入
 * 用户可见标题。模型文字里的原始 ID 也由本模块提供确定性脱敏。
 */
import type { AssistantPart } from "./types.js";
import { beikeText, unescapeBeikeText } from "../../shared/beike-payload.js";

const MAX_CONCLUSION_IMAGES = 6;
const MAX_CONCLUSION_PROPERTIES = 12;
const MAX_CONCLUSION_POINTS = 8;
const VR_URL_RE = /(?:https?:)?\/\/[^\s"'<>\\]+/gi;
const VR_KEY_RE = /(?:^|[_-])(?:vr|pano|panorama)(?:$|[_-])|(?:vr|pano|panorama)(?:url|link)|(?:VR|全景)(?:链接|看房|地址)?/i;
const VR_HINT_RE = /(?:\bvr\b|全景|panorama|virtual\s*tour)/i;
/* 「有 VR」的正向判定与服务端 estate-result.ts 保持同一口径：
   裸「全景」不算（「小区实景全景拍摄」「楼栋全景展示」与 VR 入口无关），
   中文全景必须与看房/链接/漫游等 VR 语境共现。两份实现必须同步改，否则会
   出现服务端判定有、前端判定无（或反之）的分裂。 */
const VR_POSITIVE_RE = /(?:有|带|支持|含)\s*(?:VR|虚拟看房|全景看房)|VR\s*(?:看房|全景|链接)|虚拟看房|全景\s*(?:看房|链接|漫游|房源)/i;
const VR_IMAGE_RE = /\.(?:jpe?g|png|webp|gif|avif)(?:[!?]|$)/i;
const VR_HOST_SUFFIXES = ["ke.com", "lianjia.com", "beike.com", "ljcdn.com", "realsee.com", "realsee-cdn.cn"] as const;
const LEGACY_VR_PLACEHOLDER_RE = /^#\/vr\?houseid=/i;
const ESTATE_EXPORT_PATH_RE = /^\/api\/estate\/exports\/[0-9a-f-]{36}$/i;

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
  hasVr?: boolean;
  community?: string;
  layout?: string;
  area?: string;
  /** 统一价格文案：租房为「xxxx 元/月」，买房为「xxxx 万」。 */
  price?: string;
  floor?: string;
  orientation?: string;
  decoration?: string;
  address?: string;
  images: ConclusionImage[];
  /**
   * 本轮是否真的为这套房源查过户型图（house_lookup action=material）。
   * 结论表据此区分「查了但贝壳没有图 = 该房源未上传户型图」与
   * 「根本没查 = 未查询」，避免把没查过的房源写成「未上传」冤枉房源。
   */
  floorPlanQueried?: boolean;
  location?: ConclusionPoint;
  vrUrl?: string;
  /** 城市中文名（来自 detail payload）；用于拼详情页链接，未收录城市时不生成。 */
  city?: string;
  /** 租 / 买：决定详情页是 /zufang/ 还是 /ershoufang/。缺省按租房处理。 */
  listingKind?: "rent" | "buy";
  /** 贝壳租房详情页编码；租房详情链接必须用它，禁止用 houseId 拼数字路径。 */
  rentCode?: string;
  /** 工具已归一好的服务端详情链接；优先取它，取不到再由展示层用 rentCode 拼。 */
  detailUrl?: string;
}

export interface ConclusionExport {
  fileName: string;
  downloadUrl: string;
  count: number;
}

/**
 * 户型图空态文案：必须区分「查了但贝壳没给图」与「根本没查」。
 * 把没查过的房源写成「未上传」是冤枉房源；反过来，查过还写「未获取」
 * 会让人以为是我们漏了数据而不是房源本身没有。
 */
export function floorPlanCellLabel(property: Pick<ConclusionProperty, "images" | "floorPlanQueried">): string {
  if (property.images.length > 0) return "";
  return property.floorPlanQueried ? "该房源未上传户型图" : "未查询户型图";
}

export interface EstateConclusionMedia {
  mapEmbedUrl: string;
  mapTitle: string;
  points: ConclusionPoint[];
  images: ConclusionImage[];
  properties: ConclusionProperty[];
  exports: ConclusionExport[];
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
    if ((host === "vr.ke.com" || host === "www.realsee.com") && url.pathname === "/" && LEGACY_VR_PLACEHOLDER_RE.test(url.hash)) return "";
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

function rentCodeForRaw(raw: string, houseId: string): string {
  const match = raw.match(/<metadata>([\s\S]*?)<\/metadata>/i);
  if (!match?.[1]) return "";
  const unescaped = match[1].replace(/\\"/g, '"').replace(/\\n/g, "\n");
  try {
    const meta = JSON.parse(unescaped) as Record<string, unknown>;
    const entityIds = Array.isArray(meta.entity_ids) ? meta.entity_ids.map((v) => text(v)) : [];
    const rentCodes = Array.isArray(meta.rent_codes) ? meta.rent_codes.map((v) => text(v)) : [];
    // houseId 由调用方显式传入，避免在只传每套 body 时猜不到
    const index = entityIds.indexOf(houseId);
    const code = index >= 0 ? rentCodes[index] : '';
    return /^[A-Z]{1,4}\d{10,}$/i.test(code) ? code.toUpperCase() : '';
  } catch {
    return "";
  }
}

/** 贝壳结果值 → 可跑字段正则的文本（信封只取 data 并反转义，见 shared/beike-payload）。 */
function rawText(value: unknown): string {
  return beikeText(value);
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

/** 只有编号、没有业务信息的标题不能直接进入结论表。 */
function listingTitleIsPlaceholder(value: string, houseId: string): boolean {
  if (["房源详情", "小区待补充", "位置待补", "详情", "待补充"].includes(value.trim())) return true;
  const stripped = value.replaceAll(houseId, "").replace(/房源\s*/g, "").replace(/\d{8,20}/g, "").trim();
  return !stripped;
}

/** 用户可见标题永不展示内部 houseId；占位标题优先回退到真实小区字段。 */
function publicPropertyTitle(property: ConclusionProperty): string {
  const stripped = property.title
    .replaceAll(property.houseId, "")
    .replace(/\b\d{8,20}\b/g, "")
    .replace(/房源\s*/g, "")
    .replace(/^\s*[·:：\-]+|[·:：\-]+\s*$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (stripped && !["详情", "待补充", "房源详情", "小区待补充", "位置待补"].includes(stripped)) return stripped;
  const generated = propertyTitle(property.community || "", property.layout || "", property.area || "");
  if (generated !== "房源详情") return generated;
  return meaningfulPropertyText(property.location?.name)
    || meaningfulPropertyText(property.location?.address)
    || "房源详情";
}

const PROPERTY_PLACEHOLDERS = new Set([
  "", "房源详情", "房源位置", "小区待补充", "位置待补", "详情", "待补充", "暂无", "未知", "未获取坐标",
]);

function meaningfulPropertyText(value: unknown): string {
  const normalized = text(value);
  return PROPERTY_PLACEHOLDERS.has(normalized) || /^(?:未获取|暂无|待补充)/.test(normalized) ? "" : normalized;
}

function titleHasPropertyIdentity(property: ConclusionProperty): boolean {
  if (!meaningfulPropertyText(property.title) || listingTitleIsPlaceholder(property.title, property.houseId)) return false;
  const core = property.title
    .replace(/[\d.,，·+\s]/g, "")
    .replace(/(?:室|厅|卫|厨|阳台|平米|㎡|元|月|租金|面积|整租|合租|住宅|房源)/g, "");
  if (/^(?:小区)?待补充$/.test(core)) return false;
  return /[\u3400-\u9fffA-Za-z]{2,}/.test(core);
}

function hasMeaningfulPropertyFacts(property: ConclusionProperty): boolean {
  const location = property.location;
  const hasCoordinate = number(location?.lat) !== undefined && number(location?.lng) !== undefined;
  const hasLocationIdentity = Boolean(
    hasCoordinate
    || meaningfulPropertyText(location?.address)
    || (meaningfulPropertyText(location?.name) && location?.name !== "房源位置"),
  );
  return Boolean(
    meaningfulPropertyText(property.community)
    || meaningfulPropertyText(property.address)
    || hasLocationIdentity
    || titleHasPropertyIdentity(property),
  );
}

/** 从面积/租金中提取数值，只用于和最终回答做轻量匹配。 */
function firstNumber(value: string): string {
  return value.replace(/[,，\s]/g, "").match(/\d+(?:\.\d+)?/)?.[0] || "";
}

/** 分句匹配，避免把回答中另一个房源的面积或租金错误套到当前房源。 */
function normalizedAnswerSegments(answerText: string): string[] {
  return answerText
    // 千分位逗号属于金额本身，先去掉；其它逗号、顿号是候选之间的天然边界，必须拆开。
    .replace(/(\d)[,，](?=\d{3}(?:\D|$))/g, "$1")
    .replace(/\s+/g, "")
    .split(/[。；;，,\n、]+/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

/** 小区名既可能来自结构化字段，也可能藏在「小区 · 户型 · 面积」标题里。 */
function propertyCommunity(property: ConclusionProperty): string {
  return (property.community || firstMatch(property.title, /^([^·]+)\s*·/)).replace(/[,，\s]/g, "");
}

/**
 * 最终回答是用户真正看到的结论。只有同一句中同时命中面积、户型和/或租金的
 * 房源才优先进入表格，防止搜索前几条挤掉模型最终推荐的房源。
 */
function propertyMentionScore(property: ConclusionProperty, segments: string[], knownCommunities: string[]): number {
  const titleArea = firstMatch(property.title, /([\d.]+\s*(?:㎡|平|m²))/i);
  const area = firstNumber(property.area || titleArea);
  if (!area) return 0;
  const price = firstNumber(property.price || "");
  const layout = property.layout || firstMatch(property.title, /(\d+室\d+厅)/);
  const community = propertyCommunity(property);
  const areaRe = new RegExp(`${escapeRegExp(area)}(?:㎡|平|m²)`, "i");
  // 结论常用「¥2,500」这种不带 /月的简写，也必须算命中；否则会漏掉正文里明确推荐的房源。
  const priceRe = price
    ? new RegExp(`(?:(?:¥|￥)${escapeRegExp(price)}(?=\\D|$)|${escapeRegExp(price)}(?:万|元|/月|每月))`, "i")
    : null;
  let best = 0;
  for (const segment of segments) {
    const segmentCommunities = knownCommunities.filter((name) => segment.includes(name));
    if (segmentCommunities.length && (!community || !segmentCommunities.some((name) => name.includes(community) || community.includes(name)))) continue;
    if (!areaRe.test(segment)) continue;
    let score = 1;
    if (priceRe?.test(segment)) score += 3;
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
    const price = field(body, ["租赁价格", "总价", "售价", "价格", "挂牌价", "月租", "租金"]);
    const traffic = field(body, ["区位交通"]);
    const community = firstMatch(traffic, /板块\s*([^，,。]+?)小区/)
      || firstMatch(traffic, /小区\s*([^，,。]+)/);
    const rentCode = rentCodeForRaw(raw, houseId);
    const vrUrl = vrUrlFrom(body);
    const hasVr = VR_POSITIVE_RE.test(body);
    rows.push({
      houseId,
      hasVr,
      ...(community ? { community } : {}),
      ...(layout ? { layout } : {}),
      ...(area ? { area } : {}),
      ...(price ? { price } : {}),
      ...(orientation ? { orientation } : {}),
      ...(traffic ? { address: traffic } : {}),
      ...(vrUrl ? { vrUrl } : {}),
      ...(rentCode ? { rentCode } : {}),
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
    const rawTitle = text(record?.title) || text(record?.name);
    const rawPrice = record?.price ?? record?.rent ?? record?.totalPrice ?? record?.monthlyRent;
    const priceObject = asRecord(rawPrice);
    const price = text(rawPrice)
      || text(priceObject?.unit)
      || text(priceObject?.value)
      || text(priceObject?.display);
    const layout = text(record?.layout);
    const area = text(record?.area);
    const floor = text(record?.floor);
    const orientation = text(record?.orientation);
    const decoration = text(record?.decoration);
    const address = text(record?.addressText) || text(record?.address);
    const community = text(record?.community) || text(record?.communityName) || firstMatch(rawTitle, /^([^·]+)\s*·/);
    const title = rawTitle && !listingTitleIsPlaceholder(rawTitle, houseId)
      ? rawTitle
      : propertyTitle(community, layout, area);
    const vrHint = record?.hasVr ?? record?.has_vr ?? (record?.vr === true ? true : undefined);
    const vrUrl = vrUrlFrom(record);
    const hasVr = vrHint === true || VR_POSITIVE_RE.test(rawText(vrHint)) || Boolean(vrUrl);
    rows.push({
      houseId,
      hasVr,
      ...(community ? { community } : {}),
      ...(title ? { title } : {}),
      ...(price ? { price } : {}),
      ...(layout ? { layout } : {}),
      ...(area ? { area } : {}),
      ...(floor ? { floor } : {}),
      ...(orientation ? { orientation } : {}),
      ...(decoration ? { decoration } : {}),
      ...(address ? { address } : {}),
      ...(vrUrl ? { vrUrl } : {}),
      ...(text(record?.rentCode) ? { rentCode: text(record?.rentCode) } : {}),
      ...(text(record?.detailUrl) ? { detailUrl: text(record?.detailUrl) } : {}),
    });
  }
  return rows;
}

function factsFromDetail(data: unknown): Partial<ConclusionProperty> {
  const raw = rawText(data);
  const community = field(raw, ["小区名", "小区名称"]);
  const layout = field(raw, ["房型"]);
  const area = field(raw, ["出租面积"]);
  const price = field(raw, ["租赁价格", "总价", "售价", "价格", "挂牌价", "月租", "租金"]);
  const floor = field(raw, ["房源所属楼层"]);
  const orientation = field(raw, ["出租朝向"]);
  const decoration = field(raw, ["装修"]);
  const vrUrl = vrUrlFrom(data);
  const hasVr = /"是否有VR"\s*:\s*"有"/.test(raw) || Boolean(vrUrl);
  return {
    ...(community ? { community } : {}),
    ...(hasVr ? { hasVr } : {}),
    ...(layout ? { layout } : {}),
    ...(area ? { area } : {}),
    ...(price ? { price } : {}),
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
  for (const key of ["title", "community", "layout", "area", "price", "floor", "orientation", "decoration", "address", "vrUrl", "city", "rentCode", "detailUrl"] as const) {
    const value = text(patch[key]);
    if (value) row[key] = value;
  }
  if (typeof patch.hasVr === "boolean") row.hasVr = patch.hasVr;
  // 租买方向决定详情页路径（/zufang/ 还是 /ershoufang/），不进白名单会被丢掉，
  // 导致「在贝壳查看该房源」永远拼不出来。
  if (patch.listingKind) row.listingKind = patch.listingKind;
  if (patch.location) row.location = patch.location;
  // 一旦查过 material 就永久记为已查询：后续同房源的空结果不能把它降级成「未查询」。
  if (patch.floorPlanQueried) row.floorPlanQueried = true;
}

function conclusionExportFrom(payload: Record<string, unknown>): ConclusionExport | null {
  const raw = asRecord(payload.excel) ?? (text(payload.action) === "export" ? payload : null);
  if (!raw) return null;
  const downloadUrl = text(raw.downloadUrl);
  if (!ESTATE_EXPORT_PATH_RE.test(downloadUrl)) return null;
  const fileName = text(raw.fileName).toLowerCase().endsWith(".xlsx")
    ? text(raw.fileName)
    : "房源对比清单.xlsx";
  return {
    fileName,
    downloadUrl,
    count: Math.max(0, Math.floor(number(raw.count) ?? 0)),
  };
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
  const exports: ConclusionExport[] = [];
  const exportSeen = new Set<string>();
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
    const exportArtifact = conclusionExportFrom(payload);
    if (exportArtifact && !exportSeen.has(exportArtifact.downloadUrl)) {
      exportSeen.add(exportArtifact.downloadUrl);
      exports.push(exportArtifact);
    }

    if (action === "search") {
      const listings = parseListingObjects(payload.listings);
      const parsed = listings.length ? listings : parseSearchRaw(payload.data);
      // search payload 自带 city 与 mode：结论表里多数房源只有 search 记录，
      // 不在这里带上就会因为缺城市而拼不出详情页链接。
      const searchCity = text(payload.city);
      const searchMode = text(payload.mode);
      for (const item of parsed) {
        mergeProperty(propertyRows, propertyOrder, item.houseId, {
          ...item,
          title: text(item.title) || propertyTitle(text(item.community), text(item.layout), text(item.area)),
          ...(searchCity ? { city: searchCity } : {}),
          ...(searchMode ? { listingKind: searchMode === "buy" ? "buy" as const : "rent" as const } : {}),
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
        const city = text(payload.city);
        const mode = text(payload.mode);
        mergeProperty(propertyRows, propertyOrder, houseId, {
          ...factsFromDetail(payload.data),
          ...(vrUrl ? { vrUrl } : {}),
          ...(point ? { location: point, address: point.address } : {}),
          // city + 租买方向用于「在贝壳查看该房源」链接；两者缺一就不拼链接。
          ...(city ? { city } : {}),
          ...(mode ? { listingKind: mode === "buy" ? "buy" as const : "rent" as const } : {}),
          ...(text(payload.rentCode) ? { rentCode: text(payload.rentCode) } : {}),
          ...(text(payload.detailUrl) ? { detailUrl: text(payload.detailUrl) } : {}),
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
      // 记「查过户型图」：即使这次一张图都没返回，也要让结论表能说清是
      // 「贝壳没给图（该房源未上传户型图）」而不是「我们没查」。
      if (houseId) {
        mergeProperty(propertyRows, propertyOrder, houseId, {
          floorPlanQueried: true,
          ...(vrUrl ? { vrUrl } : {}),
        });
      }
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

  const priceValue = (property: ConclusionProperty): number => {
    const match = (property.price || "").replace(/,/g, "").match(/(\d+(?:\.\d+)?)/);
    return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
  };
  const candidates: ConclusionProperty[] = [];
  for (const id of propertyOrder) {
    const row = propertyRows.get(id);
    if (!row) continue;
    row.images = (imagesByHouse.get(id) ?? []).slice(0, 3);
    row.location = row.location || locationsByHouse.get(id);
    // 只有内部 ID、占位标题或「有 VR」标记的稀疏结果不能进入推荐表。
    if (!hasMeaningfulPropertyFacts(row)) continue;
    row.title = publicPropertyTitle(row);
    candidates.push(row);
  }

  const answerSegments = normalizedAnswerSegments(answerText);
  const knownCommunities = [...new Set(candidates.map(propertyCommunity).filter(Boolean))];
  const mentioned = candidates
    .map((property, index) => ({ property, index, score: propertyMentionScore(property, answerSegments, knownCommunities) }))
    .filter((item) => item.score >= 2)
    .sort((left, right) => right.score - left.score || priceValue(left.property) - priceValue(right.property) || left.index - right.index);
  const fallback = candidates
    .map((property, index) => ({ property, index }))
    .sort((left, right) =>
      Number(examinedHouseIds.has(right.property.houseId)) - Number(examinedHouseIds.has(left.property.houseId))
      || priceValue(left.property) - priceValue(right.property)
      || left.index - right.index
    );
  const properties = (mentioned.length ? mentioned : fallback)
    .slice(0, MAX_CONCLUSION_PROPERTIES)
    .map((item) => item.property)
    .sort((left, right) => priceValue(left) - priceValue(right));

  return {
    mapEmbedUrl: detailMap || comparisonMap,
    mapTitle: mapTitle || (comparisonMap ? "候选房源分布" : ""),
    points,
    images,
    properties,
    exports,
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
