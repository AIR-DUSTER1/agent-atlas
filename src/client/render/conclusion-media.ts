/**
 * ============================================================
 * render/conclusion-media.ts — 房产最终结论中的结构化对比表
 * ============================================================
 * 职责：把同一轮 house_* 结果按 houseId 合并成“房源 / 户型图 / VR / 地理位置”
 * 表格，挂到最终回答下方。内部 ID 只参与匹配，不展示给用户；流式或重写
 * 阶段自动撤下旧表，避免结论与过程不一致。
 */
import { blockBodies, partEls, state } from "../core/state.js";
import {
  collectEstateConclusionMedia,
  collectEstateHouseIds,
  stripEstateHouseIds,
  type ConclusionExport,
  type ConclusionImage,
  type ConclusionPoint,
  type ConclusionProperty,
  type EstateConclusionMedia,
} from "../modules/conclusion-media.js";
import { safeHref, safeImageSrc } from "../modules/format.js";
import { buildListingUrl } from "../modules/estate-listing-url.js";
import { mapLinkKey, mapStaticImageUrl, mapTileUrl, projectMapPoint, resolveMapConfig } from "../modules/map-provider.js";
import type { MapRuntimeConfig } from "../modules/types-api.js";
import { h } from "../ui/dom.js";
import { icon } from "../ui/icon.js";
import { openMediaPreview } from "../ui/media-preview.js";
import type { AssistantBlock } from "../modules/types.js";

const MAP_LINK_LABELS: Record<string, string> = {
  amap: "高德地图",
  qq: "腾讯地图",
  baidu: "百度地图",
  osm: "OSM",
};
const conclusionEls = new WeakMap<AssistantBlock, HTMLElement>();

/** 结论表跟随最后一段已完成正文；反思思考可能排在正文之后，不能因此撤表。 */
function latestCompletedTextPart(block: AssistantBlock) {
  for (let index = block.parts.length - 1; index >= 0; index -= 1) {
    const part = block.parts[index];
    if (part?.p === "text" && !part.streaming && part.text.trim()) return part;
  }
  return null;
}

function precisionLabel(value: string | undefined): string {
  if (value === "building") return "楼栋精确位置";
  if (value === "community") return "小区位置";
  if (value === "beike") return "贝壳坐标";
  if (value === "nominatim") return "地址地理编码";
  if (value === "mock") return "演示坐标";
  return value || "";
}

function coordinateText(point: ConclusionPoint): string {
  return Number.isFinite(point.lat) && Number.isFinite(point.lng)
    ? `${point.lat?.toFixed(6)}, ${point.lng?.toFixed(6)}`
    : "";
}

function renderLinks(links: Record<string, string> | undefined, preferredKey?: string): HTMLElement | null {
  if (!links) return null;
  const row = h("div", { class: "conclusion-links" });
  const entries = Object.entries(links).sort(([left], [right]) => {
    if (left === preferredKey) return -1;
    if (right === preferredKey) return 1;
    return 0;
  });
  for (const [label, raw] of entries) {
    const href = safeHref(raw);
    if (!href) continue;
    row.appendChild(h("a", {
      class: "conclusion-link",
      href,
      target: "_blank",
      rel: "noopener noreferrer",
    }, MAP_LINK_LABELS[label] || label));
  }
  return row.childElementCount ? row : null;
}

function renderExports(exports: ConclusionExport[]): HTMLElement | null {
  if (!exports.length) return null;
  const bar = h("div", { class: "conclusion-export-bar" });
  for (const item of exports) {
    const href = safeHref(item.downloadUrl);
    if (!href) continue;
    bar.appendChild(h("a", {
      class: "conclusion-export-link",
      href,
      download: item.fileName,
      "aria-label": `下载 ${item.fileName}，共 ${item.count} 套房源`,
    },
      icon("Download", { size: 15 }),
      h("span", { class: "conclusion-export-copy" },
        h("strong", null, "下载 Excel 对比清单"),
        h("small", null, `${item.count} 套完整候选 · ${item.fileName}`),
      ),
    ));
  }
  return bar.childElementCount ? bar : null;
}

