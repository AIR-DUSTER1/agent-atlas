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