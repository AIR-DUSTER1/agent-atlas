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

export type MapProviderId = "amap" | "tencent" | "baidu" | "osm" | "custom";
export type MapCoordinateSystem = "wgs84" | "gcj02" | "bd09";
export type MapProjection = "web-mercator" | "baidu";
export type MapTileYAxis = "xyz" | "tms";

/** 前端地图渲染公开配置；Web 服务 Key 只留在服务端，不下发浏览器。 */
export interface MapRuntimeConfig {
  provider: MapProviderId;
  label: string;
  tileUrl: string;
  subdomains: string[];
  coordinateSystem: MapCoordinateSystem;
  projection: MapProjection;
  yAxis: MapTileYAxis;
  zoom: number;
  tileSize: number;
  staticMapAvailable: boolean;
}

const MAP_PROVIDER_DEFAULTS: Record<MapProviderId, MapRuntimeConfig> = {
  amap: {
    provider: "amap",
    label: "高德地图",
    tileUrl: "https://{s}.is.autonavi.com/appmaptile?style=8&x={x}&y={y}&z={z}",
    subdomains: ["webst01", "webst02", "webst03", "webst04"],
    coordinateSystem: "gcj02",
    projection: "web-mercator",
    yAxis: "xyz",
    zoom: 14,
    tileSize: 256,
    staticMapAvailable: false,
  },
  tencent: {
    provider: "tencent",
    label: "腾讯地图",
    tileUrl: "https://rt{s}.map.gtimg.com/tile?z={z}&x={x}&y={y}&styleid=3&version=1",
    subdomains: ["0", "1", "2", "3"],
    coordinateSystem: "gcj02",
    projection: "web-mercator",
    yAxis: "tms",
    zoom: 14,
    tileSize: 256,
    staticMapAvailable: false,
  },
  baidu: {
    provider: "baidu",
    label: "百度地图",
    tileUrl: "https://maponline{s}.bdimg.com/tile/?qt=vtile&x={x}&y={y}&z={z}&styles=pl&scaler=1&udt=20240101",
    subdomains: ["0", "1", "2", "3"],
    coordinateSystem: "bd09",
    projection: "baidu",
    yAxis: "xyz",
    zoom: 14,
    tileSize: 256,
    staticMapAvailable: false,
  },
  osm: {
    provider: "osm",
    label: "OpenStreetMap",
    tileUrl: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    subdomains: [],
    coordinateSystem: "wgs84",
    projection: "web-mercator",
    yAxis: "xyz",
    zoom: 14,
    tileSize: 256,
    staticMapAvailable: false,
  },
  custom: {
    provider: "custom",
    label: "自定义地图",
    tileUrl: "",
    subdomains: [],
    coordinateSystem: "wgs84",
    projection: "web-mercator",
    yAxis: "xyz",
    zoom: 14,
    tileSize: 256,
    staticMapAvailable: false,
  },
};

function mapProviderId(raw: string | undefined): MapProviderId {
  const value = (raw || "").trim().toLowerCase();
  return value === "tencent" || value === "qq" ? "tencent"
    : value === "baidu" || value === "bd" ? "baidu"
      : value === "osm" || value === "openstreetmap" ? "osm"
        : value === "custom" ? "custom" : "amap";
}

function mapCoordinateSystem(raw: string | undefined, fallback: MapCoordinateSystem): MapCoordinateSystem {
  const value = (raw || "").trim().toLowerCase();
  return value === "wgs84" || value === "gcj02" || value === "bd09" ? value : fallback;
}

function mapProjection(raw: string | undefined, fallback: MapProjection): MapProjection {
  const value = (raw || "").trim().toLowerCase();
  return value === "web-mercator" || value === "webmercator" || value === "mercator" || value === "baidu"
    ? value === "baidu" ? "baidu" : "web-mercator"
    : fallback;
}

