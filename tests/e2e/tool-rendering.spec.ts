/**
 * tool-rendering.spec.ts — 工具卡 / 工具组 / 结论媒体的真实 DOM 回归
 * ============================================================
 * M4 4.6 基线固化：所有用例都**只走真实 UI**（点 Agent 卡 → 输入 → 等服务端
 * mock 流渲染）。不再 import("/render/parts.js") 或直接写 clientState.blockBodies
 * ——那种写法把测试绑死在 1:1 过渡树的内部函数上，4.6 迁移渲染层时会整批失效。
 * 需要特定事件序列的场景由服务端 mock 提供（见 src/server/mock.ts 的
 * batch-tools 等 scenario）。
 */
import { expect, test } from "@playwright/test";
import { createChat, login } from "./helpers.js";

/** 用给定消息发起一轮对话并等到助手回复结束（工具卡已落定）。 */
async function runTurn(page: import("@playwright/test").Page, message: string, doneText: string): Promise<void> {
  await page.locator("#input").fill(message);
  await page.locator("#send-btn").click();
  await expect(page.locator(".msg-assistant").last()).toContainText(doneText, { timeout: 25_000 });
  await expect(page.locator("#stop-btn")).toBeHidden();
}

test("同批三个工具按文件读取、图片读取、运行命令分区并保留原始工具名", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await login(page);
  await createChat(page);
  await runTurn(page, "批量工具演示", "各自归到自己的分区");

  const group = page.locator("#messages .tool-group");
  await expect(group).toHaveCount(1);
  // 工具组默认折叠：执行轨迹不占屏，但摘要必须先给出分类与原始工具名
  await expect(group).not.toHaveAttribute("open", "");
  await expect(group.locator(".tool-group-title")).toHaveText("工具调用");
  await expect(group.locator(".tool-group-names")).toContainText("文件读取 ×1");
  await expect(group.locator(".tool-group-names")).toContainText("读取图片 ×1");
  await expect(group.locator(".tool-group-names")).toContainText("运行命令 ×1");
  await expect(group.locator(".tool-group-names")).toContainText("read_file");
  await expect(group.locator(".tool-group-names")).toContainText("read_image");
  await expect(group.locator(".tool-group-names")).toContainText("terminal");

  // 展开后：三个类别分区各一张卡，且卡上保留原始工具名
  await group.locator(".tool-group-summary").click();
  await expect(group).toHaveAttribute("open", "");
  const sections = group.locator("[data-category-section]");
  await expect(sections).toHaveCount(3);
  await expect(sections.nth(0)).toHaveAttribute("data-category-section", "file-read");
  await expect(sections.nth(1)).toHaveAttribute("data-category-section", "image-read");
  await expect(sections.nth(2)).toHaveAttribute("data-category-section", "command");
  await expect(group.locator(".tool-card")).toHaveCount(3);
  expect(await group.locator(".tool-name").allTextContents()).toEqual(["read_file", "read_image", "terminal"]);
  expect(pageErrors).toEqual([]);
});

test("同类工具连发折叠为单层「连续工具调用」，组内每次调用仍可独立展开", async ({ page }) => {
  await login(page);
  await createChat(page);
  // same-tools 场景：同一工具连发四次（同类 → 组标题为「连续工具调用」）
  await runTurn(page, "同类工具演示", "折叠的工具组");

  const group = page.locator("#messages .tool-group").first();
  await expect(group).toHaveCount(1);
  await expect(group).not.toHaveAttribute("open", "");
  await expect(group.locator(".tool-group-title")).toHaveText("连续工具调用");
  await expect(group.locator(".tool-group-names")).toContainText("house_lookup ×4");
  await expect(group.locator(".tool-group-count")).toContainText("次调用");

  // 单类别时类别标题行不显示（避免与组标题重复）
  const heading = group.locator(".tool-category-heading").first();
  if (await heading.count()) await expect(heading).toBeHidden();

  await group.locator(".tool-group-summary").click();
  await expect(group).toHaveAttribute("open", "");
  const cards = group.locator(".tool-card");
  await expect(cards).toHaveCount(4);
  expect(await cards.evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.toolCategory))).toEqual(
    ["estate", "estate", "estate", "estate"],
  );

  // 每次调用仍可独立展开：点第一张卡的头部
  const firstHead = cards.first().locator(".tool-head");
  await expect(firstHead).toHaveAttribute("aria-expanded", "false");
  await firstHead.click();
  await expect(firstHead).toHaveAttribute("aria-expanded", "true");
  await expect(cards.first()).toHaveClass(/open/);
  await firstHead.click();
  await expect(firstHead).toHaveAttribute("aria-expanded", "false");

  // 键盘 Enter 同样可展开（可访问性）
  await firstHead.focus();
  await firstHead.press("Enter");
  await expect(cards.first()).toHaveClass(/open/);
});

