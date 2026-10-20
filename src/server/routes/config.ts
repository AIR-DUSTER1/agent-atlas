/**
 * routes/config.ts — 供应商 / 模型 / 思考等级 / 网关探测路由
 * ============================================================
 * POST 语义统一「先 await 业务，再 writeHead」（失败才能正常回 4xx）；
 * 供应商/模型变更引起 activeChanged 时 bumpConfigVersion，让已建会话用新配置重建图。
 */
import { readBody, respondBadRequest } from "../http-body.js";
import { config } from "../../config.js";
import {
  listProviders, getActiveId, getActiveModelId, addProvider, updateProvider, deleteProvider,
  activate, addModel, updateModel, deleteModel, setReasoning, listDialects, getReasoningState,
  maskKey, fetchGatewayModelList, getContextWindowForActive, refreshModelInfo,
} from "../settings.js";
import { bumpConfigVersion } from "../sessions.js";
import { DEMOS } from "../sessions.js";

/** GET /api/config —— 模型/模式元信息（前端顶栏与设置页的状态源） */
export async function handleGetApiConfig(res: import("node:http").ServerResponse): Promise<void> {
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({
    mock: !config.apiKey,
    model: config.model,
    baseURL: config.baseURL,
    protocol: config.protocol,
    hasKey: Boolean(config.apiKey),
    keyMasked: maskKey(config.apiKey),
    providers: listProviders(),
    activeProviderId: getActiveId(),
    activeModelId: getActiveModelId(),
    // 当前启用模型的思考等级（方言 + 档位 + 该方言的全部档位），前端顶栏/设置页据此渲染
    reasoning: getReasoningState(),
    dialects: listDialects(),
    contextWindow: getContextWindowForActive() ?? null,
    demos: DEMOS,
  }));
}

/** POST /api/config/providers —— 新增供应商 */
export async function handleAddProvider(res: import("node:http").ServerResponse, req: import("node:http").IncomingMessage): Promise<void> {
  const body = JSON.parse((await readBody(req)) || "{}");
  try {
    const { provider, activeChanged } = await addProvider(body);
    if (activeChanged) {
      bumpConfigVersion();
      void refreshModelInfo().catch(() => {});
    }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, provider, activeChanged, mock: !config.apiKey }));
  } catch (err) {
    respondBadRequest(res, req, err);
  }
}

/** POST /api/config/providers/:id/models —— 给供应商添加模型 */
export async function handleAddModel(res: import("node:http").ServerResponse, req: import("node:http").IncomingMessage, providerId: string): Promise<void> {
  const body = JSON.parse((await readBody(req)) || "{}");
  try {
    const r = await addModel(providerId, body);
    if (r.activeChanged) {
      bumpConfigVersion();
      void refreshModelInfo().catch(() => {});
    }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, ...r }));
  } catch (err) {
    respondBadRequest(res, req, err);
  }
}

/** POST /api/config/providers/:id/models/:mid —— 更新单个模型 */
export async function handleUpdateModel(res: import("node:http").ServerResponse, req: import("node:http").IncomingMessage, providerId: string, modelId: string): Promise<void> {
  const body = JSON.parse((await readBody(req)) || "{}");
  try {
    const r = await updateModel(providerId, modelId, body);
    if (r.activeChanged) {
      bumpConfigVersion();
      void refreshModelInfo().catch(() => {});
    }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, ...r }));
  } catch (err) {
    respondBadRequest(res, req, err);
  }
}

/** DELETE /api/config/providers/:id/models/:mid —— 删除单个模型 */
export async function handleDeleteModel(res: import("node:http").ServerResponse, req: import("node:http").IncomingMessage, providerId: string, modelId: string): Promise<void> {
  try {
    const r = await deleteModel(providerId, modelId);
    if (r.activeChanged) {
      bumpConfigVersion();
      void refreshModelInfo().catch(() => {});
    }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, ...r }));
  } catch (err) {
    respondBadRequest(res, req, err);
  }
}

/** POST /api/config/reasoning —— 只改思考等级 */
export async function handleSetReasoning(res: import("node:http").ServerResponse, req: import("node:http").IncomingMessage): Promise<void> {
  const body = JSON.parse((await readBody(req)) || "{}");
  try {
    const r = await setReasoning(body);
    if (r.activeChanged) bumpConfigVersion();
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, ...r, reasoning: getReasoningState() }));
  } catch (err) {
    respondBadRequest(res, req, err);
  }
}

/** POST /api/config/providers/:id —— 更新供应商 */
export async function handleUpdateProvider(res: import("node:http").ServerResponse, req: import("node:http").IncomingMessage, providerId: string): Promise<void> {
  const body = JSON.parse((await readBody(req)) || "{}");
  try {
    const { activeChanged } = await updateProvider(providerId, body);
    if (activeChanged) {
      bumpConfigVersion();
      void refreshModelInfo().catch(() => {});
    }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, activeChanged, mock: !config.apiKey, model: config.model, baseURL: config.baseURL }));
  } catch (err) {
    respondBadRequest(res, req, err);
  }
}

/** DELETE /api/config/providers/:id —— 删除供应商 */
export async function handleDeleteProvider(res: import("node:http").ServerResponse, req: import("node:http").IncomingMessage, providerId: string): Promise<void> {
  try {
    const { activeChanged } = await deleteProvider(providerId);
    if (activeChanged) {
      bumpConfigVersion();
      void refreshModelInfo().catch(() => {});
    }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, activeChanged, mock: !config.apiKey }));
  } catch (err) {
    respondBadRequest(res, req, err);
  }
}

/** POST /api/config/activate —— 切换「供应商 × 模型」 */
export async function handleActivate(res: import("node:http").ServerResponse, req: import("node:http").IncomingMessage): Promise<void> {
  const body = JSON.parse((await readBody(req)) || "{}") as { id?: string; providerId?: string; modelId?: string };
  try {
    const r = await activate(body.providerId ?? body.id ?? "", body.modelId);
    if (r.activeChanged) {
      bumpConfigVersion();
      void refreshModelInfo().catch(() => {});
    }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, ...r, mock: !config.apiKey, baseURL: config.baseURL, reasoning: getReasoningState() }));
  } catch (err) {
    respondBadRequest(res, req, err);
  }
}

/** POST /api/models —— 拉取网关模型列表（兼「测试连接」，失败也 200 便于前端弹错误气泡） */
export async function handleModels(res: import("node:http").ServerResponse, req: import("node:http").IncomingMessage): Promise<void> {
  const body = JSON.parse((await readBody(req)) || "{}") as {
    baseURL?: unknown; apiKey?: unknown; providerId?: unknown; protocol?: unknown;
  };
  try {
    const models = await fetchGatewayModelList({
      baseURL: typeof body.baseURL === "string" && body.baseURL.trim() ? body.baseURL : undefined,
      apiKey: typeof body.apiKey === "string" ? body.apiKey : undefined,
      providerId: typeof body.providerId === "string" ? body.providerId : undefined,
      protocol: body.protocol,
    });
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, models, contextWindow: getContextWindowForActive() ?? null }));
  } catch (err) {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }));
  }
}
