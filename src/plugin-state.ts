/**
 * ============================================================
 * plugin-state.ts — 内置插件的运行时启停状态
 * ============================================================
 * 职责：给 Agent 工具装配提供唯一的「这个插件当前是否启用」判断。
 * 设计立场：
 *  - 本模块不读文件、不依赖 server/*，因此 Agent 层可以安全引用；
 *  - 持久化由 server/plugin-settings.ts 负责，启动时把配置加载进这里；
 *  - 电脑控制默认关闭：它是本机高权限能力，必须由用户在设置中显式开启。
 */

export const PLUGIN_IDS = ["rag", "estate", "computer"] as const;
export type PluginId = (typeof PLUGIN_IDS)[number];
export type PluginEnabledMap = Record<PluginId, boolean>;

/** 旧配置没有 plugins 字段时使用的兼容默认值。 */
export const DEFAULT_PLUGIN_ENABLED: Readonly<PluginEnabledMap> = Object.freeze({
  rag: true,
  estate: true,
  computer: false,
});

let enabled: PluginEnabledMap = { ...DEFAULT_PLUGIN_ENABLED };

export function isPluginId(value: unknown): value is PluginId {
  return typeof value === "string" && (PLUGIN_IDS as readonly string[]).includes(value);
}

/** Computer Use 依赖 Windows PowerShell / User32；其他平台即使旧配置写 true 也不得生效。 */
export function isPluginSupported(id: PluginId, platform: NodeJS.Platform = process.platform): boolean {
  return id !== "computer" || platform === "win32";
}

export function isPluginEnabled(id: PluginId): boolean {
  return enabled[id] && isPluginSupported(id);
}

export function getPluginEnabledSnapshot(): PluginEnabledMap {
  return { ...enabled };
}

/** 只接受已知 id 的布尔值；未知字段由调用方负责拒绝。 */
export function setPluginEnabledState(next: Partial<Record<PluginId, boolean>>): void {
  for (const id of PLUGIN_IDS) {
    if (typeof next[id] === "boolean") enabled[id] = next[id] && isPluginSupported(id);
  }
}

/** 测试隔离用：恢复到无配置文件的默认状态。 */
export function resetPluginStateForTests(): void {
  enabled = { ...DEFAULT_PLUGIN_ENABLED };
}