function coordinatesFromEmbed(raw: string): { lat: number; lng: number } | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.hostname !== "www.openstreetmap.org") return null;
    const marker = url.searchParams.get("marker")?.split(",");
    if (!marker || marker.length !== 2) return null;
    const lat = Number(marker[0]);
    const lng = Number(marker[1]);
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  } catch {
    return null;
  }
}

/**
 * 高德优先加载服务端代理的官方静态图；其它提供方直接创建原生图片瓦片层。
 * 坐标/投影/y 轴差异全部在 map-provider 中处理，这里绝不创建 iframe，
 * 静态图失败时才补瓦片，底图失败时仍显示地址、坐标和链接。
 */
function renderMapFrame(lat: number | undefined, lng: number | undefined, title: string, compact = false, rawConfig?: MapRuntimeConfig): HTMLElement | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat as number) > 90 || Math.abs(lng as number) > 180) return null;
  const latitude = lat as number;
  const longitude = lng as number;
  const config = resolveMapConfig(rawConfig ?? state.config?.map);
  const point = projectMapPoint(latitude, longitude, config);
  const tileSize = config.tileSize;
  const centerX = Math.floor(point.worldX / tileSize);
  const centerY = Math.floor(point.worldY / tileSize);
  const map = h("div", {
    class: compact ? "conclusion-property-map" : "conclusion-map",
    role: "img",
    "aria-label": `${title} 地图，坐标 ${latitude.toFixed(6)}, ${longitude.toFixed(6)}，底图来源 ${config.label}`,
    title: `${title} · ${latitude.toFixed(6)}, ${longitude.toFixed(6)} · ${config.label}`,
  });
  map.dataset.mapLat = latitude.toFixed(6);
  map.dataset.mapLng = longitude.toFixed(6);
  map.dataset.mapProvider = config.provider;
  map.dataset.mapProjection = config.projection;
  map.dataset.mapCoordinateSystem = config.coordinateSystem;

  const layer = h("div", { class: "conclusion-map-tiles", "aria-hidden": "true" });
  const populateTiles = (): void => {
    if (layer.childElementCount) return;
    for (let tileY = centerY - 1; tileY <= centerY + 1; tileY += 1) {
      for (let tileX = centerX - 1; tileX <= centerX + 1; tileX += 1) {
        const img = document.createElement("img");
        img.className = "conclusion-map-tile";
        img.alt = "";
        img.loading = "lazy";
        img.decoding = "async";
        img.referrerPolicy = "no-referrer";
        img.draggable = false;
        img.style.left = `${tileX * tileSize - point.worldX}px`;
        img.style.top = `${tileY * tileSize - point.worldY}px`;
        img.src = mapTileUrl(tileX, tileY, config);
        layer.appendChild(img);
      }
    }
  };

  const marker = h("span", { class: "conclusion-map-marker", "aria-hidden": "true" });
  const source = h("span", { class: "conclusion-map-attribution" }, `定位 · ${config.label}`);
  let officialMap: HTMLImageElement | null = null;
  const staticUrl = mapStaticImageUrl(point.lat, point.lng, config, compact);
  if (staticUrl) {
    officialMap = document.createElement("img");
    officialMap.className = "conclusion-map-static";
    officialMap.alt = "";
    officialMap.decoding = "async";
    officialMap.referrerPolicy = "same-origin";
    officialMap.draggable = false;
    map.dataset.mapStatus = "loading";
    map.dataset.mapRenderer = `${config.provider}-static`;
    officialMap.addEventListener("load", () => {
      officialMap?.classList.add("is-ready");
      layer.hidden = true;
      marker.hidden = true;
      source.textContent = `定位 · ${config.label} · 官方底图`;
      map.dataset.mapStatus = "ready";
    }, { once: true });
    officialMap.addEventListener("error", () => {
      officialMap?.remove();
      populateTiles();
      map.dataset.mapStatus = "fallback";
      map.dataset.mapRenderer = "tiles";
    }, { once: true });
    officialMap.src = staticUrl;
  } else {
    populateTiles();
  }
  map.append(layer, ...(officialMap ? [officialMap] : []), marker, source);
  return map;
}

