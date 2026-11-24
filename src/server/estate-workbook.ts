/**
 * ============================================================
 * estate-workbook.ts — 房产候选的 Excel 对比交付
 * ============================================================
 * 结论表最多展示 12 套；超过时把完整候选写入本地受控目录，并通过同源 API
 * 下载。字段只来自 house_search / house_lookup 的真实结果，内部 houseId 不进入
 * 表格；文件 ID 与 user-facing 文件名分离，避免路径穿越和中文文件名兼容问题。
 */
import { randomUUID } from "node:crypto";
import { promises as fsp } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeSimpleXlsx, type XlsxCellValue, type XlsxHyperlink } from "./xlsx-lite.js";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_EXPORT_DIR = join(MODULE_DIR, "..", "..", ".setting", "estate-exports");
const EXPORT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_TEXT_LENGTH = 500;
const MAX_REASON_LENGTH = 1_000;
const HEADERS = [
  "序号", "房源", "小区", "户型", "面积", "价格", "楼层", "朝向", "装修", "地址", "匹配说明", "VR 看房", "房源详情",
] as const;
const WIDTHS = [7, 28, 18, 12, 10, 16, 12, 12, 12, 38, 42, 18, 14];

export interface EstateWorkbookListing {
  houseId?: string;
  id?: string;
  title?: string;
  community?: string;
  layout?: string;
  area?: string;
  price?: string;
  rent?: string;
  floor?: string;
  orientation?: string;
  decoration?: string;
  address?: string;
  addressText?: string;
  matchReason?: string;
  hasVr?: boolean;
  vr?: string;
  vrUrl?: string;
  detailUrl?: string;
  url?: string;
  rentCode?: string;
}

export interface EstateWorkbookContext {
  mode: "buy" | "rent";
  city: string;
  query?: string;
}

export interface EstateExportArtifact {
  fileName: string;
  downloadUrl: string;
  count: number;
  createdAt: string;
}

function exportDir(): string {
  return process.env.ESTATE_EXPORT_DIR?.trim() || DEFAULT_EXPORT_DIR;
}

