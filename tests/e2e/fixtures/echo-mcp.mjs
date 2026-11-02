/**
 * echo-mcp.mjs — E2E 用的最小 MCP server（stdio + JSON-RPC 2.0）
 * ============================================================
 * 只实现 initialize / tools/list / tools/call，供「测试连接」按钮回归使用。
 * 刻意不引入 @modelcontextprotocol/sdk：这是协议对端 fixture，不是产品代码。
 */
let buffer = "";
process.stdin.setEncoding("utf8");

const send = (payload) => process.stdout.write(JSON.stringify(payload) + "\n");

process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.id == null) continue;
    const reply = (result) => send({ jsonrpc: "2.0", id: message.id, result });
    const fail = (text) => send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: text } });
    if (message.method === "initialize") {
      reply({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "echo", version: "1.0.0" } });
    } else if (message.method === "tools/list") {
      reply({ tools: [{ name: "echo", description: "回显文本", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] });
    } else if (message.method === "tools/call") {
      reply({ content: [{ type: "text", text: "echo: " + String(message.params?.arguments?.text ?? "") }] });
    } else {
      fail("未实现的方法 " + message.method);
    }
  }
});
