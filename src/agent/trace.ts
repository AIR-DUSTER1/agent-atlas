/**
 * ============================================================
 * agent/trace.ts — LangSmith 链路追踪工厂与上报前脱敏
 * ============================================================
 * 职责：把服务端解析好的追踪配置转成 LangChain callback，并在 Client 边界
 * 脱敏手机号、身份证、银行卡和常见凭据；本模块不读取 server/client 配置。
 *
 * 设计立场：
 *  - 默认关闭，且关闭路径不加载 langsmith 运行时模块；
 *  - tracer 构造失败只返回 warning，不把主任务挂死；
 *  - endpoint 在进入官方 client 前做 HTTPS / userinfo / 内网地址校验。
 */
import type { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { TraceRuntimeConfig } from "../config.js";

/** LangSmith 官方 API 默认地址；仅作为配置缺省提示，最终值来自运行中配置。 */
export const DEFAULT_LANGSMITH_ENDPOINT = "https://api.smith.langchain.com";
/** 单批上报超时；真正的 run 仍由官方 client 异步批量发送。 */
export const LANGSMITH_REPORT_TIMEOUT_MS = 10_000;
/** LangSmith UI 中默认项目名。 */
export const DEFAULT_LANGSMITH_PROJECT = "agentatlas";

export interface TraceRedactionRule {
  pattern: RegExp;
  replace: string;
}

/**
 * 自定义 PII 规则；官方 `createSecretAnonymizer` 会先应用内置凭据规则，
 * 再按这里的顺序应用手机号、身份证和银行卡规则。
 */
export const TRACE_REDACTION_RULES: TraceRedactionRule[] = [
  { pattern: /(?<![A-Za-z0-9])1[3-9]\d{9}(?![A-Za-z0-9])/g, replace: "<phone>" },
  { pattern: /(?<![A-Za-z0-9])\d{17}[\dXx](?![A-Za-z0-9])/g, replace: "<id-card>" },
  { pattern: /(?<![A-Za-z0-9])\d{16,19}(?![A-Za-z0-9])/g, replace: "<card>" },
];

export interface TraceActivation {
  callbacks: BaseCallbackHandler[];
  /** 仅在后端已开启但无法安全构造 tracer 时返回，供调用方走结构化告警。 */
  warning?: string;
}

export interface TraceMetadata extends Record<string, string> {
  sessionId: string;
  profileId: string;
  agent_id: string;
  agent_environment: string;
}

/**
 * 构造 trace callback。动态 import 保证 off 路径不会加载 langsmith；
 * 该函数只负责观测旁路，调用方不得把 warning 当成主任务失败。
 */
export async function createTraceCallbacks(settings: TraceRuntimeConfig): Promise<TraceActivation> {
  if (settings.backend !== "langsmith") return { callbacks: [] };

  const apiKey = settings.apiKey.trim();
  if (!apiKey) {
    return { callbacks: [], warning: "已选择 LangSmith，但未配置 API Key；追踪保持关闭" };
  }

  const endpointError = validateTraceEndpoint(settings.endpoint);
  if (endpointError) return { callbacks: [], warning: endpointError };

  try {
    const [{ Client }, { createSecretAnonymizer }, { LangChainTracer }] = await Promise.all([
      import("langsmith/client"),
      import("langsmith/anonymizer"),
      import("@langchain/core/tracers/tracer_langchain"),
    ]);
    const anonymizer = settings.anonymize
      ? createSecretAnonymizer({ extraRules: TRACE_REDACTION_RULES })
      : undefined;
    const client = new Client({
      apiKey,
      apiUrl: settings.endpoint,
      timeout_ms: LANGSMITH_REPORT_TIMEOUT_MS,
      ...(anonymizer ? { anonymizer } : {}),
    });
    const tracer = new LangChainTracer({
      client,
      projectName: settings.project.trim() || DEFAULT_LANGSMITH_PROJECT,
      metadata: {
        agent_id: settings.agentId,
        agent_environment: settings.agentEnvironment,
      },
    });
    return { callbacks: [tracer] };
  } catch {
    // 不把 SDK 异常原文写日志：异常可能包含 endpoint/请求上下文，而 trace 是旁路能力。
    return {
      callbacks: [],
      warning: "LangSmith tracer 初始化失败，已跳过追踪；请检查 API Key、endpoint 与网络",
    };
  }
}

/** metadata 只放内部标识，不放 prompt、正文、用户资料或 API Key。 */
/** 纯函数版本，供单测和调用方核对脱敏规则；真实上报仍由 LangSmith anonymizer 执行。 */
export function redactTraceText(text: string): string {
  return TRACE_REDACTION_RULES.reduce((value, rule) => value.replace(rule.pattern, rule.replace), text);
}

export function buildTraceMetadata(
  sessionId: string,
  profileId: string,
  agentId = "agentatlas",
  agentEnvironment = "local",
): TraceMetadata {
  return {
    sessionId: sessionId.slice(0, 200),
    profileId: profileId.slice(0, 80),
    agent_id: agentId.slice(0, 120),
    agent_environment: agentEnvironment.slice(0, 80),
  };
}

/** 校验 endpoint：必须 HTTPS、无 userinfo，且不能是 loopback / 私有 IP 字面量。 */
export function validateTraceEndpoint(raw: string): string | null {
  const value = raw.trim();
  if (!value) return "LangSmith Endpoint 不能为空";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "LangSmith Endpoint 必须是完整 URL，例如 https://api.smith.langchain.com";
  }
  if (url.protocol !== "https:") return "LangSmith Endpoint 必须使用 https";
  if (url.username || url.password) return "LangSmith Endpoint 不能包含用户名或密码";
  if (isPrivateHostname(url.hostname)) {
    return "LangSmith Endpoint 不能指向 localhost、环回或私有内网地址；请使用可受控的公网 HTTPS 端点";
  }
  return null;
}

/** 仅用于 endpoint 校验，不涉及 DNS 解析；避免把可疑字面量交给官方 client。 */
function isPrivateHostname(rawHostname: string): boolean {
  const host = rawHostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host === "0.0.0.0" || host === "::1") return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  if (/^(fc|fd|fe80)/.test(host)) return true;
  return false;
}