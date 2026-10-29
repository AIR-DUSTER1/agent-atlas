/**
 * registry.ts — Memory Provider 注册与激活
 * ============================================================
 * 只管理 Provider 实例与 active id，不执行检索或降级策略（那是 slot 的职责）。
 * 同一 id 默认禁止重复注册；配置更新用 replace:true 显式替换，避免隐式覆盖。
 */
import type { MemoryProvider, MemoryProviderId } from "./provider.js";

const providers = new Map<MemoryProviderId, MemoryProvider>();
let activeId: MemoryProviderId | null = null;

export function registerMemoryProvider(
  provider: MemoryProvider,
  options: { replace?: boolean; activate?: boolean } = {}
): void {
  if (providers.has(provider.id) && !options.replace) {
    throw new Error(`记忆 Provider「${provider.id}」已注册`);
  }
  providers.set(provider.id, provider);
  if (options.activate || activeId === null) activeId = provider.id;
}

export function activateMemoryProvider(id: MemoryProviderId): void {
  if (!providers.has(id)) throw new Error(`记忆 Provider「${id}」未注册`);
  activeId = id;
}

export function getActiveMemoryProvider(): MemoryProvider {
  if (activeId === null) throw new Error("没有可用的记忆 Provider");
  const provider = providers.get(activeId);
  if (!provider) throw new Error(`记忆 Provider「${activeId}」未注册`);
  return provider;
}

export function getMemoryProvider(id: MemoryProviderId): MemoryProvider | null {
  return providers.get(id) ?? null;
}

export function activeMemoryProviderId(): MemoryProviderId | null {
  return activeId;
}

export function registeredMemoryProviders(): Array<{
  id: MemoryProviderId;
  active: boolean;
  capabilities: MemoryProvider["capabilities"];
}> {
  return [...providers.values()].map((provider) => ({
    id: provider.id,
    active: provider.id === activeId,
    capabilities: { ...provider.capabilities },
  }));
}

/** 测试/重配专用：清空注册表，不触碰任何 Provider 的内部数据。 */
export function resetMemoryRegistryForTests(): void {
  providers.clear();
  activeId = null;
}
