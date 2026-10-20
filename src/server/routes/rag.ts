/**
 * routes/rag.ts — 外部知识库（RAG）路由：配置 / 测试 / 入库 / 检索 / 删文档 / 清空
 * ============================================================
 * 真实的向量存储与 embedding 由外部服务完成（契约见 src/server/rag.ts）；
 * getRagPublic 是 async 导出函数，**必须 await** 再 stringify（§5.5 老 JSON 坑）。
 */
import { readBody, respondBadRequest, BodyTooLargeError } from "../http-body.js";
import { getRagPublic, saveRagConfig, testRagConnection, searchRag, ingestFolder, ingestText, deleteRagDoc, clearRag } from "../rag.js";

export async function handleGetRag(res: import("node:http").ServerResponse): Promise<void> {
  const rag = await getRagPublic();
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(rag));
}

export async function handleSaveRagConfig(res: import("node:http").ServerResponse, req: import("node:http").IncomingMessage): Promise<void> {
  const body = JSON.parse((await readBody(req)) || "{}") as { baseURL?: string; apiKey?: unknown; collection?: unknown; topK?: unknown };
  try {
    const rag = await saveRagConfig({ ...body, baseURL: body.baseURL ?? "" });
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, rag }));
  } catch (err) {
    respondBadRequest(res, req, err);
  }
}

export async function handleTestRag(res: import("node:http").ServerResponse, req: import("node:http").IncomingMessage): Promise<void> {
  const body = JSON.parse((await readBody(req)) || "{}") as { baseURL?: string; apiKey?: unknown };
  try {
    const r = await testRagConnection({
      baseURL: typeof body.baseURL === "string" && body.baseURL.trim() ? body.baseURL : undefined,
      apiKey: typeof body.apiKey === "string" ? body.apiKey : undefined,
    });
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(r));
  } catch (err) {
    if (err instanceof BodyTooLargeError) respondBadRequest(res, req, err);
    else {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    }
  }
}

export async function handleIngest(res: import("node:http").ServerResponse, req: import("node:http").IncomingMessage): Promise<void> {
  const body = JSON.parse((await readBody(req)) || "{}") as { path?: string; name?: string; content?: string };
  try {
    let summary: unknown;
    if (typeof body.path === "string" && body.path.trim()) {
      summary = await ingestFolder(body.path); // 文件夹扫描批量入库（授权路径内）
    } else if (typeof body.content === "string" && typeof body.name === "string") {
      await ingestText(body.name, body.content, "手动粘贴");
      summary = { ingested: 1 };
    } else {
      throw new Error("需要 path（文件夹扫描入库）或 name + content（文本入库）");
    }
    const rag = await getRagPublic();
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, summary, rag }));
  } catch (err) {
    respondBadRequest(res, req, err);
  }
}

export async function handleRagSearch(res: import("node:http").ServerResponse, req: import("node:http").IncomingMessage): Promise<void> {
  const body = JSON.parse((await readBody(req)) || "{}") as { query?: string; topK?: number };
  try {
    const r = await searchRag(body.query ?? "", body.topK);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, ...r }));
  } catch (err) {
    respondBadRequest(res, req, err);
  }
}

export async function handleDeleteRagDoc(res: import("node:http").ServerResponse, req: import("node:http").IncomingMessage, id: string): Promise<void> {
  try {
    const rag = await deleteRagDoc(id);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, rag }));
  } catch (err) {
    respondBadRequest(res, req, err);
  }
}

export async function handleClearRag(res: import("node:http").ServerResponse, req: import("node:http").IncomingMessage): Promise<void> {
  try {
    const rag = await clearRag();
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, rag }));
  } catch (err) {
    respondBadRequest(res, req, err);
  }
}
