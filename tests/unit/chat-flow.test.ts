/**
 * chat-flow.test.ts — 审批恢复单助手块与长内容约束回归
 * ============================================================
 * 完整回合可经历多次 interrupt/resume，但 UI 只能有一个头像；
 * 审批卡里的长 URL / 命令必须能换行，不能撑破消息容器。
 */
import assert from "node:assert/strict";
import type { AssistantPart, ChatBlock, ToolPart } from "../../src/client/modules/types.js";
import { collectEstateConclusionMedia, collectEstateHouseIds, stripEstateHouseIds } from "../../src/client/modules/conclusion-media.js";
import { DEFAULT_MAP_CONFIG, amapStaticMapUrl, mapTileUrl, projectMapPoint, resolveMapConfig } from "../../src/client/modules/map-provider.js";
import { test } from "node:test";
import { readClientCss, readClientFiles, readClientSource } from "../helpers/client-source.js";
import {
  assistantBlockContaining,
  isContinuationRecord,
  lastAssistantBlock,
  mergeAdjacentAssistantBlocks,
} from "../../src/client/modules/chat-flow.js";

test("continuation 标记与旧审批文案都能识别为恢复轮", () => {
  assert.equal(isContinuationRecord({ continuation: true, user: "任意" }), true);
  assert.equal(isContinuationRecord({ user: "（人工审批：批准 terminal）" }), true);
  assert.equal(isContinuationRecord({ user: "（需求澄清：北京）" }), true);
  assert.equal(isContinuationRecord({ user: "今天北京天气怎么样" }), false);
});

test("旧缓存中的连续助手块合并，并保留最后用量", () => {
  // 这些 fixture 刻意做成「旧缓存里可能出现的残缺形状」，故用 as 收窄到 ChatBlock
  const first = {
    t: "assistant", parts: [{ p: "tool", id: "1" }], _usage: { lastInput: 1 },
  } as unknown as ChatBlock;
  const second = {
    t: "assistant", parts: [{ p: "text", text: "完成" }], _usage: { lastInput: 2 },
  } as unknown as ChatBlock;
  const blocks: ChatBlock[] = [{ t: "user", text: "查天气" }, first, second];
  const merged = mergeAdjacentAssistantBlocks(blocks);
  assert.equal(merged.length, 2);
  assert.equal(merged[1], first);
  const parts = (merged[1] as { parts: Array<{ p: string }> }).parts;
  assert.deepEqual(parts.map((part) => part.p), ["tool", "text"]);
  assert.deepEqual((merged[1] as { _usage?: unknown })._usage, { lastInput: 2 });
});

test("审批 part 能定位所属助手块，用户消息分隔的块不会被误合并", () => {
  const approval = { p: "approval" } as unknown as AssistantPart;
  const first = { t: "assistant", parts: [approval] } as unknown as ChatBlock;
  const blocks: ChatBlock[] = [first, { t: "user", text: "下一问" }, { t: "assistant", parts: [] }];
  assert.equal(assistantBlockContaining(blocks, approval), first);
  assert.equal(lastAssistantBlock(blocks), blocks[2]);
  assert.equal(mergeAdjacentAssistantBlocks(blocks).length, 3);
});

