/**
 * ============================================================
 * server/plugin-settings.ts — 内置插件启停的持久化边界
 * ============================================================
 * .web-config.json 的 plugins.enabled 是唯一落盘位置；本模块负责读取、
 * 校验并写入运行时状态。Agent 层只读 plugin-state.ts，不直接碰配置文件。
 */
import { readConfig, mergeConfig } from "./config-store.js";
import { writeAudit } from "./audit.js";
import {
  DEFAULT_PLUGIN_ENABLED,
  PLUGIN_IDS,
  getPluginEnabledSnapshot,
  isPluginId,
  isPluginSupported,
  setPluginEnabledState,
  type PluginEnabledMap,
} from "../plugin-state.js";

export interface PluginSettingsSnapshot {
  /** 让前端能把「仅 Windows」类能力与启停状态分开显示。 */
  platform: NodeJS.Platform;
  enabled: PluginEnabledMap;
}

function normalizeSavedEnabled(raw: unknown): PluginEnabledMap {
  const next: PluginEnabledMap = { ...DEFAULT_PLUGIN_ENABLED };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return next;
  const saved = raw as Record<string, unknown>;
  for (const id of PLUGIN_IDS) {
    if (typeof saved[id] === "boolean") next[id] = saved[id];
  }
  return next;
}

/** 启动时读取一次；字段缺失或旧版本配置保持兼容默认值。 */
export async function loadPluginSettings(): Promise<void> {
  const stored = await readConfig();
  const plugins = stored.plugins && typeof stored.plugins === "object" && !Array.isArray(stored.plugins)
    ? (stored.plugins as Record<string, unknown>)
    : {};
  setPluginEnabledState(normalizeSavedEnabled(plugins.enabled));
}

export function getPluginSettings(): PluginSettingsSnapshot {
  return {
    platform: process.platform,
    enabled: getPluginEnabledSnapshot(),
  };
}

let writeQueue: Promise<void> = Promise.resolve();

/**
 * 先落盘再更新内存：写盘失败时当前运行状态不变，避免 UI 显示已切换
 * 而实际工具装配仍使用旧状态。
 */
export function setPluginEnabled(id: unknown, value: unknown): Promise<PluginSettingsSnapshot> {
  if (!isPluginId(id)) return Promise.reject(new Error(`未知插件：${String(id)}`));
  if (typeof value !== "boolean") return Promise.reject(new Error("enabled 必须是布尔值"));
  if (id === "computer" && value && !isPluginSupported(id)) {
    return Promise.reject(new Error("Computer Use 仅支持 Windows 桌面环境"));
  }

  // 串行化读-改-写：两个插件并发切换时不能互相覆盖。
  const run = writeQueue.then(async () => {
    const next = { ...getPluginEnabledSnapshot(), [id]: value } as PluginEnabledMap;
    await mergeConfig({ plugins: { enabled: next } });
    setPluginEnabledState(next);
    writeAudit("plugin.toggled", { id, enabled: value });
  });
  writeQueue = run.catch(() => {}); // 一次失败不能卡死后续切换
  return run.then(() => getPluginSettings());
}
