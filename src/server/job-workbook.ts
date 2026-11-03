/**
 * job-workbook.ts — 求职清单的原生 Excel 交付
 * ============================================================
 * 不引入额外 npm 依赖：用标准库拼最小 OOXML 工作簿并写 ZIP；
 * 输出可由 Excel / WPS 直接打开，状态列带可选项，方便用户维护投递进度。
 */
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import type { JobManifest, JobRecord } from "./job-model.js";
import { JOB_STATUS_OPTIONS } from "./job-model.js";

const HEADERS = [
  "平台", "岗位名称", "公司名称", "薪资", "地区", "经验要求", "学历要求", "综合得分",
  "是否外包", "外包判定理由", "上架时间", "HR最近活跃", "公司规模", "行业", "融资阶段",
  "单双休", "上下班时间", "岗位福利", "工作地址", "投递状态", "投递链接", "备注", "得分拆解", "岗位方向", "采集时间",
] as const;
const WIDTHS = [14, 28, 28, 14, 18, 12, 10, 10, 10, 26, 18, 20, 14, 18, 12, 12, 18, 34, 34, 12, 40, 20, 42, 18, 20];
const STATUS_COLUMN = 20;

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

function inlineCell(ref: string, value: string, style = 0): string {
  return `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ""}><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
}

function numberCell(ref: string, value: number): string {
  return `<c r="${ref}"><v>${Number.isFinite(value) ? value : 0}</v></c>`;
}

function rowXml(rowNumber: number, job: JobRecord): string {
  const values: Array<string | number> = [
    job.platform, job.title, job.company, job.salary, job.city, job.experience, job.education, job.score,
    job.isOutsourcing, job.outsourcingReason, job.published, job.hrActive, job.companySize, job.companyIndustry,
    job.companyFinancing, job.workRest, job.workHours, job.welfare, job.address, job.status, job.applyUrl,
    job.remark, job.scoreDetail, job.direction, job.fetchedAt,
  ];
  const cells = values.map((value, index) => {
    const ref = `${columnName(index + 1)}${rowNumber}`;
    if (typeof value === "number") return numberCell(ref, value);
    if (index === HEADERS.length - 1 && value) return inlineCell(ref, value, 2);
    if (index === 17 || index === 18 || index === 22) return inlineCell(ref, value, 2);
    return inlineCell(ref, value);
  });
  return `<row r="${rowNumber}">${cells.join("")}</row>`;
}

function sheetXml(manifest: JobManifest): string {
  const header = `<row r="1">${HEADERS.map((value, index) => inlineCell(`${columnName(index + 1)}1`, value, 1)).join("")}</row>`;
  const rows = manifest.jobs.map((job, index) => rowXml(index + 2, job)).join("");
  const maxRow = Math.max(2, manifest.jobs.length + 1);
  const cols = WIDTHS.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join("");
  const statusValues = JOB_STATUS_OPTIONS.join(",");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="18"/><cols>${cols}</cols><sheetData>${header}${rows}</sheetData>
<autoFilter ref="A1:${columnName(HEADERS.length)}${maxRow}"/>
<dataValidations count="1"><dataValidation type="list" allowBlank="1" showErrorMessage="1" errorTitle="投递状态" error="请选择清单中的投递状态" sqref="T2:T${maxRow}"><formula1>"${statusValues}"</formula1></dataValidation></dataValidations>
<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.2" footer="0.2"/>
</worksheet>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="10"/><name val="Microsoft YaHei"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="10"/><name val="Microsoft YaHei"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F4E78"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFill="1" applyFont="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function contentTypes(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;
}

function rootRels(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
}

function workbookXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="岗位清单" sheetId="1" r:id="rId1"/></sheets></workbook>`;
}

function workbookRels(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** 最小 ZIP 写入器；xlsx 不追求压缩率，store 模式兼容性最好且实现可审计。 */
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

function timestamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export async function writeJobWorkbook(manifest: JobManifest, outDir: string): Promise<string> {
  await fsp.mkdir(outDir, { recursive: true });
  const path = join(outDir, `岗位清单_${timestamp()}.xlsx`);
  const data = zipStore([
    { name: "[Content_Types].xml", data: Buffer.from(contentTypes(), "utf8") },
    { name: "_rels/.rels", data: Buffer.from(rootRels(), "utf8") },
    { name: "xl/workbook.xml", data: Buffer.from(workbookXml(), "utf8") },
    { name: "xl/_rels/workbook.xml.rels", data: Buffer.from(workbookRels(), "utf8") },
    { name: "xl/styles.xml", data: Buffer.from(STYLES, "utf8") },
    { name: "xl/worksheets/sheet1.xml", data: Buffer.from(sheetXml(manifest), "utf8") },
  ]);
  await fsp.writeFile(path, data);
  return path;
}
