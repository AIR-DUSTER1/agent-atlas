/**
 * ============================================================
 * estate-workbook.test.ts — 房源 Excel 对比清单
 * ============================================================
 * 守住三件事：超过 12 套能生成真实 XLSX、真实 VR 链接成为可点击超链接、
 * 下载读取只认服务端生成的文件名与 UUID 路径。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readEstateExport, writeEstateWorkbook } from "../../src/server/estate-workbook.js";
import { houseExportTool } from "../../src/tools-estate.js";

test("房源候选超过 12 套时生成可下载的 XLSX 对比清单", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentatlas-estate-"));
  const previous = process.env.ESTATE_EXPORT_DIR;
  process.env.ESTATE_EXPORT_DIR = dir;
  try {
    const listings = Array.from({ length: 15 }, (_, index) => ({
      houseId: `10315552${String(index).padStart(4, "0")}`,
      title: `测试小区 · 2室1厅 · ${80 + index}㎡`,
      community: "测试小区",
      layout: "2室1厅",
      area: `${80 + index}㎡`,
      price: `${2200 + index * 100}元/月`,
      address: `测试路 ${index + 1} 号`,
      matchReason: "预算和户型均匹配",
      ...(index === 0 ? {
        hasVr: true,
        vrUrl: "https://realsee.com/vr/tour-10001",
        detailUrl: "https://qd.ke.com/zufang/103155520000.html",
      } : {}),
    }));
    const artifact = await writeEstateWorkbook(listings, {
      mode: "rent",
      city: "青岛",
      query: "左岸风度附近3公里内 两室",
    });
    assert.equal(artifact.count, 15);
    assert.match(artifact.fileName, /^房源对比_青岛_租房_.*\.xlsx$/);
    assert.match(artifact.downloadUrl, /^\/api\/estate\/exports\/[0-9a-f-]{36}$/);
    const stored = await readEstateExport(artifact.downloadUrl.split("/").pop() || "");
    assert.ok(stored);
    assert.equal(stored.fileName, artifact.fileName);
    assert.equal(stored.data.subarray(0, 2).toString("utf8"), "PK");
    const raw = stored.data.toString("utf8");
    assert.match(raw, /租房候选/);
    assert.match(raw, /打开 VR/);
    assert.match(raw, /realsee\.com\/vr\/tour-10001/);
    assert.equal((raw.match(/测试小区/g) ?? []).length >= 15, true);
  } finally {
    if (previous === undefined) delete process.env.ESTATE_EXPORT_DIR;
    else process.env.ESTATE_EXPORT_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("house_export 工具只在超过 12 套时生成结论可用的 Excel 元数据", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentatlas-estate-tool-"));
  const previous = process.env.ESTATE_EXPORT_DIR;
  process.env.ESTATE_EXPORT_DIR = dir;
  try {
    const listings = Array.from({ length: 13 }, (_, index) => ({
      houseId: `10315555${String(index).padStart(4, "0")}`,
      title: `工具导出小区 · 2室1厅 · ${80 + index}㎡`,
      community: "工具导出小区",
      layout: "2室1厅",
      area: `${80 + index}㎡`,
      price: `${2300 + index * 100}元/月`,
      matchReason: "匹配预算与户型",
    }));
    const raw = await houseExportTool.invoke({ mode: "rent", city: "青岛", query: "工具导出", listings });
    const payload = JSON.parse(String(raw));
    assert.equal(payload.action, "export");
    assert.equal(payload.count, 13);
    assert.match(payload.excel.downloadUrl, /^\/api\/estate\/exports\//);
    assert.equal(payload.excel.count, 13);
  } finally {
    if (previous === undefined) delete process.env.ESTATE_EXPORT_DIR;
    else process.env.ESTATE_EXPORT_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("下载读取拒绝非 UUID 路径", async () => {
  assert.equal(await readEstateExport("../secret"), null);
  assert.equal(await readEstateExport("not-a-uuid"), null);
});
