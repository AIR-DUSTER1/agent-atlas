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
    const groupOpened = group instanceof HTMLDetailsElement && group.open;
    const summary = group?.querySelector(".tool-group-names")?.textContent ?? "";
    host.remove();
    clientState.blockBodies.delete(block);
    return { exists: Boolean(group), sections, names, summary, groupOpened };
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
  expect(result.groupOpened).toBe(false);
});

test("房产工具每次调用保持独立卡片，不再嵌套同名房产查询分组", async ({ page }) => {
  await login(page);
  const result = await page.evaluate(async () => {
    const load = (specifier: string): Promise<any> => import(specifier);
    const [{ mountPart, groupToolCallsIfNeeded }, clientState] = await Promise.all([
      load("/render/parts.js"),
      load("/core/state.js"),
    ]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const block = { t: "assistant", parts: [] } as any;
    clientState.blockBodies.set(block, host);
    for (const [index, action] of ["detail", "detail", "material"].entries()) {
      const part = {
        p: "tool", id: `estate-independent-${index}`, name: "house_lookup",
        argsText: JSON.stringify({ action, city: "青岛", houseId: String(100000000000 + index) }),
        result: { content: "{}", isError: false },
      };
      block.parts.push(part);
      mountPart(block, part);
    }
    const node = { p: "node", name: "tools" };
    block.parts.push(node);
    const group = groupToolCallsIfNeeded(block, host, node);
    const answer = {
      grouped: Boolean(group),
      groups: host.querySelectorAll(".tool-group").length,
      cards: host.querySelectorAll(".tool-card").length,
      categories: [...host.querySelectorAll(".tool-card")].map((card) => (card as HTMLElement).dataset.toolCategory),
    };
    host.remove();
    clientState.blockBodies.delete(block);
    return answer;
  });

  expect(result.grouped).toBe(false);
  expect(result.groups).toBe(0);
  expect(result.cards).toBe(3);
  expect(result.categories).toEqual(["estate", "estate", "estate"]);
});

test("agent 与 tools 节点不显示空泛徽章，工具卡直接保留原始工具名", async ({ page }) => {
  await login(page);
  const result = await page.evaluate(async () => {
    const load = (specifier: string): Promise<any> => import(specifier);
    const [{ mountPart, updateToolCard }, clientState, events] = await Promise.all([
      load("/render/parts.js"),
      load("/core/state.js"),
      load("/stream/events.js"),
    ]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const block = { t: "assistant", parts: [] } as any;
    clientState.blockBodies.set(block, host);
    const tool = {
      p: "tool", id: "named-tool", name: "house_lookup",
      argsText: JSON.stringify({ community: "左岸风度" }), result: null,
    };
    block.parts.push(tool);
    mountPart(block, tool);
    updateToolCard(tool);
    events.addNodeChip(block, "agent", false);
    events.addNodeChip(block, "tools", false);
    const answer = {
      nodeChips: [...host.querySelectorAll(".node-chip")].map((el) => el.textContent),
      toolName: host.querySelector(".tool-name")?.textContent || "",
    };
    host.remove();
    clientState.blockBodies.delete(block);
    return answer;
  });

  expect(result.nodeChips).toEqual([]);
  expect(result.toolName).toBe("house_lookup");
});

test("思考过程流式阶段显示思考中状态，完成后隐藏并解除 busy", async ({ page }) => {
  await login(page);
  const result = await page.evaluate(async () => {
    const load = (specifier: string): Promise<any> => import(specifier);
    const [{ mountPart, updateThinkingPart }, clientState] = await Promise.all([
      load("/render/parts.js"),
      load("/core/state.js"),
    ]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const block = { t: "assistant", parts: [] } as any;
    clientState.blockBodies.set(block, host);
    const part = { p: "thinking", node: "agent", text: "正在核对房源。", streaming: true };
    block.parts.push(part);
    mountPart(block, part);
    const details = host.querySelector(".thinking-block")!;
    const meta = host.querySelector(".thinking-meta")!;
    const during = {
      text: meta.textContent || "",
      hidden: meta.classList.contains("hidden"),
      busy: details.getAttribute("aria-busy"),
      stateClass: details.classList.contains("is-thinking"),
      role: meta.getAttribute("role"),
    };
    part.streaming = false;
    updateThinkingPart(part);
    const after = {
      hidden: meta.classList.contains("hidden"),
      busy: details.getAttribute("aria-busy"),
      stateClass: details.classList.contains("is-thinking"),
    };
    host.remove();
    clientState.blockBodies.delete(block);
    return { during, after };
  });

  expect(result.during).toEqual({
    text: "思考中", hidden: false, busy: "true", stateClass: true, role: "status",
  });
  expect(result.after).toEqual({ hidden: true, busy: "false", stateClass: false });
});

test("房源结论直接展示地图与户型图，工具卡不再承载媒体", async ({ page }) => {
  await login(page);
  const result = await page.evaluate(async () => {
    const load = (specifier: string): Promise<any> => import(specifier);
    const [{ mountPart, updateToolCard }, clientState, events] = await Promise.all([
      load("/render/parts.js"),
      load("/core/state.js"),
      load("/stream/events.js"),
    ]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const block = { t: "assistant", parts: [] } as any;
    clientState.blockBodies.set(block, host);
    const detail = {
      action: "detail",
      houseId: "103155273255",
      city: "青岛",
      data: JSON.stringify({ 基础信息: {
        小区名: "测试花园", 房型: "2室1厅", 出租面积: "90㎡", 租赁价格: "2400元/月",
        房源所属楼层: "中楼层", 出租朝向: "南", 装修: "精装",
      } }),
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
      houseId: "103155273255",
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
    events.handleEvent({ type: "token", text: "结论：测试花园 103155273255 位置与户型图如下。", node: "agent" }, block, null);
    const beforeReview = host.querySelectorAll(".conclusion-media").length;
    events.handleEvent({ type: "reasoning", text: "复核结论与附件", node: "review" }, block, null);
    const duringReview = host.querySelectorAll(".conclusion-media").length;
    events.handleEvent({ type: "done" }, block, null);
    const conclusion = host.querySelector(".conclusion-media");
    const md = host.querySelector(".md");
    const map = conclusion?.querySelector<HTMLElement>(".conclusion-property-map");
    const mapTile = conclusion?.querySelector(".conclusion-map-tile");
    const img = conclusion?.querySelector(".conclusion-table-image img");
    const table = conclusion?.querySelector(".conclusion-table");
    const rows = table?.querySelectorAll("tbody tr").length || 0;
    const node = conclusion && md ? md.compareDocumentPosition(conclusion) & Node.DOCUMENT_POSITION_FOLLOWING : 0;
    const toolMedia = host.querySelectorAll(".tool-card iframe, .tool-card img, .tool-card .conclusion-images, .tool-card .conclusion-table").length;
    const openToolCards = [...host.querySelectorAll(".tool-card")].filter((card) => card.classList.contains("open")).length;
    const answer = {
      hasConclusion: Boolean(conclusion),
      beforeReview,
      duringReview,
      isAfterText: Boolean(node),
      mapLat: map?.dataset.mapLat || "",
      mapLng: map?.dataset.mapLng || "",
      mapTiles: conclusion?.querySelectorAll(".conclusion-map-tile").length || 0,
      mapMarker: Boolean(conclusion?.querySelector(".conclusion-map-marker")),
      mapTileSrc: mapTile?.getAttribute("src") || "",
      imageSrc: img?.getAttribute("src") || "",
      tableText: table?.textContent || "",
      rows,
      visibleText: md?.textContent || "",
      toolMedia,
      openToolCards,
    };
    host.remove();
    clientState.blockBodies.delete(block);
    return answer;
  });

  expect(result.beforeReview).toBe(0);
  expect(result.duringReview).toBe(1);
  expect(result.hasConclusion).toBe(true);
  expect(result.isAfterText).toBe(true);
  expect(result.mapLat).toBe("36.123456");
  expect(result.mapLng).toBe("120.123456");
  expect(result.mapTiles).toBeGreaterThanOrEqual(9);
  expect(result.mapMarker).toBe(true);
  expect(result.mapTileSrc).toContain("is.autonavi.com/appmaptile?style=8");
  expect(result.imageSrc).toMatch(/^data:image\/svg\+xml;base64,/);
  expect(result.rows).toBe(1);
  expect(result.tableText).toContain("测试花园 · 2室1厅 · 90㎡");
  expect(result.tableText).toContain("2400元/月");
  expect(result.tableText).toContain("36.123456, 120.123456");
  expect(result.visibleText).not.toContain("103155273255");
  expect(result.toolMedia).toBe(0);
  expect(result.openToolCards).toBe(0);
});

test("切换地图配置后使用各提供方原生瓦片而不是 iframe", async ({ page }) => {
  await login(page);
  const result = await page.evaluate(async () => {
    const load = (specifier: string): Promise<any> => import(specifier);
    const [{ mountPart }, clientState, events, mapProvider] = await Promise.all([
      load("/render/parts.js"),
      load("/core/state.js"),
      load("/stream/events.js"),
      load("/modules/map-provider.js"),
    ]);
    const appState = clientState.state;
    const previousConfig = appState.config;
    const baseConfig = previousConfig || { mock: true, model: "mock", contextWindow: null, providers: [], demos: [] };
    const detail = {
      action: "detail",
      houseId: "103155273255",
      city: "青岛",
      data: JSON.stringify({ 基础信息: { 小区名: "测试花园", 房型: "2室1厅", 出租面积: "90㎡", 租赁价格: "2400元/月" } }),
      location: { label: "测试花园", address: "测试路 1 号", lat: 36.123456, lng: 120.123456, source: "beike", precision: "community" },
    };
    const renderWith = (map: any): { url: string; provider: string; configuredProvider: string; iframe: number } => {
      appState.config = { ...baseConfig, map };
      const host = document.createElement("div");
      document.body.appendChild(host);
      const block = { t: "assistant", parts: [] } as any;
      clientState.blockBodies.set(block, host);
      const part = {
        p: "tool", id: "map-provider-switch-" + map.provider, name: "house_lookup", argsText: "{}",
        result: { content: JSON.stringify(detail), isError: false },
      };
      block.parts.push(part);
      mountPart(block, part);
      events.handleEvent({ type: "token", text: "结论：地图提供方切换验证。", node: "agent" }, block, null);
      events.handleEvent({ type: "done" }, block, null);
      const mapEl = host.querySelector<HTMLElement>(".conclusion-property-map");
      const tile = host.querySelector<HTMLImageElement>(".conclusion-map-tile");
      const answer = {
        url: tile?.src || "",
        provider: mapEl?.dataset.mapProvider || "",
        configuredProvider: appState.config?.map?.provider || "",
        iframe: host.querySelectorAll("iframe").length,
      };
      host.remove();
      clientState.blockBodies.delete(block);
      return answer;
    };
    const tencent = renderWith({
      ...mapProvider.DEFAULT_MAP_CONFIG,
      provider: "tencent", label: "腾讯地图",
      tileUrl: "https://rt{s}.map.gtimg.com/tile?z={z}&x={x}&y={y}&styleid=3&version=1",
      subdomains: ["0", "1", "2", "3"], coordinateSystem: "gcj02", yAxis: "tms",
    });
    const baidu = renderWith({
      ...mapProvider.DEFAULT_MAP_CONFIG,
      provider: "baidu", label: "百度地图",
      tileUrl: "https://maponline{s}.bdimg.com/tile/?qt=vtile&x={x}&y={y}&z={z}&styles=pl&scaler=1",
      subdomains: ["0", "1", "2", "3"], coordinateSystem: "bd09", projection: "baidu",
    });
    appState.config = previousConfig;
    return { tencent, baidu };
  });

  expect(result.tencent.configuredProvider).toBe("tencent");
  expect(result.tencent.provider).toBe("tencent");
  expect(result.tencent.url).toContain("map.gtimg.com/tile");
  expect(result.tencent.iframe).toBe(0);
  expect(result.baidu.provider).toBe("baidu");
  expect(result.baidu.url).toContain("bdimg.com/tile");
  expect(result.baidu.iframe).toBe(0);
});