function mapYAxis(raw: string | undefined, fallback: MapTileYAxis): MapTileYAxis {
  const value = (raw || "").trim().toLowerCase();
  return value === "tms" ? "tms" : value === "xyz" ? "xyz" : fallback;
}

function mapSubdomains(raw: string | undefined, fallback: string[]): string[] {
  const values = (raw || "").split(",").map((item) => item.trim()).filter((item) => /^[a-z0-9.-]+$/i.test(item));
  return values.length ? values : fallback;
}

/** 三家国内地图都通过服务端 Web 服务 Key 调用官方静态图；OSM/自定义不读 Key。 */
function staticMapKey(provider: MapProviderId, env: Record<string, string | undefined>): string {
  if (provider === "amap") return (env.AMAP_WEB_SERVICE_KEY || env.AMAP_KEY || "").trim();
  if (provider === "tencent") return (env.TENCENT_MAP_KEY || env.TENCENT_WEB_SERVICE_KEY || "").trim();
  if (provider === "baidu") return (env.BAIDU_MAP_AK || env.BAIDU_MAP_KEY || "").trim();
  return "";
}

/** 只读取环境变量，不触碰网络；测试可传入任意 env 快照。 */
export function resolveMapRuntimeConfig(env: Record<string, string | undefined>): MapRuntimeConfig {
  const requested = mapProviderId(env.MAP_PROVIDER);
  const tileUrlOverride = (env.MAP_TILE_URL || "").trim();
  const effectiveProvider = requested === "custom" && !tileUrlOverride ? "amap" : requested;
  const effectiveDefaults = MAP_PROVIDER_DEFAULTS[effectiveProvider];
  const tileUrl = tileUrlOverride && /^https:\/\//i.test(tileUrlOverride)
    ? tileUrlOverride
    : effectiveDefaults.tileUrl;
  return {
    provider: effectiveProvider,
    label: (env.MAP_LABEL || "").trim() || effectiveDefaults.label,
    tileUrl,
    subdomains: mapSubdomains(env.MAP_SUBDOMAINS, effectiveDefaults.subdomains),
    coordinateSystem: mapCoordinateSystem(env.MAP_COORDINATE_SYSTEM, effectiveDefaults.coordinateSystem),
    projection: mapProjection(env.MAP_PROJECTION, effectiveDefaults.projection),
    yAxis: mapYAxis(env.MAP_Y_AXIS, effectiveDefaults.yAxis),
    zoom: resolvePositiveInt(env.MAP_ZOOM, effectiveDefaults.zoom, 3, 18),
    tileSize: resolvePositiveInt(env.MAP_TILE_SIZE, effectiveDefaults.tileSize, 128, 512),
    staticMapAvailable: Boolean(staticMapKey(effectiveProvider, env)),
  };
}

export interface MapStaticServiceConfig {
  amapWebServiceKey: string;
  tencentWebServiceKey: string;
  baiduWebServiceKey: string;
}

/** 静态地图代理的服务端凭据；保留旧别名，公开配置只暴露当前 provider 是否可用。 */
export function resolveMapStaticServiceConfig(env: Record<string, string | undefined>): MapStaticServiceConfig {
  return {
    amapWebServiceKey: staticMapKey("amap", env),
    tencentWebServiceKey: staticMapKey("tencent", env),
    baiduWebServiceKey: staticMapKey("baidu", env),
  };
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
  /** 结论地图的原生瓦片配置；MAP_PROVIDER 决定高德/腾讯/百度/OSM/自定义。 */
  map: resolveMapRuntimeConfig(process.env),
  /** 高德静态地图代理的服务端 Key；不属于公开前端配置。 */
  mapStatic: resolveMapStaticServiceConfig(process.env),
} as {
  baseURL: string;
  apiKey: string;
  model: string;
  protocol: Protocol;
  reasoning: ReasoningSetting;
  modelRequestTimeoutMs: number;
  modelRequestRetries: number;
  map: MapRuntimeConfig;
  mapStatic: MapStaticServiceConfig;
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
