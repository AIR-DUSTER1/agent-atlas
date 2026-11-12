/** tool-rendering.spec.ts — 批量工具按类别分区的真实 DOM 回归 */
import { expect, test } from "@playwright/test";
import { login } from "./helpers.js";

test("同批三个工具按文件读取、图片读取、运行命令分区并保留原始工具名", async ({ page }) => {
  await login(page);
  const result = await page.evaluate(async () => {
    const load = (specifier: string): Promise<any> => import(specifier);
    const [{ mountPart, groupToolCallsIfNeeded, updateToolCard }, clientState] = await Promise.all([
      load("/render/parts.js"),
      load("/core/state.js"),
    ]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const block = { t: "assistant", parts: [] } as any;
    clientState.blockBodies.set(block, host);
    const calls = [
      { name: "read_file", args: { path: "README.md" } },
      { name: "read_image", args: { path: "docs/preview.png" } },
      { name: "terminal", args: { command: "npm test" } },
    ];
    for (const [index, call] of calls.entries()) {
      const part = {
        p: "tool", id: `category-${index}`, name: call.name,
        argsText: JSON.stringify(call.args), result: null,
      };
      block.parts.push(part);
      mountPart(block, part);
    }
    const node = { p: "node", name: "tools" };
    block.parts.push(node);
    const group = groupToolCallsIfNeeded(block, host, node);
    const sections = [...(group?.querySelectorAll("[data-category-section]") ?? [])]
      .map((section: Element) => ({
        category: (section as HTMLElement).dataset.categorySection,
        count: section.querySelectorAll(".tool-card").length,
      }));
    const names = [...(group?.querySelectorAll(".tool-name") ?? [])].map((el) => el.textContent);
    const richPart = block.parts[1];
    const richCard = clientState.partEls.get(richPart)?.el;
    if (richCard) {
      richCard.classList.add("estate-rich");
      updateToolCard(richPart);
    }
    const richOpened = group instanceof HTMLDetailsElement && group.open;    const summary = group?.querySelector(".tool-group-names")?.textContent ?? "";
    host.remove();
    clientState.blockBodies.delete(block);
    return { exists: Boolean(group), sections, names, summary, richOpened };
  });

  expect(result.exists).toBe(true);
  expect(result.sections).toEqual([
    { category: "file-read", count: 1 },
    { category: "image-read", count: 1 },
    { category: "command", count: 1 },
  ]);
  expect(result.names).toEqual(["read_file", "read_image", "terminal"]);
  expect(result.summary).toContain("文件读取 ×1");
  expect(result.summary).toContain("读取图片 ×1");
  expect(result.summary).toContain("运行命令 ×1");
  expect(result.summary).toContain("read_file");
  expect(result.summary).toContain("read_image");
  expect(result.summary).toContain("terminal");
  expect(result.richOpened).toBe(true);
});

test("房源详情经纬度与 material 图片直接渲染为地图和图片网格", async ({ page }) => {
  await login(page);
  const result = await page.evaluate(async () => {
    const load = (specifier: string): Promise<any> => import(specifier);
    const [{ mountPart, updateToolCard }, clientState] = await Promise.all([
      load("/render/parts.js"),
      load("/core/state.js"),
    ]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const block = { t: "assistant", parts: [] } as any;
    clientState.blockBodies.set(block, host);
    const detail = {
      action: "detail",
      houseId: "10001",
      city: "青岛",
      location: {
        label: "测试花园",
        address: "测试路 1 号",
        lat: 36.123456,
        lng: 120.123456,
        source: "beike",
        precision: "community",
        embedUrl: "https://www.openstreetmap.org/export/embed.html?bbox=120.111456,36.111456,120.135456,36.135456&layer=mapnik&marker=36.123456,120.123456",
        links: { amap: "https://uri.amap.com/marker?position=120.123456,36.123456&name=test" },
      },
      presentation: { map: true, images: 0 },
    };
    const image = "data:image/svg+xml;base64," + btoa("<svg xmlns='http://www.w3.org/2000/svg' width='320' height='220'><rect width='320' height='220' fill='#eee'/><text x='20' y='40'>Floor plan</text></svg>");
    const material = {
      action: "material",
      houseId: "10001",
      images: [image],
      count: 1,
      presentation: { images: 1 },
    };
    const parts = [detail, material].map((payload, index) => ({
      p: "tool", id: `estate-render-${index}`, name: "house_lookup", argsText: "{}",
      result: { content: JSON.stringify(payload), isError: false },
    }));
    for (const part of parts) {
      block.parts.push(part);
      mountPart(block, part);
      updateToolCard(part);
    }
    const detailCard = clientState.partEls.get(parts[0])?.el;
    const materialCard = clientState.partEls.get(parts[1])?.el;
    const iframe = detailCard?.querySelector(".estate-map-embed iframe");
    const img = materialCard?.querySelector(".estate-material-grid img");
    const answer = {
      iframeSrc: iframe?.getAttribute("src") || "",
      imageSrc: img?.getAttribute("src") || "",
      detailRich: detailCard?.classList.contains("estate-rich") || false,
      materialRich: materialCard?.classList.contains("estate-rich") || false,
    };
    host.remove();
    clientState.blockBodies.delete(block);
    return answer;
  });

  expect(result.detailRich).toBe(true);
  expect(result.materialRich).toBe(true);
  expect(result.iframeSrc).toContain("openstreetmap.org/export/embed.html");
  expect(result.iframeSrc).toContain("marker=36.123456,120.123456");
  expect(result.imageSrc).toMatch(/^data:image\/svg\+xml;base64,/);
});
