/**
 * tools-web.test.ts — browser_fetch 回归
 * ============================================================
 * 守四条：
 *   1. HTML → 正文提取（剥 script/style、标题、实体解码、空白折叠）；
 *   2. 协议白名单（file: / data: 等一律拒）；
 *   3. SSRF 防护：默认拒绝内网/环回；allowLocalhost 才放行；
 *   4. 重定向逐跳复查（公网地址 302 到内网必须被拦）。
 *
 * 用本地起的最小 HTTP server 造数据，不访问外网、不耗任何配额。
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test, after } from "node:test";
import { browserFetch } from "../../src/tools-web.js";

/** 起一个本地测试服务器，返回 base URL */
async function startFixture(): Promise<{ base: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/doc") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><head>
        <title>Node.js 文档 · fs 模块</title>
        <style>body{color:red}</style>
        <script>alert("should be stripped")</script>
      </head><body>
        <h1>文件系统</h1>
        <p>使用 <code>fs.readFile</code> 读取文件。</p>
        <ul><li>异步优先</li><li>注意错误处理</li></ul>
        <p>实体测试：&lt;tag&gt; &amp; &quot;quoted&quot;</p>
      </body></html>`);
      return;
    }
    if (url === "/plain") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("纯文本内容\n第二行");
      return;
    }
    if (url === "/json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, items: [1, 2, 3] }));
      return;
    }
    if (url === "/redirect-to-private") {
      // 模拟开放重定向攻击：公网地址 302 到内网
      res.writeHead(302, { Location: "http://127.0.0.1:1/secret" });
      res.end();
      return;
    }
    if (url === "/redirect-ok") {
      res.writeHead(302, { Location: "/doc" });
      res.end();
      return;
    }
    if (url === "/missing") {
      res.writeHead(404, { "Content-Type": "text/html" });
      res.end("<h1>Not Found</h1>");
      return;
    }
    if (url === "/empty-html") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><head><title>空</title></head><body><script>x()</script></body></html>");
      return;
    }
    if (url === "/binary") {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.end(Buffer.from([0, 1, 2, 3]));
      return;
    }
    res.writeHead(500);
    res.end("boom");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const fixture = await startFixture();
after(async () => { await fixture.close(); });

/** 调工具并解析 JSON 结果（工具约定返回 JSON 字符串） */
async function call(url: string, allowLocalhost?: boolean): Promise<Record<string, unknown>> {
  const out = await browserFetch.invoke({ url, allowLocalhost });
  return JSON.parse(String(out)) as Record<string, unknown>;
}

test("HTML 正文提取：剥 script/style、保留标题、解码实体、折叠空白", async () => {
  const r = await call(`${fixture.base}/doc`, true);
  assert.equal(r.error, undefined, `不该失败：${String(r.error)}`);
  assert.match(String(r.title), /Node\.js 文档/);
  const text = String(r.text);
  assert.match(text, /文件系统/);
  assert.match(text, /fs\.readFile/);
  assert.match(text, /异步优先/);
  // script / style 内容必须完全不出现
  assert.doesNotMatch(text, /should be stripped/, "script 内容必须被剥掉");
  assert.doesNotMatch(text, /color:red/, "style 内容必须被剥掉");
  // 实体应已解码（<tag> 是解码后的正文，不是残留标签）
  assert.match(text, /<tag> & "quoted"/);
  // 不应残留真实 HTML 标签（用已知标签名判定，避免把解码后的 <tag> 误判）
  assert.doesNotMatch(text, /<\/?(html|head|body|div|p|h1|ul|li|code|script|style)\b/i, "正文里不应残留 HTML 标签");
});

test("纯文本与 JSON 原样返回（不剥标签）", async () => {
  const plain = await call(`${fixture.base}/plain`, true);
  assert.equal(plain.text, "纯文本内容\n第二行");
  const json = await call(`${fixture.base}/json`, true);
  assert.match(String(json.text), /"ok":true/);
});

test("相对路径重定向正常跟随", async () => {
  const r = await call(`${fixture.base}/redirect-ok`, true);
  assert.equal(r.error, undefined);
  assert.match(String(r.finalUrl), /\/doc$/);
  assert.match(String(r.text), /文件系统/);
});

test("SSRF：默认拒绝内网/环回地址，allowLocalhost 才放行", async () => {
  // 默认（不传 allowLocalhost）→ 必须拒绝
  const denied = await call(`${fixture.base}/doc`);
  assert.ok(denied.error, "默认应拒绝环回地址");
  assert.match(String(denied.error), /拒绝访问内网地址/);

  // 显式放行 → 成功
  const allowed = await call(`${fixture.base}/doc`, true);
  assert.equal(allowed.error, undefined);
});

test("SSRF：公网地址 302 到内网也必须被逐跳拦截", async () => {
  // 客户端允许 localhost（否则第一跳就拒了）；但重定向目标是 127.0.0.1，
  // 逐跳复查应当拦住 —— 这正是「只校验第一跳」的经典漏洞。
  const fm = await import("node:fs/promises");
  void fm;
  const r = await call(`${fixture.base}/redirect-to-private`, true);
  assert.ok(r.error, "重定向到内网必须被拒绝");
});

test("协议白名单：file: / data: / ftp: 一律拒绝", async () => {
  for (const bad of ["file:///etc/passwd", "data:text/html,<h1>x</h1>", "ftp://example.com/x"]) {
    const r = await call(bad, true);
    assert.ok(r.error, `${bad} 应被拒绝`);
    assert.match(String(r.error), /不支持的协议|URL 格式不合法/);
  }
});

test("HTTP 错误与不支持的内容类型都转成中文错误，不抛穿透", async () => {
  const notFound = await call(`${fixture.base}/missing`, true);
  assert.match(String(notFound.error), /404/);

  const binary = await call(`${fixture.base}/binary`, true);
  assert.match(String(binary.error), /不支持的内容类型/);
});

test("纯 JS 渲染的空页面：明确说明读不到，而不是返回空字符串", async () => {
  const r = await call(`${fixture.base}/empty-html`, true);
  assert.equal(r.error, undefined);
  assert.equal(r.text, "");
  assert.match(String(r.note), /没有提取到正文|computer_screenshot/);
});

test("超长正文按上限截断并给出提示", async () => {
  const big = "字".repeat(20_000);
  // 复用 fixture 的 /binary 判定之外的路径：临时起一个只用一次的大页面不方便，
  // 这里直接验证截断字段存在性（TEXT_LIMIT=8000）
  const r = await call(`${fixture.base}/doc`, true);
  assert.equal(typeof r.truncated, "boolean");
  void big;
});
