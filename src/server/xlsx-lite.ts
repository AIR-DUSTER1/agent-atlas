/**
 * ============================================================
 * xlsx-lite.ts — 无第三方依赖的最小 OOXML 工作簿写入
 * ============================================================
 * 只覆盖本项目需要的单工作表、行样式和外部超链接；ZIP 用 store 模式，
 * 便于审计且兼容 Excel/WPS。业务模块负责列定义，这里不感知房源或岗位字段。
 */
import { promises as fsp } from "node:fs";
import { dirname } from "node:path";

const MAX_ROWS = 2_000;
const MAX_COLUMNS = 64;
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[i] = value >>> 0;
  }
  return table;
})();

export type XlsxCellValue = string | number | null | undefined;

export interface XlsxHyperlink {
  cell: string;
  target: string;
  display?: string;
}

export interface SimpleXlsxOptions {
  sheetName: string;
  rows: XlsxCellValue[][];
  widths?: number[];
  hyperlinks?: XlsxHyperlink[];
  freezeHeader?: boolean;
  autoFilter?: boolean;
}

function xml(value: unknown): string {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function columnName(index: number): string {
  let value = index;
  let out = "";
  while (value > 0) {
    const mod = (value - 1) % 26;
    out = String.fromCharCode(65 + mod) + out;
    value = Math.floor((value - 1) / 26);
  }
  return out;
}

function safeSheetName(value: string): string {
  return (value.replace(/[\\/?*[\]:]/g, " ").trim() || "Sheet1").slice(0, 31);
}

function inlineCell(ref: string, value: string, style = 0): string {
  return `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ""}><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
}

function numberCell(ref: string, value: number): string {
  return `<c r="${ref}"><v>${Number.isFinite(value) ? value : 0}</v></c>`;
}

function sheetXml(options: SimpleXlsxOptions): string {
  const hyperlinks = options.hyperlinks ?? [];
  const hyperlinkCells = new Set(hyperlinks.map((link) => link.cell));
  const header = `<row r="1">${options.rows[0]!.map((value, index) =>
    inlineCell(`${columnName(index + 1)}1`, String(value ?? ""), 1)
  ).join("")}</row>`;
  const rows = options.rows.slice(1).map((row, rowIndex) => {
    const rowNumber = rowIndex + 2;
    const cells = row.map((value, columnIndex) => {
      const ref = `${columnName(columnIndex + 1)}${rowNumber}`;
      if (typeof value === "number") return numberCell(ref, value);
      if (value == null || value === "") return `<c r="${ref}"/>`;
      return inlineCell(ref, String(value), hyperlinkCells.has(ref) ? 3 : 2);
    }).join("");
    return `<row r="${rowNumber}">${cells}</row>`;
  }).join("");
  const maxRow = Math.max(2, options.rows.length);
  const maxColumn = columnName(Math.max(1, options.rows[0]!.length));
  const widths = (options.widths ?? []).map((width, index) =>
    `<col min="${index + 1}" max="${index + 1}" width="${Math.max(8, width)}" customWidth="1"/>`
  ).join("");
  const pane = options.freezeHeader === false ? "" :
    '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/>';
  const autoFilter = options.autoFilter === false ? "" : `<autoFilter ref="A1:${maxColumn}${maxRow}"/>`;
  const links = hyperlinks.map((link, index) =>
    `<hyperlink ref="${xml(link.cell)}" r:id="rId${index + 1}"${link.display ? ` display="${xml(link.display)}"` : ""}/>`
  ).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetViews><sheetView workbookViewId="0">${pane}</sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="18"/><cols>${widths}</cols><sheetData>${header}${rows}</sheetData>
${autoFilter}${links ? `<hyperlinks>${links}</hyperlinks>` : ""}
<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.2" footer="0.2"/>
</worksheet>`;
}

function sheetRels(options: SimpleXlsxOptions): string {
  const links = (options.hyperlinks ?? []).map((link, index) =>
    `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xml(link.target)}" TargetMode="External"/>`
  ).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${links}</Relationships>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="3"><font><sz val="10"/><name val="Microsoft YaHei"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="10"/><name val="Microsoft YaHei"/></font><font><u/><color rgb="FF0563C1"/><sz val="10"/><name val="Microsoft YaHei"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F4E78"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFill="1" applyFont="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function contentTypes(): string {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>';
}

function rootRels(): string {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
}

function workbookXml(sheetName: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xml(safeSheetName(sheetName))}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
}

function workbookRels(): string {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>';
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zipStore(files: Array<{ name: string; data: Buffer }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const now = new Date();
  const time = ((now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2)) & 0xffff;
  const date = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const crc = crc32(file.data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(file.data.length, 18); local.writeUInt32LE(file.data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    locals.push(local, file.data);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12); central.writeUInt16LE(date, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(file.data.length, 20); central.writeUInt32LE(file.data.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32); central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38); central.writeUInt32LE(offset, 42); name.copy(central, 46);
    centrals.push(central);
    offset += local.length + file.data.length;
  }
  const centralSize = centrals.reduce((sum, item) => sum + item.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, end]);
}

/** 生成工作簿字节；测试可直接校验内容而不落盘。 */
export function buildSimpleXlsx(options: SimpleXlsxOptions): Buffer {
  if (!options.rows.length) throw new Error("Excel 至少需要一行表头");
  if (options.rows.length > MAX_ROWS) throw new Error(`Excel 行数超过上限 ${MAX_ROWS}`);
  const columnCount = options.rows[0]!.length;
  if (!columnCount || columnCount > MAX_COLUMNS) throw new Error(`Excel 列数必须在 1-${MAX_COLUMNS} 之间`);
  if (options.rows.some((row) => row.length > columnCount)) throw new Error("Excel 每行列数不能超过表头");
  const data = zipStore([
    { name: "[Content_Types].xml", data: Buffer.from(contentTypes(), "utf8") },
    { name: "_rels/.rels", data: Buffer.from(rootRels(), "utf8") },
    { name: "xl/workbook.xml", data: Buffer.from(workbookXml(options.sheetName), "utf8") },
    { name: "xl/_rels/workbook.xml.rels", data: Buffer.from(workbookRels(), "utf8") },
    { name: "xl/styles.xml", data: Buffer.from(STYLES, "utf8") },
    { name: "xl/worksheets/sheet1.xml", data: Buffer.from(sheetXml(options), "utf8") },
    { name: "xl/worksheets/_rels/sheet1.xml.rels", data: Buffer.from(sheetRels(options), "utf8") },
  ]);
  return data;
}

export async function writeSimpleXlsx(path: string, options: SimpleXlsxOptions): Promise<void> {
  await fsp.mkdir(dirname(path), { recursive: true });
  await fsp.writeFile(path, buildSimpleXlsx(options));
}