function renderImageFigure(image: ConclusionImage, compact = false): HTMLElement | null {
  const src = safeImageSrc(image.src);
  if (!src) return null;
  const img = document.createElement("img");
  img.src = src;
  img.alt = image.alt;
  img.loading = compact ? "lazy" : "eager";
  img.decoding = "async";
  img.draggable = false;
  const trigger = h("button", {
    type: "button",
    class: "conclusion-image-open",
    title: "点击放大预览",
    "aria-label": `放大预览：${image.alt}`,
  }, img);
  trigger.addEventListener("click", () => {
    openMediaPreview({
      title: "户型图预览",
      description: image.alt,
      kind: "image",
      createContent: () => {
        const preview = document.createElement("img");
        preview.src = src;
        preview.alt = image.alt;
        preview.decoding = "async";
        preview.draggable = false;
        return preview;
      },
    });
  });
  return h("figure", { class: compact ? "conclusion-image-card compact" : "conclusion-image-card" }, trigger);
}

function renderMapPreviewTrigger(map: HTMLElement, lat: number, lng: number, title: string, description: string, config?: MapRuntimeConfig): HTMLElement {
  const trigger = h("div", {
    class: "conclusion-map-preview-trigger",
    role: "button",
    tabindex: "0",
    title: "点击放大预览地图",
    "aria-label": `放大预览：${title}`,
  }, map);
  const openPreview = (): void => {
    openMediaPreview({
      title: "地理位置预览",
      description,
      kind: "map",
      createContent: () => renderMapFrame(lat, lng, title, false, config)
        ?? h("div", { class: "conclusion-empty" }, "地图暂时无法加载"),
    });
  };
  trigger.addEventListener("click", openPreview);
  trigger.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    openPreview();
  });
  return trigger;
}

function renderImageCell(property: ConclusionProperty): HTMLElement {
  const cell = document.createElement("td");
  cell.className = "conclusion-table-image";
  const first = property.images[0];
  const figure = first ? renderImageFigure(first, true) : null;
  if (figure) {
    cell.appendChild(figure);
    if (property.images.length > 1) {
      cell.appendChild(h("span", { class: "conclusion-image-more" }, `另有 ${property.images.length - 1} 张`));
    }
  } else {
    cell.appendChild(h("span", { class: "conclusion-empty" }, "未获取户型图"));
  }
  return cell;
}

function renderLocationCell(property: ConclusionProperty, media: EstateConclusionMedia, rendered: Set<string>): HTMLElement {
  const cell = document.createElement("td");
  cell.className = "conclusion-table-location";
  const location = property.location;
  if (!location) {
    cell.appendChild(h("strong", { class: "conclusion-location-name" }, property.community || "位置待补"));
    cell.appendChild(h("span", { class: "conclusion-empty" }, property.address || "未获取坐标"));
    return cell;
  }

  const mapConfig = resolveMapConfig(state.config?.map);
  const key = [location.name, location.lat ?? "", location.lng ?? ""].join("|");
  if (Number.isFinite(location.lat) && Number.isFinite(location.lng) && !rendered.has(key)) {
    const title = `${property.title || location.name} 位置`;
    const map = renderMapFrame(location.lat, location.lng, title, true, mapConfig);
    if (map) {
      const previewDescription = [location.name, precisionLabel(location.precision), coordinateText(location)]
        .filter(Boolean).join(" · ");
      cell.appendChild(renderMapPreviewTrigger(map, location.lat as number, location.lng as number, title, previewDescription, mapConfig));
      rendered.add(key);
    }
  } else if (rendered.has(key)) {
    cell.appendChild(h("span", { class: "conclusion-same-location" }, "同一小区位置，见上方地图"));
  }

  cell.appendChild(h("strong", { class: "conclusion-location-name" }, location.name || property.community || "房源位置"));
  const meta = [precisionLabel(location.precision), location.address || property.address, coordinateText(location)]
    .filter(Boolean).join(" · ");
  if (meta) cell.appendChild(h("span", { class: "conclusion-location-meta" }, meta));
  const links = renderLinks(location.links, mapLinkKey(mapConfig.provider));
  if (links) cell.appendChild(links);
  return cell;
}