test("前端恢复流复用原助手块，审批内容样式允许任意长串换行", async () => {
  const app = await readClientSource();
  const css = await readClientCss();
  assert.match(app, /export async function runResume\(/);
  assert.match(app, /mountTyping\(ablock\)/);
  assert.match(app, /isContinuationRecord\(rec\)/);
  assert.match(app, /mergeAdjacentAssistantBlocks\(blocks\)/);
  assert.match(css, /\.approval-desc\s*\{[^}]*overflow-wrap:\s*anywhere/s);
  assert.match(css, /\.approval-args\s*\{[^}]*overflow-wrap:\s*anywhere/s);
  assert.match(css, /\.approval-card\s*\{[^}]*overflow:\s*hidden/s);
});

test("审批完成后默认折叠为摘要行，仍可手动展开详情", async () => {
  const app = await readClientSource();
  const css = await readClientCss();
  assert.match(app, /part\.collapsed = true/);
  assert.match(app, /class: "approval-summary"/);
  assert.match(app, /class: "approval-body"/);
  assert.match(app, /part\.collapsed = !part\.collapsed/);
  assert.match(css, /\.approval-card\.collapsed \.approval-body\s*\{\s*display:\s*none/s);
});

test("思考过程使用默认折叠的 details，点击摘要可手动展开", async () => {
  const app = await readClientSource();
  const css = await readClientCss();
  assert.match(app, /case "reasoning": sealStreamingParts\(ablock, \["text"\]\); appendReasoning\(ablock, ev, visible\)/);
  assert.match(app, /export function appendReasoning\(ablock: AssistantBlock, ev: \{ text\?: string; node\?: string \}, visible = true\): void/);
  assert.match(app, /document\.createElement\("details"\)/);
  assert.match(app, /h\("summary", \{ class: "thinking-summary" \}/);
  assert.doesNotMatch(app, /details\.open\s*=\s*true/, "思考内容不能默认展开");
  assert.match(app, /class: "thinking-chevron"/);
  assert.doesNotMatch(app, /thinking-spark|thinking-node/);
  assert.match(app, /refs\.el\.classList\.toggle\("is-thinking", streaming\)/);
  assert.match(app, /refs\.el\.setAttribute\("aria-busy", String\(streaming\)\)/);
  assert.match(app, /details\.addEventListener\("toggle"/);
  assert.match(app, /refs\.metaEl\.textContent = streaming \? "思考中" : ""/);
  assert.match(app, /refs\.metaEl\.classList\.toggle\("hidden", !streaming\)/);
  assert.doesNotMatch(app, /\$\{part\.text\.length\} 字/);
  assert.doesNotMatch(app, /refs\.el instanceof HTMLDetailsElement && refs\.el\.open \? "收起" : "展开"/);
  assert.match(css, /\.thinking-block\s*\{[^}]*border:\s*0[^}]*background:\s*transparent/s);
  assert.match(css, /\.thinking-block\[open\]\s*\{/);
  assert.match(css, /\.thinking-text\s*\{[^}]*white-space:\s*pre-wrap/s);
  assert.match(css, /\.thinking-meta::before\s*\{[^}]*animation:\s*thinkingPulse/s);
  assert.doesNotMatch(css, /\.thinking-spark|\.thinking-node/);
});

test("同批工具超过两个才折叠到 tools，摘要保留工具名且 1–2 个继续平铺", async () => {
  const app = await readClientSource();
  const css = await readClientCss();
  assert.match(app, /export function mountToolCard\(block: AssistantBlock, card: HTMLElement\): void \{\s*blockBodies\.get\(block\)\?\.appendChild\(card\);/s);
  assert.match(app, /const TOOL_GROUP_MIN = 3/);
  assert.match(app, /export function groupToolCallsIfNeeded\(/);
  assert.match(app, /tools\.length < TOOL_GROUP_MIN/);
  assert.match(app, /tool-group-names/);
  assert.match(app, /if \(part\.name === "agent"\) return;/);
  assert.match(app, /if \(part\.name === "tools"\)[\s\S]*?return;/);
  assert.doesNotMatch(app, /tool-drawer|ensureToolDrawer|refreshToolDrawer/);
  assert.match(css, /\.tool-group-summary/);
  assert.match(css, /\.tool-group\[open\]/);
  assert.doesNotMatch(css, /\.tool-drawer|\.drawer-head|\.drawer-items/);
});

test("工具卡按类别展示并保留原始工具名，批量调用内部按类别分区", async () => {
  const app = await readClientFiles(["render/parts.ts", "stream/events.ts"]);
  const presentation = await readClientFiles(["modules/tool-presentation.ts"]);
  const css = await readClientCss();
  assert.match(presentation, /export const TOOL_CATEGORIES/);
  assert.match(presentation, /file-read.*file-write.*file-edit.*image-read.*command/s);
  assert.match(app, /describeTool\(part\)/);
  assert.match(app, /card\.dataset\.toolCategory = presentation\.category\.id/);
  assert.match(app, /tool-category-section/);
  assert.match(app, /refreshToolGroup/);
  assert.match(app, /presentation\.rawName/);
  assert.match(css, /\.tool-category-section\s*\{/);
  assert.match(css, /\.tool-card\[data-tool-category="command"\]/);
  assert.doesNotMatch(app, /TOOL_ICONS/);
});
test("房产地图与户型图进入最终结论表格，工具组保持折叠", async () => {
  const app = await readClientFiles([
    "modules/conclusion-media.ts", "render/conclusion-media.ts", "render/parts.ts",
    "stream/events.ts", "render/messages.ts", "views/estate.ts",
  ]);
  const css = await readClientCss();
  assert.match(app, /collectEstateConclusionMedia/);
  assert.match(app, /refreshConclusionMedia/);
  assert.match(app, /sanitizeEstateConclusionText/);
  assert.match(app, /conclusion-table/);
  assert.match(app, /case "done":[\s\S]*refreshConclusionMedia/);
  assert.match(app, /h\("details", \{ class: "tool-group" \}/);
  assert.doesNotMatch(app, /estate-rich|estate-map-embed|estate-material-grid|estate-house-thumb/);
  assert.doesNotMatch(css, /\.estate-map-embed|\.estate-material-grid|\.estate-house-thumb/);
  assert.match(css, /\.conclusion-media\s*\{/);
  assert.match(css, /\.conclusion-table\s*\{/);
});

test("会话项右侧操作按钮共享横向操作区，导出与删除不会重叠", async () => {
  const app = await readClientSource();
  const css = await readClientCss();
  assert.match(app, /const exportButton = h\("button",/);
  assert.match(app, /const deleteButton = h\("button",/);
  assert.match(app, /h\("div", \{ class: "s-actions" \}, exportButton, deleteButton\)/);
  assert.match(css, /\.s-actions\s*\{[^}]*display:\s*flex[^}]*gap:\s*2px/s);
  assert.match(css, /\.session-item \.s-title\s*\{[^}]*padding-right:\s*56px/s);
  assert.match(css, /@media \(hover: none\), \(pointer: coarse\)/);
  assert.doesNotMatch(css, /\.s-del\s*\{[^}]*position:\s*absolute/s, "按钮本体不能各自绝对定位");
});

test("工具/节点边界立即封口流式内容，ai_message 兜底不再留下光标", async () => {
  const app = await readClientSource();
  assert.match(app, /function sealStreamingParts\(/);
  assert.match(app, /export function upsertToolCall\([\s\S]*?sealStreamingParts\(ablock\)/);
  assert.match(app, /export function addNodeChip\([\s\S]*?sealStreamingParts\(ablock\)/);
  assert.match(app, /export function addInterrupt\([\s\S]*?sealStreamingParts\(ablock\)/);
  assert.match(app, /p: "text", text: content, streaming: false/);
});

test("上下文用量忽略 review 等内部调用，并按每轮峰值恢复容量与缓存", async () => {
  const app = await readClientSource();
  assert.match(app, /if \(!sid\) return/);
  assert.match(app, /if \(ev\.internal\) return/);
  assert.match(app, /context >= u\.contextTokens/);
  assert.match(app, /const context = ev\.inputTokens;/);
  assert.match(app, /const hadLocal = arr\.length > 0/);
  assert.match(app, /applyUsage\(ev as never, undefined, s\.id\)/);
  assert.match(app, /delete state\.usage\[sid\]/);
});

test("导出会话使用带认证的 Blob 下载，不打开 Electron 空白新窗口", async () => {
  const app = await readClientSource();
  assert.match(app, /async function exportSession\(session: Session\)/);
  assert.match(app, /authFetch\(`\/api\/sessions\/\$\{session\.id\}\/export`\)/);
  assert.match(app, /URL\.createObjectURL\(blob\)/);
  assert.match(app, /anchor\.download = exportFileName\(session\)/);
  assert.doesNotMatch(app, /window\.open\(`\/api\/sessions\/\$\{session\.id\}\/export`/);
});

/**
 * 澄清卡回归守门：早期版本的澄清卡直接往 .approval-card 里塞标题，
 * 既没有 .approval-body 也没有自带内边距，标题会紧贴左上角边框。
 * 这里用「头部有 padding」+「渲染层不再直接拼 DOM」两条断言挡住回退。
 */
test("澄清卡自带内边距，且渲染逻辑已迁到独立模块", async () => {
  const css = await readClientCss();
  const card = await readClientFiles(["render/clarify-card.ts"]);
  const parts = await readClientFiles(["render/parts.ts"]);
  assert.match(css, /\.clarify-head\s*\{[^}]*padding:\s*11px 13px/s, "澄清卡头部必须有内边距");
  assert.match(css, /\.clarify-list\s*\{[^}]*padding:\s*\d+px 13px/s, "题目列表必须有左右内边距");
  assert.match(css, /\.clarify-foot\s*\{[^}]*padding:\s*12px 13px/s, "底部操作区必须有内边距");
  // 多题逐答与新载荷归一化必须在 clarify-card / clarify 模块里，parts.ts 只做转发
  assert.match(card, /normalizeClarify\(part\.req\)/);
  assert.match(card, /clarify-progress/);
  assert.match(card, /clarify-submit/);
  assert.match(parts, /renderClarificationCardImpl\(part, el\)/);
});

test("澄清卡支持多题：提交按钮在全答完前禁用", async () => {
  const card = await readClientFiles(["render/clarify-card.ts"]);
  const clarify = await readClientFiles(["modules/clarify.ts"]);
  assert.match(card, /submit\.disabled = !ready/);
  assert.match(card, /answers\[questions\[0\]!\.id\]/, "单题按首题作答判断");
  // 单题点选即提交：保持旧交互，少一次点击
  assert.match(card, /if \(!multi\) \{/);
  // 多题提交必须带题面否则模型分不清答案归属
  assert.match(clarify, /lines\.push\(`\$\{question\.question\}：\$\{text\}`\)/);
  assert.match(clarify, /MAX_SUBMISSION_CHARS/);
});

const DETAIL_MAP = "https://www.openstreetmap.org/export/embed.html?bbox=1,2,3,4&marker=36.1,120.1";
const MAP_MULTI = "https://www.openstreetmap.org/export/embed.html?bbox=1,2,3,4&layer=mapnik";
const IMAGE_ONE = "https://ke-image.ljcdn.com/frame/a.jpg";
const IMAGE_TWO = "https://ke-image.ljcdn.com/frame/b.webp";

function estateToolPart(id: string, name: string, payload: unknown): ToolPart {
  return {
    p: "tool", id, name, argsText: "{}",
    result: { content: JSON.stringify(payload), isError: false },
  };
}

test("结论附件聚合详情地图、点位与多张户型图", () => {
  const parts: AssistantPart[] = [
    estateToolPart("detail", "house_lookup", {
      action: "detail", houseId: "10001", city: "青岛",
      data: JSON.stringify({ 基础信息: {
        小区名: "测试花园", 房型: "2室1厅", 出租面积: "90㎡", 租赁价格: "2400元/月",
        房源所属楼层: "中楼层", 出租朝向: "南", 装修: "精装",
      } }),
      location: {
        label: "测试花园", address: "测试路 1 号", lat: 36.1, lng: 120.1,
        precision: "community", embedUrl: DETAIL_MAP,
        links: { amap: "https://uri.amap.com/marker?position=120.1,36.1" },
      },
      images: [IMAGE_ONE],
    }),
    estateToolPart("map", "house_map", {
      action: "map", embedUrl: MAP_MULTI,
      points: [
        { name: "测试花园", address: "测试路 1 号", lat: 36.1, lng: 120.1, links: {} },
        { name: "第二花园", address: "测试路 2 号", lat: 36.2, lng: 120.2, source: "nominatim", links: {} },
      ],
    }),
    estateToolPart("material", "house_lookup", {
      action: "material", houseId: "10001", images: [IMAGE_ONE, IMAGE_TWO],
    }),
  ];
  const media = collectEstateConclusionMedia(parts);
  assert.equal(media.mapEmbedUrl, DETAIL_MAP);
  assert.equal(media.mapTitle, "房源所在小区");
  assert.equal(media.points.length, 2);
  assert.equal(media.points[0]?.name, "测试花园");
  assert.equal(media.points[1]?.name, "第二花园");
  assert.deepEqual(media.images.map((image) => image.src), [IMAGE_ONE, IMAGE_TWO]);
  assert.equal(media.properties.length, 1);
  assert.equal(media.properties[0]?.title, "测试花园 · 2室1厅 · 90㎡");
  assert.equal(media.properties[0]?.rent, "2400元/月");
  assert.deepEqual(media.properties[0]?.images.map((image) => image.src), [IMAGE_ONE, IMAGE_TWO]);
  assert.equal(media.properties[0]?.location?.name, "测试花园");
});

test("无房产媒体时不生成结论附件", () => {
  const media = collectEstateConclusionMedia([
    estateToolPart("search", "house_search", { action: "search", listings: [{ title: "房源" }] }),
  ]);
  assert.equal(media.mapEmbedUrl, "");
  assert.deepEqual(media.points, []);
  assert.deepEqual(media.images, []);
});

test("最终文字按真实 houseId 脱敏，表格匹配仍保留内部关系", () => {
  const parts: AssistantPart[] = [
    estateToolPart("detail", "house_lookup", { action: "detail", houseId: "103155273255", data: "{}" }),
  ];
  const ids = collectEstateHouseIds(parts);
  assert.deepEqual(ids, ["103155273255"]);
  const visible = stripEstateHouseIds("首推左岸风度 103155273255 ——2室2厅，ID：103155273255。", ids);
  assert.doesNotMatch(visible, /103155273255/);
  assert.match(visible, /首推左岸风度/);
});

test("地图配置按提供方生成原生瓦片，不依赖 iframe", () => {
  const tencent = resolveMapConfig({
    ...DEFAULT_MAP_CONFIG,
    provider: "tencent",
    label: "腾讯地图",
    tileUrl: "https://rt{s}.map.gtimg.com/tile?z={z}&x={x}&y={y}&styleid=3&version=1",
    subdomains: ["0", "1", "2", "3"],
    coordinateSystem: "gcj02",
    yAxis: "tms",
  });
  const point = projectMapPoint(36.117778, 120.414538, tencent);
  const tileX = Math.floor(point.worldX / tencent.tileSize);
  const tileY = Math.floor(point.worldY / tencent.tileSize);
  const tencentUrl = mapTileUrl(tileX, tileY, tencent);
  assert.match(tencentUrl, /rt[0-3]\.map\.gtimg\.com\/tile/);
  assert.match(tencentUrl, new RegExp(`y=${2 ** tencent.zoom - 1 - tileY}(?:&|$)`));

  const baidu = resolveMapConfig({
    ...DEFAULT_MAP_CONFIG,
    provider: "baidu",
    label: "百度地图",
    tileUrl: "https://maponline{s}.bdimg.com/tile/?qt=vtile&x={x}&y={y}&z={z}&styles=pl&scaler=1",
    subdomains: ["0", "1", "2", "3"],
    coordinateSystem: "bd09",
    projection: "baidu",
    yAxis: "xyz",
  });
  const baiduUrl = mapTileUrl(3272, 1047, baidu);
  assert.match(baiduUrl, /maponline[0-3]\.bdimg\.com\/tile/);
  assert.match(baiduUrl, /x=3272&y=1047/);

  const osm = resolveMapConfig({ ...DEFAULT_MAP_CONFIG, provider: "osm", tileUrl: "https://tile.openstreetmap.org/{z}/{x}/{y}.png", subdomains: [], coordinateSystem: "wgs84" });
  assert.equal(mapTileUrl(1, 2, osm), "https://tile.openstreetmap.org/14/1/2.png");

  const amapUrl = amapStaticMapUrl(36.123456, 120.123456, { ...DEFAULT_MAP_CONFIG, amapStaticMapAvailable: true }, true);
  assert.match(amapUrl || "", /^\/api\/map\/static\?/);
  assert.match(amapUrl || "", /variant=compact/);
  assert.equal(amapStaticMapUrl(36.123456, 120.123456, osm, false), null);
});

test("历史原始 detail/material 结果也能按房源匹配表格、户型图和位置", () => {
  const detailRaw = [
    "<参考数据>",
    "<103155273255>",
    '{"基础信息":{"小区名":"左岸风度","房型":"2室2厅","出租面积":"90㎡","租赁价格":"2400元/月","楼栋经纬度":"出于业主隐私保护，不方便透露具体的楼栋经纬度"}}',
    '{"小区信息":{"小区名称":"左岸风度","小区别名":"劲松七路237号,左岸丰渡","小区经纬度":"120.421197,36.123971"}}',
    "</103155273255>",
  ].join("\n");
  const materialRaw = '{"103155273255":{"房源图片":{"户型图片":"' + IMAGE_ONE + '"}}}';
  const media = collectEstateConclusionMedia([
    estateToolPart("raw-detail", "house_lookup", { action: "detail", data: detailRaw }),
    estateToolPart("raw-material", "house_lookup", { action: "material", data: materialRaw }),
  ]);
  assert.equal(media.properties.length, 1);
  assert.equal(media.properties[0]?.houseId, "103155273255");
  assert.equal(media.properties[0]?.title, "左岸风度 · 2室2厅 · 90㎡");
  assert.deepEqual(media.properties[0]?.images.map((image) => image.src), [IMAGE_ONE]);
  assert.equal(media.properties[0]?.location?.lat, 36.123971);
  assert.equal(media.properties[0]?.location?.lng, 120.421197);
});
