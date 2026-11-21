/**
 * ============================================================
 * apps/auth-gate.ts — 认证门页公共入口（框架迁移 M4 批次 4.0）
 * ============================================================
 * 对外只暴露 showLoginGate / showForceChangeGate / isAuthGateOpen；
 * Vue 挂载与流程编排全部在 auth-gate-mount.ts，并以**动态 import** 进入：
 * 1:1 树（tsc，过渡期 e2e 用）的静态依赖图里不能出现 .vue——tsc 不产 .vue
 * 文件，静态链会在浏览器 404。bundle 世界里该动态 import 由 Vite 分块打包。
 */
export async function showLoginGate(notice = ""): Promise<void> {
  const { mountLoginGate } = await import("./auth-gate-mount.js");
  await mountLoginGate(notice);
}

export async function showForceChangeGate(notice = "首次登录或密码已被重置，必须先修改密码"): Promise<void> {
  const { mountForceChangeGate } = await import("./auth-gate-mount.js");
  await mountForceChangeGate(notice);
}

/** 门页是否打开：直接看挂载容器（无共享模块状态，兼容 1:1 副本世界）。 */
export function isAuthGateOpen(): boolean {
  return document.getElementById("auth-gate-root") !== null;
}
