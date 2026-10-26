/**
 * ============================================================
 * desktop/preload.ts — 渲染进程最小桥（编译为 .cjs）
 * ============================================================
 * 只暴露两样东西：桌面端标记（前端据此加拖拽区/让位 CSS）+ 设置窗口
 * 控制键主题的 IPC（应用换肤时同步 titleBarOverlay 配色）。
 * 为什么必须是 CJS：sandbox:true 下 preload 只能 require 电子白名单模块，
 * 不支持 ESM —— 构建时单独编译成 preload.cjs。
 */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("desktop", {
  isElectron: true,
  /** dark=true → 深色控制键；主进程在非 Windows / 不支持时静默返回 false */
  setOverlayTheme: (dark: boolean): Promise<boolean> => {
    try { return ipcRenderer.invoke("desktop:overlay-theme", Boolean(dark)) as Promise<boolean>; }
    catch { return Promise.resolve(false); }
  },
});
