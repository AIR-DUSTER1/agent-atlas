/**
 * server/job-html.ts — 求职岗位 HTML 报告生成器
 * 职责：把内置求职 Agent 的最新岗位 JSON 渲染成与 Excel 同名的自包含 HTML。
 * 设计立场：报告只做本地静态交付，不引脚本、不读网络；所有岗位字段先转义再拼装。
 */
import { promises as fsp } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { JobManifest, JobRecord } from "./job-model.js";

/** HTML 报告最多渲染的岗位数；超出时保留摘要并明确标注截断，避免生成超大文件 */
const MAX_HTML_JOB_ROWS = 1_000;
/** 单个单元格 / 明细字段的最大字符数；过长 JD 类内容在报告里截断 */
const MAX_FIELD_CHARS = 500;
/** 找不到 Excel 时使用的兜底文件名（正常采集成功后都会优先匹配 Excel 同名） */
const FALLBACK_HTML_NAME = "最新岗位清单.html";

/** 把任意未知文本安全放进 HTML；这里不信任招聘站点抓回来的任何字段 */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** 只允许 http/https 链接，阻断 JSON 中可能混入的 javascript: 地址 */
function safeHttpUrl(value: string): string {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

function clip(value: string): string {
  const text = value.trim();
  return text.length > MAX_FIELD_CHARS ? `${text.slice(0, MAX_FIELD_CHARS)}…` : text;
}

function text(value: string, fallback = "—"): string {
  const clipped = clip(value);
  return clipped ? clipped : fallback;
}

function formatDateTime(value: Date): string {
  const pad = (num: number) => String(num).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ` +
    `${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

function countBy(jobs: JobRecord[], read: (job: JobRecord) => string): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const job of jobs) {
    const key = read(job).trim() || "未分类";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-CN"));
}

function renderCounts(title: string, counts: Array<[string, number]>): string {
  const items = counts
    .slice(0, 8)
    .map(([name, count]) => `<li><span>${escapeHtml(name)}</span><strong>${count}</strong></li>`)
    .join("");
  const more = counts.length > 8 ? `<li class="more">另有 ${counts.length - 8} 类未展示</li>` : "";
  return `<section><h2>${escapeHtml(title)}</h2><ul class="counts">${items}${more}</ul></section>`;
}

function renderLink(job: JobRecord): string {
  const url = safeHttpUrl(job.applyUrl);
  if (!url) return `<span class="muted">—</span>`;
  return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer nofollow">打开</a>`;
}

function renderDetails(job: JobRecord): string {
  const fields: Array<[string, string]> = [
    ["外包判定", `${job.isOutsourcing || "待确认"}${job.outsourcingReason ? `（${job.outsourcingReason}）` : ""}`],
    ["得分拆解", job.scoreDetail],
    ["学历", job.education],
    ["公司规模", job.companySize],
    ["行业", job.companyIndustry],
    ["融资", job.companyFinancing],
    ["公司简介", job.companyIntro],
    ["福利", job.welfare],
    ["工作地址", job.address],
    ["上架时间", job.published],
    ["备注", job.remark],
  ];
  const visible = fields.filter(([, value]) => value.trim());
  if (!visible.length) return "<span class=\"muted\">无补充信息</span>";
  return `<details><summary>查看详情</summary><dl>${visible
    .map(([name, value]) => `<dt>${escapeHtml(name)}</dt><dd>${escapeHtml(text(value, "—"))}</dd>`)
    .join("")}</dl></details>`;
}

function renderJobRow(job: JobRecord): string {
  const outsourcing = job.isOutsourcing === "是";
  return `<tr class="${outsourcing ? "outsourcing" : ""}">
<td class="score">${Math.round(job.score * 10) / 10}</td>
<td class="title"><strong>${escapeHtml(text(job.title))}</strong><span>${escapeHtml(text(job.direction, "未分类"))}</span></td>
<td>${escapeHtml(text(job.company))}</td>
<td>${escapeHtml(text(job.platform))}</td>
<td>${escapeHtml(text(job.salary))}</td>
<td>${escapeHtml(text(job.city))}</td>
<td>${escapeHtml(text(job.experience))}</td>
<td>${escapeHtml(text(job.hrActive))}</td>
<td>${escapeHtml(text(job.workRest))}</td>
<td><span class="status">${escapeHtml(text(job.status))}</span></td>
<td>${renderLink(job)}</td>
<td class="details">${renderDetails(job)}</td>
</tr>`;
}

function renderDocument(manifest: JobManifest): string {
  const jobs = manifest.jobs.slice(0, MAX_HTML_JOB_ROWS);
  const omitted = manifest.jobs.length - jobs.length;
  const outsourcingCount = manifest.jobs.filter((job) => job.isOutsourcing === "是").length;
  const averageScore = manifest.jobs.length
    ? Math.round((manifest.jobs.reduce((sum, job) => sum + job.score, 0) / manifest.jobs.length) * 10) / 10
    : 0;
  const generatedAt = formatDateTime(new Date());
  // 技能时间格式是「YYYY-MM-DD HH:mm」；原样展示避免各平台 Date 解析差异。
  const collectedAt = manifest.fetchedAt || "清单未记录";
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>求职岗位清单报告</title>
<style>
:root{--ink:#172033;--muted:#5d6678;--line:#d9e0ea;--surface:#fff;--page:#f4f7fa;--brand:#1f5f8b;--ok:#207b52;--warn:#9a5b00;--danger:#a33838}
*{box-sizing:border-box}body{margin:0;background:var(--page);color:var(--ink);font:14px/1.55 "Segoe UI","Microsoft YaHei",sans-serif}
main,header,footer{max-width:1440px;margin:0 auto;padding:24px}header{padding-top:40px}h1{margin:0 0 8px;font-size:30px}h2{font-size:17px;margin:0 0 12px}.meta{color:var(--muted);margin:0}.layout{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.card,.panel{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:16px;box-shadow:0 1px 2px #1720330d}.card strong{display:block;font-size:26px;line-height:1.2}.card span{color:var(--muted)}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.counts{list-style:none;margin:0;padding:0}.counts li{display:flex;justify-content:space-between;gap:12px;padding:7px 0;border-bottom:1px solid var(--line)}.counts li:last-child{border:0}.more{color:var(--muted)}.table-wrap{overflow:auto;border:1px solid var(--line);border-radius:10px;background:var(--surface)}table{border-collapse:collapse;width:100%;min-width:1180px}th,td{padding:11px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{position:sticky;top:0;background:#eaf1f6;color:#26354a;z-index:1}tbody tr:hover{background:#f7fafc}.outsourcing{background:#fff6f6}.score{font-weight:700;color:var(--brand)}.title span{display:block;color:var(--muted);font-size:12px}.muted{color:var(--muted)}.status{background:#e8f2ec;color:var(--ok);border-radius:999px;padding:2px 8px;font-size:12px}.outsourcing .status{background:#f7e8e8;color:var(--danger)}a{color:var(--brand)}details summary{cursor:pointer;color:var(--brand);white-space:nowrap}details dl{margin:8px 0 0;min-width:260px}dd{margin:0 0 7px}.notice{margin:0 0 12px;color:var(--warn)}footer{color:var(--muted);font-size:12px}@media(max-width:1000px){.layout,.cards{grid-template-columns:repeat(2,1fr)}.grid{grid-template-columns:1fr}}@media print{body{background:#fff}.layout,.cards,.grid{grid-template-columns:1fr}.table-wrap{border:0}th{position:static}}
</style>
</head>
<body>
<header>
<h1>求职岗位清单报告</h1>
<p class="meta">生成时间：${escapeHtml(generatedAt)} · 数据采集：${escapeHtml(collectedAt)} · 数据源：求职 Agent 最新岗位清单</p>
</header>
<div class="layout">
<div class="cards">
<div class="card"><span>岗位总数</span><strong>${manifest.jobs.length}</strong></div>
<div class="card"><span>外包识别</span><strong>${outsourcingCount}</strong></div>
<div class="card"><span>平均匹配分</span><strong>${averageScore}</strong></div>
<div class="card"><span>报告展示</span><strong>${jobs.length}</strong></div>
</div>
</div>
<main>
<div class="grid">${renderCounts("方向分布", countBy(manifest.jobs, (job) => job.direction))}${renderCounts("平台分布", countBy(manifest.jobs, (job) => job.platform))}${renderCounts("投递状态", countBy(manifest.jobs, (job) => job.status))}</div>
${omitted > 0 ? `<p class="notice">清单共 ${manifest.jobs.length} 条，报告只展示分数排序后的前 ${jobs.length} 条（${omitted} 条未渲染）。</p>` : ""}
<div class="table-wrap"><table>
<thead><tr><th>分数</th><th>岗位</th><th>公司</th><th>平台</th><th>薪资</th><th>地区</th><th>经验</th><th>HR活跃</th><th>休息</th><th>状态</th><th>链接</th><th>详情</th></tr></thead>
<tbody>${jobs.map(renderJobRow).join("")}</tbody>
</table></div>
</main>
<footer>由 agentatlas 内置求职 Agent 在写完 Excel 后生成；报告与 Excel 位于同一 out 目录，可离线打开与打印。</footer>
</body></html>`;
}

/** 找最新 Excel 并返回同名 HTML 路径；没有 Excel 时退回固定文件名 */
async function resolveHtmlPath(manifest: JobManifest): Promise<string> {
  const outputDir = dirname(manifest.path);
  let excelName = "";
  let latestTime = Number.NEGATIVE_INFINITY;
  const entries = await fsp.readdir(outputDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !/\.xlsx$/i.test(entry.name)) continue;
    const stat = await fsp.stat(join(outputDir, entry.name)).catch(() => null);
    if (stat && stat.mtimeMs > latestTime) {
      latestTime = stat.mtimeMs;
      excelName = entry.name;
    }
  }
  const htmlName = excelName ? excelName.replace(/\.xlsx$/i, ".html") : FALLBACK_HTML_NAME;
  return join(outputDir, htmlName);
}

/** 生成 HTML 报告；调用方负责在 CLI 成功退出并读到清单 JSON 后调用 */
export async function writeJobHtmlReport(manifest: JobManifest): Promise<string> {
  const path = await resolveHtmlPath(manifest);
  await fsp.writeFile(path, renderDocument(manifest), "utf8");
  return path;
}
