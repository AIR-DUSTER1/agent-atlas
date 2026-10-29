/**
 * config.ts — 统一读取 .env 中的网关配置
 *
 * 为什么要单独抽一个文件？
 * 所有 demo 共用一个「自定义 OpenAI 兼容网关」，把 baseURL / apiKey / model
 * 集中在这里管理，方便你在不修改任何 agent 代码的情况下切换供应商或模型。
 *
 * ★ config 是「运行时可变」的（没有 as const）：
 *   - CLI 场景：启动后无人修改它，值 === .env；
 *   - Web 场景：src/server/settings.ts 会在启动时叠加本地覆盖文件
 *     （.web-config.json），并允许在设置页里在线修改 —— 建图时
 *     （llm.ts 的 createChatModel）读取的永远是当前值。
 */
import "dotenv/config";
import { DEFAULT_REASONING, type ReasoningSetting } from "./reasoning.js";

/** LangGraph 超步上限：既给长任务留足执行空间，也保留失控循环的最终防线。 */
export const AGENT_RECURSION_LIMIT = 1_000;

/** 长任务不设置业务层执行时长 / 工具 / 模型调用上限；只限制单次模型请求。 */
const DEFAULT_MODEL_REQUEST_TIMEOUT_MS = 90_000;
const DEFAULT_MODEL_REQUEST_RETRIES = 10;

function resolvePositiveInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
}

function resolveNonNegativeInt(raw: string | undefined, fallback: number, max: number): number {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 && value <= max ? value : fallback;
}

export const config = {
  /** 兼容 OpenAI 格式的 API 地址（例如 https://tokenrhythm.studio/v1） */
  baseURL: process.env.BASE_URL ?? "https://tokenrhythm.studio/v1",

  /** API Key */
  apiKey: process.env.API_KEY ?? "",

  /** 模型名。运行 `npm run models` 可查看网关支持的模型列表 */
  model: process.env.MODEL ?? "gpt-4o-mini",

  /**
   * 请求协议（多用于中转站的多协议路由）：
   *   - "openai"           OpenAI Chat Completions（默认，{baseURL}/chat/completions）
   *   - "openai-responses" OpenAI Responses API（{baseURL}/responses）
   *   - "anthropic"        Anthropic Messages 原生（{baseURL}/v1/messages，
   *                        例：DeepSeek 的 https://api.deepseek.com/anthropic）
   *   - "gemini"           Gemini 原生 generateContent（{baseURL}/v1beta/...）
   */
  protocol: process.env.AI_PROTOCOL ?? "openai",

  /**
   * 思考等级（推理强度）——跟着「当前启用的模型」走，由 settings.ts 在
   * 切换供应商 / 模型时写入，llm.ts 建模型时读取。
   *
   * 各供应商对思考等级的划分并不一致（OpenAI 是 reasoning_effort 强度档，
   * 智谱 GLM 是 thinking.type 开关，Anthropic 是 budget_tokens 预算…），
   * 所以这里存的是「方言 + 档位」，由 reasoning.ts 翻译成真正的请求参数。
   */
  reasoning: { ...DEFAULT_REASONING } as ReasoningSetting,

  /** 单次模型 HTTP 请求的超时；流式请求也从连接建立开始计时。 */
  modelRequestTimeoutMs: resolvePositiveInt(process.env.MODEL_REQUEST_TIMEOUT_MS, DEFAULT_MODEL_REQUEST_TIMEOUT_MS, 10_000, 10 * 60_000),
  /** 单次模型调用失败后的自动重试次数；0 表示不重试。 */
  modelRequestRetries: resolveNonNegativeInt(process.env.MODEL_REQUEST_RETRIES, DEFAULT_MODEL_REQUEST_RETRIES, 20),
} as {
  baseURL: string;
  apiKey: string;
  model: string;
  protocol: Protocol;
  reasoning: ReasoningSetting;
  modelRequestTimeoutMs: number;
  modelRequestRetries: number;
};

export type Protocol = "openai" | "openai-responses" | "anthropic" | "gemini";

export const PROTOCOLS: Protocol[] = ["openai", "openai-responses", "anthropic", "gemini"];

/** 协议合法性校验（settings 落盘前用） */
export function isProtocol(v: unknown): v is Protocol {
  return typeof v === "string" && (PROTOCOLS as string[]).includes(v);
}

/** 启动前校验配置是否齐全，缺 Key 时给出明确提示并退出 */
export function assertConfig(): void {
  if (!config.apiKey) {
    console.error(
      "[config] 缺少 API_KEY。\n" +
        "  请复制 .env.example 为 .env 并填入你的 API Key，或设置环境变量 API_KEY。\n" +
        "  （Web 界面也可以在设置页里在线填写：npm run web → 侧栏左下 ⚙ 设置）"
    );
    process.exit(1);
  }
  if (!config.baseURL) {
    console.error("[config] 缺少 BASE_URL（OpenAI 兼容网关地址）。");
    process.exit(1);
  }
  console.log(
    `[config] 网关: ${config.baseURL}  模型: ${config.model}\n`
  );
}