test("同批工具按实际完成顺序逐张更新，不会等全部结束才同时完成", async ({ page }) => {
  await login(page);
  await createChat(page);
  await page.locator("#input").fill("逐个完成演示");
  await page.locator("#send-btn").click();

  const cards = page.locator("#messages .tool-card");
  await expect(cards).toHaveCount(3, { timeout: 10_000 });
  await expect(cards.nth(0).locator(".tool-status")).toHaveText("✓ 完成", { timeout: 10_000 });
  await expect(cards.nth(1).locator(".tool-status")).toHaveText("运行中");
  await expect(cards.nth(2).locator(".tool-status")).toHaveText("运行中");

  await expect(cards.nth(1).locator(".tool-status")).toHaveText("✓ 完成", { timeout: 10_000 });
  await expect(cards.nth(2).locator(".tool-status")).toHaveText("运行中");
  await expect(cards.nth(2).locator(".tool-status")).toHaveText("✓ 完成", { timeout: 10_000 });
  await expect(page.locator("#stop-btn")).toBeHidden({ timeout: 10_000 });
});

test("外部服务限流只显示普通用户能理解的说明，不泄露机器重试字段", async ({ page }) => {
  await login(page);
  await createChat(page);
  await runTurn(page, "限流工具演示", "服务主动等待后仍然繁忙");

  const group = page.locator("#messages .tool-group").first();
  await expect(group).toHaveCount(1);
  await expect(group.locator(".tool-group-names")).toContainText("house_lookup ×3");
  await expect(group.locator(".tool-group-status")).toHaveText("3 个需要处理");
  await group.locator(".tool-group-summary").click();

  const cards = group.locator(".tool-card");
  await expect(cards).toHaveCount(3);
  await expect(cards.locator(".tool-status")).toHaveText(["⚠ 稍后重试", "⚠ 稍后重试", "⚠ 稍后重试"]);
  await cards.first().locator(".tool-head").click();
  const result = cards.first().locator(".result-pre");
  await expect(result).toContainText("查询服务暂时繁忙");
  await expect(result).toContainText("等待约 60 秒");
  await expect(result).not.toContainText("service temporarily unavailable");
  await expect(result).not.toContainText("maxAttempts");
  await expect(result).not.toContainText("exhausted");
});

test("agent 与 tools 节点不显示空泛徽章，工具卡直接保留原始工具名", async ({ page }) => {
  await login(page);
  await createChat(page);
  await runTurn(page, "批量工具演示", "各自归到自己的分区");

  // agent / tools 是执行内部节点：不产生 .node-chip（具体工具名由卡片与组摘要承担）
  await expect(page.locator("#messages .node-chip")).toHaveCount(0);
  // 展开工具组后，卡片保留原始工具名而不是本地化类别名
  const group = page.locator("#messages .tool-group").first();
  await group.locator(".tool-group-summary").click();
  expect(await group.locator(".tool-name").allTextContents()).toEqual(["read_file", "read_image", "terminal"]);
});