function renderPropertyTable(media: EstateConclusionMedia): { table: HTMLElement; mappedLocations: number } {
  const table = document.createElement("table");
  table.className = "conclusion-table";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const label of ["房源", "户型图", "地理位置"]) {
    headRow.appendChild(h("th", null, label));
  }
  thead.appendChild(headRow);
  const tbody = document.createElement("tbody");
  const renderedLocations = new Set<string>();
  for (const property of media.properties) {
    const row = document.createElement("tr");
    const facts = document.createElement("td");
    facts.className = "conclusion-table-property";
    facts.appendChild(h("strong", { class: "conclusion-property-title" }, property.title || property.community || "房源详情"));
    const tags = h("div", { class: "conclusion-property-tags" });
    for (const value of [property.rent, property.layout, property.area, property.floor, property.orientation, property.decoration]) {
      if (value) tags.appendChild(h("span", null, value));
    }
    if (tags.childElementCount) facts.appendChild(tags);
    if (property.address) facts.appendChild(h("span", { class: "conclusion-property-address" }, property.address));
    const vrHref = safeHref(property.vrUrl);
    if (vrHref) {
      facts.appendChild(h("a", {
        class: "conclusion-vr-link",
        href: vrHref,
        target: "_blank",
        rel: "noopener noreferrer",
        "aria-label": `${property.title || property.community || "房源"} VR 看房`,
      }, icon("Eye", { size: 14 }), h("span", null, "VR 看房")));
    }
    // 统一贝壳详情入口：优先用服务端已归一好的 detailUrl；取不到再用 rentCode
    // 拼桌面版租房详情路径。没有合法链接时不展示占位文案；城市未收录 /
    // 缺 rentCode 时返回 null。
    const listingHref = safeHref(property.detailUrl)
      ?? buildListingUrl(property.city, property.houseId, property.listingKind ?? "rent", property.rentCode);
    if (listingHref) {
      facts.appendChild(h("a", {
        class: "conclusion-listing-link",
        href: listingHref,
        target: "_blank",
        rel: "noopener noreferrer",
        title: "在贝壳查看该房源详情（登录后可直接回跳房源页）",
        "aria-label": `${property.title || property.community || "房源"} 在贝壳查看房源详情`,
      }, icon("ExternalLink", { size: 14 }), h("span", null, "在贝壳查看该房源")));
    }
    row.appendChild(facts);
    row.appendChild(renderImageCell(property));
    row.appendChild(renderLocationCell(property, media, renderedLocations));
    tbody.appendChild(row);
  }
  table.append(thead, tbody);
  return { table, mappedLocations: renderedLocations.size };
}

function renderMap(media: EstateConclusionMedia): HTMLElement | null {
  const point = media.points.find((item) => Number.isFinite(item.lat) && Number.isFinite(item.lng));
  const fallback = point ?? coordinatesFromEmbed(media.mapEmbedUrl);
  if (!fallback) return null;
  const lat = fallback.lat;
  const lng = fallback.lng;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const title = media.mapTitle || point?.name || "房源位置地图";
  const map = renderMapFrame(lat, lng, title);
  if (!map) return null;
  return renderMapPreviewTrigger(map, lat as number, lng as number, title, `${(lat as number).toFixed(6)}, ${(lng as number).toFixed(6)}`, undefined);
}

function renderPoints(media: EstateConclusionMedia): HTMLElement | null {
  if (!media.points.length) return null;
  const list = h("div", { class: "conclusion-points" });
  const mapConfig = resolveMapConfig(state.config?.map);
  for (const point of media.points) {
    const meta = [precisionLabel(point.precision), point.address, coordinateText(point)].filter(Boolean).join(" · ");
    const links = renderLinks(point.links, mapLinkKey(mapConfig.provider));
    list.appendChild(h("div", { class: "conclusion-point" },
      h("div", { class: "conclusion-point-main" },
        h("strong", { class: "conclusion-point-name" }, point.name),
        meta ? h("span", { class: "conclusion-point-meta" }, meta) : null,
      ),
      links,
    ));
  }
  return list.childElementCount ? list : null;
}

