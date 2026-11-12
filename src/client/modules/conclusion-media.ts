/**
 * ============================================================
 * modules/conclusion-media.ts — 从同一轮工具结果提取结论附件
 * ============================================================
 * 房产工具结果属于交付数据，但“在哪展示”由前端决定。这里只做纯数据归一：
 * 从 house_lookup(detail/material) 与 house_map 中收集地图、点位和图片，
 * 由 render/conclusion-media.ts 挂到最终回答下方；不依赖 DOM，便于单测。
 */
import type { AssistantPart } from "./types.js";

const MAX_CONCLUSION_IMAGES = 6;
const MAX_CONCLUSION_POINTS = 8;

export interface ConclusionPoint {
  name: string;
  address?: string;
  lat?: number;
  lng?: number;
  precision?: string;
  houseId?: string;
  links?: Record<string, string>;
}

export interface ConclusionImage {
  src: string;
  alt: string;
  houseId?: string;
}

export interface EstateConclusionMedia {
  mapEmbedUrl: string;
  mapTitle: string;
  points: ConclusionPoint[];
  images: ConclusionImage[];
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

function pointKey(point: ConclusionPoint): string {
  // houseId 只用于图片说明；同一小区在 detail / map 中出现时按名称与坐标去重。
  return [point.name, point.address || "", point.lat ?? "", point.lng ?? ""].join("|");
}

function imageKey(image: ConclusionImage): string {
  return image.src;
}

/** 解析并去重；详情地图优先，其次 house_map 的多点分布图。 */
export function collectEstateConclusionMedia(parts: AssistantPart[]): EstateConclusionMedia {
  let detailMap = "";
  let comparisonMap = "";
  let mapTitle = "";
  const points: ConclusionPoint[] = [];
  const images: ConclusionImage[] = [];
  const pointSeen = new Set<string>();
  const imageSeen = new Set<string>();

  const addPoint = (point: ConclusionPoint): void => {
    if (!point.name || points.length >= MAX_CONCLUSION_POINTS) return;
    const key = pointKey(point);
    if (pointSeen.has(key)) return;
    pointSeen.add(key);
    points.push(point);
  };

  const addImage = (src: string, houseId?: string): void => {
    if (!src || images.length >= MAX_CONCLUSION_IMAGES) return;
    const image: ConclusionImage = {
      src,
      alt: `房源${houseId ? ` ${houseId}` : ""}户型图 ${images.length + 1}`,
      ...(houseId ? { houseId } : {}),
    };
    if (imageSeen.has(imageKey(image))) return;
    imageSeen.add(imageKey(image));
    images.push(image);
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
    const houseId = text(payload.houseId) || undefined;

    if (action === "material") {
      const rawImages = Array.isArray(payload.images) ? payload.images : [];
      for (const raw of rawImages) addImage(safeImage(raw), houseId);
      continue;
    }

    if (action === "detail") {
      const location = asRecord(payload.location);
      if (location) {
        const embed = safeMapEmbed(location.embedUrl);
        if (embed) {
          detailMap = embed;
          mapTitle = "房源所在小区";
        }
        addPoint({
          name: text(location.label) || `房源 ${houseId || ""}`.trim(),
          ...(text(location.address) ? { address: text(location.address) } : {}),
          ...(number(location.lat) !== undefined ? { lat: number(location.lat) } : {}),
          ...(number(location.lng) !== undefined ? { lng: number(location.lng) } : {}),
          ...(text(location.precision) ? { precision: text(location.precision) } : {}),
          ...(houseId ? { houseId } : {}),
          ...(stringLinks(location.links) ? { links: stringLinks(location.links) } : {}),
        });
      }
      const rawImages = Array.isArray(payload.images) ? payload.images : [];
      for (const raw of rawImages) addImage(safeImage(raw), houseId);
      continue;
    }

    if (action === "map") {
      const embed = safeMapEmbed(payload.embedUrl);
      if (embed) comparisonMap = embed;
      const rawPoints = Array.isArray(payload.points) ? payload.points : [];
      for (const raw of rawPoints) {
        const point = asRecord(raw);
        if (!point) continue;
        addPoint({
          name: text(point.name) || "未知点位",
          ...(text(point.address) ? { address: text(point.address) } : {}),
          ...(number(point.lat) !== undefined ? { lat: number(point.lat) } : {}),
          ...(number(point.lng) !== undefined ? { lng: number(point.lng) } : {}),
          ...(text(point.source) ? { precision: text(point.source) } : {}),
          ...(stringLinks(point.links) ? { links: stringLinks(point.links) } : {}),
        });
      }
    }
  }

  return {
    mapEmbedUrl: detailMap || comparisonMap,
    mapTitle: mapTitle || (comparisonMap ? "候选房源分布" : ""),
    points,
    images,
  };
}