test("思考过程流式阶段显示思考中状态，完成后隐藏并解除 busy", async ({ page }) => {
  await login(page);
  await createChat(page);
  await page.locator("#input").fill("慢速思考演示");
  await page.locator("#send-btn").click();

  // 流式中间态：思考卡可见、meta 文案「思考中」、aria-busy=true
  const details = page.locator("#messages .thinking-block").first();
  await expect(details).toBeVisible({ timeout: 15_000 });
  await expect(details).toHaveAttribute("aria-busy", "true");
  await expect(details).toHaveClass(/is-thinking/);
  const meta = details.locator(".thinking-meta");
  await expect(meta).toHaveText("思考中");
  await expect(meta).not.toHaveClass(/hidden/);
  await expect(meta).toHaveAttribute("role", "status");

  // 流结束后：meta 隐藏、busy 解除、is-thinking 摘掉
  await expect(page.locator("#stop-btn")).toBeHidden({ timeout: 25_000 });
  await expect(details).toHaveAttribute("aria-busy", "false");
  await expect(details).not.toHaveClass(/is-thinking/);
  await expect(meta).toHaveClass(/hidden/);
});
/**
 * 创建房产 Agent 会话。
 * 两种布局要**显式分支**：localStorage 会恢复上次会话，此时欢迎页是隐藏的，
 * 用 `#demo-cards.or(#modal-cards)` 会先命中隐藏的欢迎页卡片而一直等到超时。
 */
async function createEstateChat(page: import("@playwright/test").Page): Promise<void> {
  await page.locator("#new-chat-btn").click();
  const modal = page.locator("#modal-mask");
  const card = (await modal.isVisible())
    ? page.locator("#modal-cards .demo-card", { hasText: "租房 / 房产 Agent" }).first()
    : page.locator("#demo-cards .demo-card", { hasText: "租房 / 房产 Agent" }).first();
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.click();
  // 等遮罩收起：否则后续 fill/click 会打在遮罩上（只在超时后才暴露）
  await expect(modal).toBeHidden({ timeout: 15_000 });
  await expect(page.locator("#input")).toBeEnabled();
}

