/**
 * ============================================================
 * render/conclusion-media.ts — 房产最终结论中的地图与图片附件
 * ============================================================
 * 职责：把同一轮 house_* 工具结果中的位置和户型图挂到最终回答下方。
 * 设计立场：这是结论的一部分，不放进可折叠工具卡；只有最后一条文本已经
 * 落盘且非流式时才出现，工具仍在执行或回答还在重写时自动移除。
 */
import { blockBodies } from "../core/state.js";
import {
  collectEstateConclusionMedia,
  type ConclusionImage,
  type ConclusionPoint,
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

function renderMap(media: EstateConclusionMedia): HTMLElement | null {
  if (!media.mapEmbedUrl) return null;
  const iframe = document.createElement("iframe");
  iframe.src = media.mapEmbedUrl;
  iframe.loading = "lazy";
  iframe.title = media.mapTitle || "房源位置地图";
  return h("div", { class: "conclusion-map" }, iframe);
}

function renderPoints(media: EstateConclusionMedia): HTMLElement | null {
  if (!media.points.length) return null;
  const list = h("div", { class: "conclusion-points" });
  for (const point of media.points) {
    const meta = [
      precisionLabel(point.precision),
      point.address,
      coordinateText(point),
    ].filter(Boolean).join(" · ");
    const links = renderLinks(point.links);
    const row = h("div", { class: "conclusion-point" },
      h("div", { class: "conclusion-point-main" },
        h("strong", { class: "conclusion-point-name" }, point.name),
        meta ? h("span", { class: "conclusion-point-meta" }, meta) : null,
      ),
      links,
    );
    list.appendChild(row);
  }
  return list.childElementCount ? list : null;
}

function renderImages(images: ConclusionImage[]): HTMLElement | null {
  if (!images.length) return null;
  const grid = h("div", { class: "conclusion-images" });
  images.forEach((image, index) => {
    const src = safeImageSrc(image.src);
    if (!src) return;
    const img = document.createElement("img");
    img.src = src;
    img.alt = image.alt;
    img.loading = index === 0 ? "eager" : "lazy";
    img.decoding = "async";
    const href = safeHref(src);
    const visual = href
      ? h("a", { class: "conclusion-image-open", href, target: "_blank", rel: "noopener noreferrer" }, img)
      : img;
    grid.appendChild(h("figure", { class: "conclusion-image-card" },
      visual,
      h("figcaption", null, index === 0 ? "主户型图" : `户型图 ${index + 1}`),
    ));
  });
  return grid.childElementCount ? grid : null;
}

function renderConclusion(media: EstateConclusionMedia): HTMLElement {
  const section = h("section", {
    class: "conclusion-media",
    "aria-label": "本轮结论中的房源位置与户型图",
  },
    h("div", { class: "conclusion-media-head" },
      h("span", { class: "conclusion-media-icon" }, icon("Sparkles", { size: 14 })),
      h("div", { class: "conclusion-media-copy" },
        h("strong", null, "结论附图：位置与户型"),
        h("span", null, media.mapEmbedUrl ? "地图直接定位；点击图片可查看原图" : "户型图直接展示；地图链接可手动核对"),
      ),
    ),
  );
  const map = renderMap(media);
  if (map) section.appendChild(map);
  const points = renderPoints(media);
  if (points) section.appendChild(points);
  const images = renderImages(media.images);
  if (images) section.appendChild(images);
  return section;
}

function removeConclusion(block: AssistantBlock, body: HTMLElement): void {
  const existing = conclusionEls.get(block);
  if (existing) existing.remove();
  conclusionEls.delete(block);
  body.classList.remove("has-conclusion-media");
}

/** 最终文本落盘后刷新；流式文本、后续工具调用和重写阶段都会移除旧附件。 */
export function refreshConclusionMedia(block: AssistantBlock): void {
  const body = blockBodies.get(block);
  if (!body) return;
  const last = block.parts.at(-1);
  if (!last || last.p !== "text" || last.streaming || !last.text.trim()) {
    removeConclusion(block, body);
    return;
  }
  const media = collectEstateConclusionMedia(block.parts);
  if (!media.mapEmbedUrl && !media.points.length && !media.images.length) {
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
