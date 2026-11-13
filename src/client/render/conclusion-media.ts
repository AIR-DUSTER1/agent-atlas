/**
 * ============================================================
 * render/conclusion-media.ts — 房产最终结论中的结构化对比表
 * ============================================================
 * 职责：把同一轮 house_* 结果按 houseId 合并成“房源 / 户型图 / 地理位置”
 * 表格，挂到最终回答下方。内部 ID 只参与匹配，不展示给用户；流式或重写
 * 阶段自动撤下旧表，避免结论与过程不一致。
 */
import { blockBodies } from "../core/state.js";
import {
  collectEstateConclusionMedia,
  collectEstateHouseIds,
  stripEstateHouseIds,
  type ConclusionImage,
  type ConclusionPoint,
  type ConclusionProperty,
  type EstateConclusionMedia,
} from "../modules/conclusion-media.js";
import { safeHref, safeImageSrc } from "../modules/format.js";
import { h } from "../ui/h.js";
import { icon } from "../ui/icon.js";
import type { AssistantBlock } from "../modules/types.js";

const MAP_LINK_LABELS: Record<string, string> = {
  amap: "高德地图",
  qq: "腾讯地图",
  baidu: "百度地图",
  osm: "OSM",
};
const conclusionEls = new WeakMap<AssistantBlock, HTMLElement>();

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

function renderLinks(links: Record<string, string> | undefined): HTMLElement | null {
  if (!links) return null;
  const row = h("div", { class: "conclusion-links" });
  for (const [label, raw] of Object.entries(links)) {
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

function renderMapFrame(embedUrl: string, title: string, compact = false): HTMLElement | null {
  const src = safeHref(embedUrl);
  if (!src || !/^https:\/\/www\.openstreetmap\.org\//i.test(src)) return null;
  const iframe = document.createElement("iframe");
  iframe.src = src;
  iframe.loading = "lazy";
  iframe.title = title;
  return h("div", { class: compact ? "conclusion-property-map" : "conclusion-map" }, iframe);
}

function renderImageFigure(image: ConclusionImage, compact = false): HTMLElement | null {
  const src = safeImageSrc(image.src);
  if (!src) return null;
  const img = document.createElement("img");
  img.src = src;
  img.alt = image.alt;
  img.loading = compact ? "lazy" : "eager";
  img.decoding = "async";
  const href = safeHref(src);
  const visual = href
    ? h("a", { class: "conclusion-image-open", href, target: "_blank", rel: "noopener noreferrer" }, img)
    : img;
  return h("figure", { class: compact ? "conclusion-image-card compact" : "conclusion-image-card" }, visual);
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

  const key = [location.name, location.lat ?? "", location.lng ?? ""].join("|");
  const embed = location.embedUrl || (media.properties.length === 1 ? media.mapEmbedUrl : "");
  if (embed && !rendered.has(key)) {
    const map = renderMapFrame(embed, `${property.title || location.name} 位置`, true);
    if (map) {
      cell.appendChild(map);
      rendered.add(key);
    }
  } else if (rendered.has(key)) {
    cell.appendChild(h("span", { class: "conclusion-same-location" }, "同一小区位置，见上方地图"));
  }

  cell.appendChild(h("strong", { class: "conclusion-location-name" }, location.name || property.community || "房源位置"));
  const meta = [precisionLabel(location.precision), location.address || property.address, coordinateText(location)]
    .filter(Boolean).join(" · ");
  if (meta) cell.appendChild(h("span", { class: "conclusion-location-meta" }, meta));
  const links = renderLinks(location.links);
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
    row.appendChild(facts);
    row.appendChild(renderImageCell(property));
    row.appendChild(renderLocationCell(property, media, renderedLocations));
    tbody.appendChild(row);
  }
  table.append(thead, tbody);
  return { table, mappedLocations: renderedLocations.size };
}

function renderMap(media: EstateConclusionMedia): HTMLElement | null {
  return media.mapEmbedUrl ? renderMapFrame(media.mapEmbedUrl, media.mapTitle || "房源位置地图") : null;
}

function renderPoints(media: EstateConclusionMedia): HTMLElement | null {
  if (!media.points.length) return null;
  const list = h("div", { class: "conclusion-points" });
  for (const point of media.points) {
    const meta = [precisionLabel(point.precision), point.address, coordinateText(point)].filter(Boolean).join(" · ");
    const links = renderLinks(point.links);
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
  const section = h("section", {
    class: "conclusion-media",
    "aria-label": "本轮结论中的房源对比表",
  },
    h("div", { class: "conclusion-media-head" },
      h("span", { class: "conclusion-media-icon" }, icon(hasTable ? "House" : "MapPin", { size: 14 })),
      h("div", { class: "conclusion-media-copy" },
        h("strong", null, hasTable ? "推荐房源对比" : "结论附图：位置与户型"),
        h("span", null, hasTable
          ? "按月租从低到高；户型图与位置按房源自动匹配；内部编号已隐藏"
          : "地图与图片直接来自本轮工具结果"),
      ),
    ),
  );
  if (hasTable) {
    const { table, mappedLocations } = renderPropertyTable(media);
    section.appendChild(table);
    if (!mappedLocations) {
      const map = renderMap(media);
      if (map) section.appendChild(map);
    }
    const used = new Set(media.properties.flatMap((property) => property.images.map((image) => image.src)));
    const orphans = media.images.filter((image) => !used.has(image.src));
    const gallery = renderImages(orphans);
    if (gallery) {
      section.appendChild(h("div", { class: "conclusion-subtitle" }, "其他户型图"));
      section.appendChild(gallery);
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
  const last = block.parts.at(-1);
  if (!last || last.p !== "text" || last.streaming || !last.text.trim()) {
    removeConclusion(block, body);
    return;
  }
  const media = collectEstateConclusionMedia(block.parts);
  if (!media.mapEmbedUrl && !media.points.length && !media.images.length && !media.properties.length) {
    removeConclusion(block, body);
    return;
  }

  const section = renderConclusion(media);
  const existing = conclusionEls.get(block);
  if (existing && existing.parentElement === body) {
    existing.replaceWith(section);
  } else {
    const usage = body.querySelector<HTMLElement>(".usage-caption");
    body.insertBefore(section, usage ?? null);
  }
  conclusionEls.set(block, section);
  body.classList.add("has-conclusion-media");
}

/** 模型文字可能复述工具参数；展示前按本轮真实 houseId 做确定性脱敏。 */
export function sanitizeEstateConclusionText(block: AssistantBlock, value: string): string {
  return stripEstateHouseIds(value, collectEstateHouseIds(block.parts));
}