/** 发一轮房产对话并等流结束（结论区已渲染）。 */
async function runEstateTurn(page: import("@playwright/test").Page, message = "帮我找北京朝阳区两居室租房，预算6000"): Promise<void> {
  await page.locator("#input").fill(message);
  await page.locator("#send-btn").click();
  await expect(page.locator("#messages .conclusion-media")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#stop-btn")).toBeHidden({ timeout: 30_000 });
}

test("房源结论直接展示地图与户型图，工具卡不再承载媒体", async ({ page }) => {
  // 房产 mock 场景要走 4 次工具流（每次 JSON 分片 + 停顿），默认 35s 在全量顺序跑时不够
  test.setTimeout(90_000);
  await login(page);
  await createEstateChat(page);
  await runEstateTurn(page);

  const conclusion = page.locator("#messages .conclusion-media");
  await expect(conclusion).toHaveCount(1);
  // 结论块必须排在正文之后（结论在回答下方，不是散落在工具卡之间）
  const ordered = await page.evaluate(() => {
    const conclusionEl = document.querySelector("#messages .conclusion-media");
    const md = document.querySelector("#messages .md");
    if (!conclusionEl || !md) return false;
    return Boolean(md.compareDocumentPosition(conclusionEl) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(ordered).toBe(true);

  // 地图：瓦片层（≥9 瓦片 + 标记）+ 提供方数据集，且零 iframe
  const map = conclusion.locator(".conclusion-property-map");
  await expect(map).toHaveCount(1);
  await expect(map).toHaveAttribute("data-map-provider", /amap|tencent|baidu/);
  expect(Number(await map.getAttribute("data-map-lat"))).toBeGreaterThan(0);
  expect(Number(await map.getAttribute("data-map-lng"))).toBeGreaterThan(0);
  expect(await conclusion.locator(".conclusion-map-tile").count()).toBeGreaterThanOrEqual(9);
  await expect(conclusion.locator(".conclusion-map-marker")).toHaveCount(1);
  expect(await page.locator("#messages iframe").count()).toBe(0);

  // 工具卡不再承载媒体：媒体只在结论区
  expect(await page.locator("#messages .tool-card img, #messages .tool-card iframe, #messages .tool-card .conclusion-table").count()).toBe(0);

  // 户型图预览：点开后是模态、可缩放、Esc 关闭并回焦
  await expect(conclusion.locator(".conclusion-listing-link").first()).toHaveAttribute(
    "href",
    "https://bj.zu.ke.com/zufang/BJ2232327398555123712.html",
  );

  const imageButton = conclusion.locator(".conclusion-image-open").first();
  await expect(imageButton).toHaveCount(1);
  await imageButton.focus();
  await imageButton.click();
  const mask = page.locator("#media-preview-mask");
  await expect(mask).toBeVisible();
  await expect(page.locator("#media-preview-surface")).toHaveAttribute("data-kind", "image");
  await expect(page.locator("#media-preview-title")).toHaveText("户型图预览");
  await expect(page.locator("#media-preview-zoom-value")).toHaveText("100%");
  await mask.press("+");
  await expect(page.locator("#media-preview-zoom-value")).toHaveText("125%");
  await page.locator("#media-preview-zoom-out").click();
  await expect(page.locator("#media-preview-zoom-value")).toHaveText("100%");
  await page.locator("#media-preview-reset").click();
  await mask.press("Escape");
  await expect(mask).toBeHidden();
  expect(await imageButton.evaluate((el) => el === document.activeElement)).toBe(true);

  // 地图预览：同一模态的 map 变体，仍然零 iframe
  const mapButton = conclusion.locator(".conclusion-map-preview-trigger").first();
  await mapButton.focus();
  await mapButton.click();
  await expect(mask).toBeVisible();
  await expect(page.locator("#media-preview-surface")).toHaveAttribute("data-kind", "map");
  await expect(page.locator("#media-preview-surface .conclusion-map")).toHaveCount(1);
  expect(await page.locator("#media-preview iframe").count()).toBe(0);
  await page.locator("#media-preview-close").click();
  await expect(mask).toBeHidden();
  expect(await mapButton.evaluate((el) => el === document.activeElement)).toBe(true);
});

test("结论表跟随最终回答选择房源，户型图不再落入其他户型图", async ({ page }) => {
  test.setTimeout(90_000);
  await login(page);
  await createEstateChat(page);
  await runEstateTurn(page);

  const table = page.locator("#messages .conclusion-table");
  await expect(table).toHaveCount(1);
  const tableText = (await table.textContent()) ?? "";
  // 结论表只列最终回答里提到的房源，且带真实价格与面积
  expect(tableText).toMatch(/\d+㎡/);
  expect(tableText).toMatch(/(\d[\d,]* ?万|\d[\d,]* ?元\/月)/);
  // 每行户型图必须与自己的 houseId 绑定（不能整表共用一张图）
  const bound = await page.evaluate(() => {
    const el = document.querySelector("#messages .conclusion-table");
    if (!el) return { rows: 0, withImage: 0, uniqueSrc: 0 };
    const rows = [...el.querySelectorAll("tbody tr")];
    const srcs = rows.map((row) => row.querySelector("img")?.getAttribute("src") ?? "").filter(Boolean);
    return { rows: rows.length, withImage: srcs.length, uniqueSrc: new Set(srcs).size };
  });
  expect(bound.rows).toBeGreaterThan(0);
  expect(bound.withImage).toBe(bound.uniqueSrc);
  // 「其他户型图」这种兜底分组标题不得回流
  expect(await page.locator("#messages").textContent()).not.toContain("其他户型图");
});

test("结论表最多展示 12 套并显示 Excel 下载入口", async ({ page }) => {
  await login(page);
  await createChat(page);
  await page.locator("#input").fill("大量候选演示");
  await page.locator("#send-btn").click();
  await expect(page.locator("#messages .conclusion-media")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#stop-btn")).toBeHidden({ timeout: 30_000 });

  const conclusion = page.locator("#messages .conclusion-media");
  // 服务端给了 15 套，结论表硬上限 12 行
  await expect(conclusion.locator(".conclusion-table tbody tr")).toHaveCount(12);
  const exportLink = conclusion.locator(".conclusion-export-link");
  await expect(exportLink).toHaveCount(1);
  await expect(exportLink).toHaveAttribute("href", "/api/estate/exports/123e4567-e89b-42d3-a456-426614174000");
  await expect(exportLink).toContainText("15 套完整候选");
});

test("地图结论使用同源瓦片层渲染，全程零 iframe", async ({ page }) => {
  test.setTimeout(90_000);
  await login(page);
  await createEstateChat(page);
  await runEstateTurn(page);

  // 说明：地图提供方由环境变量 MAP_PROVIDER 在服务启动时决定（无运行时写入 API），
  // 各提供方的瓦片 URL / 静态图 URL 构造规则已在 tests/unit/chat-flow.test.ts 覆盖。
  // 这里只守 e2e 独有的部分：真实渲染路径确实用同源瓦片层，而不是 iframe 嵌入。
  const map = page.locator("#messages .conclusion-property-map").first();
  await expect(map).toBeVisible({ timeout: 20_000 });
  await expect(map).toHaveAttribute("data-map-provider", /amap|tencent|baidu|osm|custom/);

  const tiles = page.locator("#messages .conclusion-map-tile");
  expect(await tiles.count()).toBeGreaterThanOrEqual(9);
  for (const src of await tiles.evaluateAll((els) => els.map((el) => (el as HTMLImageElement).src))) {
    expect(src.startsWith("https://") || src.startsWith("http://127.0.0.1")).toBe(true);
  }
  expect(await page.locator("#messages iframe").count()).toBe(0);
  // 地图预览走同一模态，仍然零 iframe
  await page.locator("#messages .conclusion-map-preview-trigger").first().click();
  await expect(page.locator("#media-preview-surface")).toHaveAttribute("data-kind", "map");
  expect(await page.locator("#media-preview iframe").count()).toBe(0);
  await page.locator("#media-preview-close").click();
});

test("静态底图就绪后隐藏瓦片与标记层，不出现 iframe 降级", async ({ page }) => {
  test.setTimeout(90_000);
  await login(page);
  // 静态图代理允许被拦截：命中说明前端确实走 /api/map/static 同源代理
  const staticMapRequests: string[] = [];
  await page.route(/\/api\/map\/static\?/, async (route) => {
    staticMapRequests.push(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="360"><rect width="100%" height="100%" fill="#dbe7da"/></svg>',
    });
  });
  await createEstateChat(page);
  await runEstateTurn(page);

  const map = page.locator("#messages .conclusion-property-map").first();
  await expect(map).toBeVisible({ timeout: 20_000 });
  // 没有配置静态图 Key 时不设 data-map-renderer（直接走瓦片层，且不请求代理）
  if ((await map.locator(".conclusion-map-static").count()) === 0) {
    expect(staticMapRequests.length).toBe(0);
    expect(await page.locator("#messages iframe").count()).toBe(0);
    return;
  }
  // 配置了静态图 Key 的环境：静态图必须 ready 且瓦片/标记让位
  await expect(map).toHaveAttribute("data-map-status", "ready", { timeout: 15_000 });
  await expect(map).toHaveAttribute("data-map-renderer", /-static$/);
  const staticImage = map.locator(".conclusion-map-static");
  await expect(staticImage).toHaveClass(/is-ready/);
  expect(await map.locator(".conclusion-map-tiles").evaluate((el) => (el as HTMLElement).hidden)).toBe(true);
  expect(await page.locator("#messages iframe").count()).toBe(0);
  const request = staticMapRequests[0];
  expect(request).toBeTruthy();
  expect(new URL(request).searchParams.get("variant")).toBe("compact");
});