function renderImages(images: ConclusionImage[]): HTMLElement | null {
  if (!images.length) return null;
  const grid = h("div", { class: "conclusion-images" });
  images.forEach((image) => {
    const figure = renderImageFigure(image);
    if (figure) grid.appendChild(figure);
  });
  return grid.childElementCount ? grid : null;
}

function renderConclusion(media: EstateConclusionMedia): HTMLElement {
  const hasTable = media.properties.length > 0;
  const hasExports = media.exports.length > 0;
  const hasVr = media.properties.some((property) => Boolean(property.vrUrl));
  const section = h("section", {
    class: "conclusion-media",
    "aria-label": "本轮结论中的房源对比表",
  },
    h("div", { class: "conclusion-media-head" },
      h("span", { class: "conclusion-media-icon" }, icon(hasTable || hasExports ? "House" : "MapPin", { size: 14 })),
      h("div", { class: "conclusion-media-copy" },
        h("strong", null, hasTable ? "推荐房源对比" : hasExports ? "房源对比清单" : "结论附图：位置与户型"),
        h("span", null, hasTable
          ? `最多展示 12 套${hasExports ? "，完整候选已写入 Excel" : ""}；${hasVr ? "真实 VR" : "户型图"}与位置按房源自动匹配；内部编号已隐藏`
          : hasExports ? "完整候选已写入 Excel，可直接下载后继续筛选比对" : "地图与图片直接来自本轮工具结果"),
      ),
    ),
  );
  const exports = renderExports(media.exports);
  if (exports) section.appendChild(exports);
  if (hasTable) {
    const { table, mappedLocations } = renderPropertyTable(media);
    section.appendChild(table);
    if (!mappedLocations) {
      const map = renderMap(media);
      if (map) section.appendChild(map);
    }
  } else {
    const map = renderMap(media);
    if (map) section.appendChild(map);
    const points = renderPoints(media);
    if (points) section.appendChild(points);
    const images = renderImages(media.images);
    if (images) section.appendChild(images);
  }
  return section;
}

function removeConclusion(block: AssistantBlock, body: HTMLElement): void {
  const existing = conclusionEls.get(block);
  if (existing) existing.remove();
  conclusionEls.delete(block);
  body.classList.remove("has-conclusion-media");
}

/** 最终文本落盘后刷新；流式文本、后续工具调用和重写阶段都会移除旧表。 */
export function refreshConclusionMedia(block: AssistantBlock): void {
  const body = blockBodies.get(block);
  if (!body) return;
  const textPart = latestCompletedTextPart(block);
  if (!textPart) {
    removeConclusion(block, body);
    return;
  }
  const media = collectEstateConclusionMedia(block.parts, textPart.text);
  if (!media.mapEmbedUrl && !media.points.length && !media.images.length && !media.properties.length && !media.exports.length) {
    removeConclusion(block, body);
    return;
  }

  const section = renderConclusion(media);
  const existing = conclusionEls.get(block);
  if (existing && existing.parentElement === body) {
    existing.replaceWith(section);
  } else {
    const textEl = partEls.get(textPart)?.el;
    if (textEl?.parentElement === body) {
      textEl.after(section);
    } else {
      const usage = body.querySelector<HTMLElement>(".usage-caption");
      body.insertBefore(section, usage ?? null);
    }
  }
  conclusionEls.set(block, section);
  body.classList.add("has-conclusion-media");
}

/** 模型文字可能复述工具参数；展示前按本轮真实 houseId 做确定性脱敏。 */
export function sanitizeEstateConclusionText(block: AssistantBlock, value: string): string {
  return stripEstateHouseIds(value, collectEstateHouseIds(block.parts));
}