function text(value: unknown, max = MAX_TEXT_LENGTH): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function safeHttpsUrl(value: unknown): string {
  const raw = text(value, 2_000);
  if (!raw) return "";
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

function timestamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function citySub(city: string): string {
  const map: Record<string, string> = {
    北京: "bj", 上海: "sh", 广州: "gz", 深圳: "sz", 成都: "cd", 杭州: "hz", 天津: "tj", 南京: "nj", 武汉: "wh", 西安: "xa", 重庆: "cq", 苏州: "su", 长沙: "cs", 郑州: "zz", 东莞: "dg", 青岛: "qd", 沈阳: "sy", 宁波: "nb", 昆明: "km", 合肥: "hf", 佛山: "fs", 无锡: "wx", 济南: "jn", 大连: "dl", 厦门: "xm", 福州: "fz", 哈尔滨: "hrb", 长春: "cc", 石家庄: "sjz", 太原: "ty", 南昌: "nc", 贵阳: "gy", 南宁: "nn", 兰州: "lz", 海口: "hk", 珠海: "zh", 中山: "zs", 惠州: "huizhou", 常州: "cz", 徐州: "xz", 烟台: "yt", 潍坊: "wf", 温州: "wz", 嘉兴: "jx", 绍兴: "sx", 台州: "tz", 泉州: "qz", 金华: "jh", 保定: "bd", 廊坊: "lf", 洛阳: "ly", 唐山: "ts",
  };
  return map[city.trim().replace(/\s+/g, "").replace(/市$/, "")] || "";
}

function safeFilePart(value: string): string {
  return value.replace(/[\\/:*?"<>|\r\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, 24);
}

function normalizeRows(listings: EstateWorkbookListing[]): Array<EstateWorkbookListing & { houseId: string }> {
  const rows: Array<EstateWorkbookListing & { houseId: string }> = [];
  const seen = new Set<string>();
  for (const listing of listings) {
    const houseId = text(listing.houseId || listing.id, 80);
    const title = text(listing.title);
    const community = text(listing.community);
    const layout = text(listing.layout, 80);
    const area = text(listing.area, 80);
    const price = text(listing.price || listing.rent, 120);
    const key = houseId || [community, layout, area, price, title].join("|");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    rows.push({
      ...listing,
      houseId,
      ...(title ? { title } : {}),
      ...(community ? { community } : {}),
      ...(layout ? { layout } : {}),
      ...(area ? { area } : {}),
      ...(price ? { price } : {}),
      ...(text(listing.floor, 80) ? { floor: text(listing.floor, 80) } : {}),
      ...(text(listing.orientation, 80) ? { orientation: text(listing.orientation, 80) } : {}),
      ...(text(listing.decoration, 80) ? { decoration: text(listing.decoration, 80) } : {}),
      ...(text(listing.address || listing.addressText) ? { address: text(listing.address || listing.addressText) } : {}),
      ...(text(listing.matchReason, MAX_REASON_LENGTH) ? { matchReason: text(listing.matchReason, MAX_REASON_LENGTH) } : {}),
    });
  }
  return rows;
}

/** 生成候选对比工作簿；返回值可直接放进工具 JSON 与结论附件。 */
export async function writeEstateWorkbook(
  listings: EstateWorkbookListing[],
  context: EstateWorkbookContext,
): Promise<EstateExportArtifact> {
  const rows = normalizeRows(listings);
  if (!rows.length) throw new Error("没有可写入 Excel 的房源");
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const modeLabel = context.mode === "rent" ? "租房" : "买房";
  const cityLabel = safeFilePart(context.city) || "房产";
  const fileName = `房源对比_${cityLabel}_${modeLabel}_${timestamp()}.xlsx`;
  const dataRows: XlsxCellValue[][] = rows.map((row, index) => {
    const title = text(row.title) || [row.community, row.layout, row.area].filter(Boolean).join(" · ") || `房源 ${index + 1}`;
    const vrUrl = safeHttpsUrl(row.vrUrl || row.vr);
    const detailUrl = safeHttpsUrl(row.detailUrl || row.url) || (context.mode === "rent" && row.rentCode
  ? `https://m.ke.com/chuzu/${citySub(context.city)}/zufang/${row.rentCode.toUpperCase().trim()}.html`
  : "");
    return [
      index + 1,
      title,
      text(row.community),
      text(row.layout, 80),
      text(row.area, 80),
      text(row.price || row.rent, 120),
      text(row.floor, 80),
      text(row.orientation, 80),
      text(row.decoration, 80),
      text(row.address || row.addressText),
      text(row.matchReason, MAX_REASON_LENGTH),
      vrUrl ? "打开 VR" : "",
      detailUrl ? "查看房源" : "",
    ];
  });
  const hyperlinks: XlsxHyperlink[] = [];
  rows.forEach((row, index) => {
    const rowNumber = index + 2;
    const vrUrl = safeHttpsUrl(row.vrUrl || row.vr);
    const detailUrl = safeHttpsUrl(row.detailUrl || row.url) || (context.mode === "rent" && row.rentCode
      ? `https://m.ke.com/chuzu/${citySub(context.city)}/zufang/${row.rentCode.toUpperCase().trim()}.html`
      : "");
    if (vrUrl) hyperlinks.push({ cell: `L${rowNumber}`, target: vrUrl, display: "打开 VR" });
    if (detailUrl) hyperlinks.push({ cell: `M${rowNumber}`, target: detailUrl, display: "查看房源" });
  });
  await writeSimpleXlsx(join(exportDir(), `${id}.xlsx`), {
    sheetName: `${modeLabel}候选`,
    rows: [HEADERS as unknown as XlsxCellValue[], ...dataRows],
    widths: WIDTHS,
    hyperlinks,
  });
  await fsp.writeFile(join(exportDir(), `${id}.json`), JSON.stringify({
    fileName,
    count: rows.length,
    createdAt,
    city: context.city,
    mode: context.mode,
    query: context.query ?? "",
  }, null, 2), "utf8");
  return {
    fileName,
    downloadUrl: `/api/estate/exports/${id}`,
    count: rows.length,
    createdAt,
  };
}

export interface StoredEstateExport {
  data: Buffer;
  fileName: string;
}

/** 读取已生成文件；ID 必须是 UUID，文件名只从 sidecar 读取，不接受 URL 参数拼路径。 */
export async function readEstateExport(id: string): Promise<StoredEstateExport | null> {
  if (!EXPORT_ID_RE.test(id)) return null;
  const dir = exportDir();
  let fileName = `房源对比_${id.slice(0, 8)}.xlsx`;
  try {
    const meta = JSON.parse(await fsp.readFile(join(dir, `${id}.json`), "utf8")) as { fileName?: unknown };
    const candidate = text(meta.fileName, 120);
    if (candidate.toLowerCase().endsWith(".xlsx") && !/[\\/\r\n]/.test(candidate)) fileName = candidate;
  } catch {
    // sidecar 缺失不影响下载，使用稳定兜底文件名。
  }
  try {
    return { data: await fsp.readFile(join(dir, `${id}.xlsx`)), fileName };
  } catch {
    return null;
  }
}
