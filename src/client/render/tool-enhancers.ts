/**
 * render/tool-enhancers.ts — 工具卡增强渲染注册表
 * ============================================================
 * 通用消息渲染只认识事件协议，不直接 import 房产/知识库等业务实现。
 * 各业务在组合根 main.ts 注册自己的匹配器和渲染器，既保留专属卡片，
 * 又避免 render/* 与 views/* 形成反向依赖。
 */
import type { ToolPart } from "../modules/types.js";

type ToolEnhancer = {
  match: (part: ToolPart) => boolean;
  render: (part: ToolPart, card: HTMLElement) => void;
};

const enhancers: ToolEnhancer[] = [];

export function registerToolEnhancer(
  match: ToolEnhancer["match"],
  render: ToolEnhancer["render"],
): void {
  enhancers.push({ match, render });
}

/** 按注册顺序执行；单个增强失败不能阻止通用工具卡继续展示。 */
export function renderToolEnhancers(part: ToolPart, card: HTMLElement): void {
  for (const enhancer of enhancers) {
    if (!enhancer.match(part)) continue;
    try {
      enhancer.render(part, card);
    } catch {
      // 专属展示只是增强，失败时保留通用参数/结果区
    }
  }
}
