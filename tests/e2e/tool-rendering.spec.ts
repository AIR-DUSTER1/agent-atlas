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
    events.handleEvent({ type: "token", text: "结论：测试花园位置与户型图如下。", node: "agent" }, block, null);
    const beforeDone = host.querySelectorAll(".conclusion-media").length;
    events.handleEvent({ type: "done" }, block, null);
    const conclusion = host.querySelector(".conclusion-media");
    const md = host.querySelector(".md");
    const iframe = conclusion?.querySelector(".conclusion-map iframe");
    const img = conclusion?.querySelector(".conclusion-images img");
    const node = conclusion && md ? md.compareDocumentPosition(conclusion) & Node.DOCUMENT_POSITION_FOLLOWING : 0;
    const toolMedia = host.querySelectorAll(".tool-card iframe, .tool-card img, .tool-card .conclusion-images").length;
    const openToolCards = [...host.querySelectorAll(".tool-card")].filter((card) => card.classList.contains("open")).length;
    const answer = {
      hasConclusion: Boolean(conclusion),
      beforeDone,
      isAfterText: Boolean(node),
      iframeSrc: iframe?.getAttribute("src") || "",
      imageSrc: img?.getAttribute("src") || "",
      toolMedia,
      openToolCards,
    };
    host.remove();
    clientState.blockBodies.delete(block);
    return answer;
  });

  expect(result.beforeDone).toBe(0);
  expect(result.hasConclusion).toBe(true);
  expect(result.isAfterText).toBe(true);
  expect(result.iframeSrc).toContain("openstreetmap.org/export/embed.html");
  expect(result.iframeSrc).toContain("marker=36.123456,120.123456");
  expect(result.imageSrc).toMatch(/^data:image\/svg\+xml;base64,/);
  expect(result.toolMedia).toBe(0);
  expect(result.openToolCards).toBe(0);
});
