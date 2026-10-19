/**
 * desktop/preload.cjs — 渲染进程最小桥
 * ============================================================
 * 只暴露两样东西：桌面端标记（前端据此加拖拽区/让位 CSS）+ 集合窗口
 * 控制键主题的 IPC（应用换肤时同步 titleBarOverlay 配色）。
 * sandbox:true 下 preload 只能 require 电子的白名单模块，contextBridge 正是其一。
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktop", {
  isElectron: true,
  /** dark=true → 深色控制键；主进程在非 Windows / 不支持时静默 false */
  setOverlayTheme: (dark) => {
    try { return ipcRenderer.invoke("desktop:overlay-theme", Boolean(dark)); }
    catch { return Promise.resolve(false); }
  },
});
