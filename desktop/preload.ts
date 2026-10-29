/**
 * ============================================================
 * desktop/preload.ts — 渲染进程最小桥（编译为 .cjs）
 * ============================================================
 * 只暴露少量能力：桌面端标记、窗口控制键主题、系统目录选择框。
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
  /** 打开 Electron 原生目录选择框；取消时返回 { canceled: true }。 */
  pickDirectory: (): Promise<{ canceled: boolean; path?: string; error?: string }> => {
    try {
      return ipcRenderer.invoke("desktop:pick-directory") as Promise<{ canceled: boolean; path?: string; error?: string }>;
    } catch {
      return Promise.resolve({ canceled: true, error: "Electron 原生目录选择桥不可用" });
    }
  },
});
