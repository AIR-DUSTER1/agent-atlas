/**
 * ui-primitives.test.ts — 安全 DOM 原语与 URL 白名单
 * ============================================================
 * 不引 jsdom；用最小 DOM shim 验证 h() 只生成文本节点、拒绝 HTML/字符串事件、
 * 危险 URL 不落到属性，同时覆盖 safeUrl 的协议边界。
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { h } from "../../src/client/ui/h.js";
import { safeHref, safeImageSrc, safeUrl } from "../../src/client/ui/safe-url.js";

class FakeStyle {
  readonly values = new Map<string, string>();
  setProperty(name: string, value: string): void { this.values.set(name, value); }
}

class FakeElement {
  readonly tagName: string;
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly style = new FakeStyle();
  readonly children: FakeElement[] = [];
  readonly listeners = new Map<string, EventListener>();
  parentNode: FakeElement | null = null;
  textContent = "";

  constructor(tagName: string) { this.tagName = tagName.toUpperCase(); }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  getAttribute(name: string): string | undefined { return this.attributes.get(name); }
  addEventListener(name: string, listener: EventListener): void { this.listeners.set(name, listener); }
  appendChild(child: FakeElement): FakeElement { child.parentNode = this; this.children.push(child); return child; }
}

class FakeImageElement extends FakeElement {
  constructor() { super("img"); }
}

const saved = {
  document: (globalThis as any).document,
  HTMLElement: (globalThis as any).HTMLElement,
  HTMLImageElement: (globalThis as any).HTMLImageElement,
};

before(() => {
  (globalThis as any).HTMLElement = FakeElement;
  (globalThis as any).HTMLImageElement = FakeImageElement;
  (globalThis as any).document = {
    createElement(tag: string): FakeElement { return tag === "img" ? new FakeImageElement() : new FakeElement(tag); },
    createElementNS(_namespace: string, tag: string): FakeElement { return new FakeElement(tag); },
    createTextNode(text: string): FakeElement {
      const node = new FakeElement("#text");
      node.textContent = text;
      return node;
    },
  };
});

after(() => {
  (globalThis as any).document = saved.document;
  (globalThis as any).HTMLElement = saved.HTMLElement;
  (globalThis as any).HTMLImageElement = saved.HTMLImageElement;
});

test("h() 创建属性、dataset、样式、文本与函数事件", () => {
  const clicked = (() => {}) as EventListener;
  const el = h("button", {
    class: "ui-button",
    dataset: { action: "save" },
    style: { "--tone": "danger", paddingTop: "4px" },
    title: "保存",
    onclick: clicked,
  }, "保存", 1, null, false);
  assert.equal(el.getAttribute("class"), "ui-button");
  const fake = el as unknown as FakeElement;
  assert.equal(fake.getAttribute("class"), "ui-button");
  assert.equal(fake.dataset.action, "save");
  assert.equal(fake.style.values.get("--tone"), "danger");
  assert.equal(fake.style.values.get("padding-top"), "4px");
  assert.equal(fake.listeners.get("click"), clicked);
  assert.deepEqual(fake.children.map((item) => item.textContent), ["保存", "1"]);
});

test("h() 拒绝 HTML 注入入口与字符串事件处理器", () => {
  assert.throws(() => h("div", { innerHTML: "<img onerror=alert(1)>" }), /禁止/);
  assert.throws(() => h("button", { onclick: "alert(1)" }), /必须绑定函数/);
});

test("h() 对危险 URL 只留下拒绝标记", () => {
  const link = h("a", { href: "javascript:alert(1)" }, "危险");
  const fakeLink = link as unknown as FakeElement;
  assert.equal(fakeLink.getAttribute("href"), undefined);
  assert.equal(fakeLink.getAttribute("data-invalid-url"), "href");
  const image = h("img", { src: "data:text/html,<script>alert(1)</script>" });
  const fakeImage = image as unknown as FakeElement;
  assert.equal(fakeImage.getAttribute("src"), undefined);
  assert.equal(fakeImage.getAttribute("data-invalid-url"), "src");
});

test("safe-url 仅放行约定的协议与相对地址", () => {
  assert.equal(safeHref("/api/sessions"), "/api/sessions");
  assert.equal(safeHref("../docs"), "../docs");
  assert.equal(safeHref("https://example.com/a"), "https://example.com/a");
  assert.match(safeHref("mailto:user@example.com") ?? "", /^mailto:user@example\.com$/);
  assert.equal(safeHref("javascript:alert(1)"), null);
  assert.equal(safeHref("//evil.example/x"), null);
  assert.equal(safeImageSrc("data:image/png;base64,AAAA"), "data:image/png;base64,AAAA");
  assert.equal(safeImageSrc("data:text/html,<script>1</script>"), null);
  assert.equal(safeUrl("ftp://example.com/file"), null);
});
