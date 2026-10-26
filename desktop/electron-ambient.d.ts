/**
 * desktop/electron-ambient.d.ts — Electron 最小类型兜底
 * ============================================================
 * 为什么需要：electron 是 devDependency，`npm ci --ignore-scripts` 只跳过
 * 二进制下载，类型仍会装；但本地开发环境常常没装（或装了旧版），
 * 那时 `tsc -p tsconfig.desktop.json` 会因「找不到模块 electron」失败。
 *
 * 立场：只声明本项目实际用到的 API 表面（够严格检查我们自己的代码），
 * 一旦 node_modules 里存在真实的 electron.d.ts，TypeScript 会优先用官方的
 * （同名模块声明以实际模块解析结果为准），这里的兜底自动失效。
 */

declare module "electron" {
  export interface TitleBarOverlayOptions {
    color: string;
    symbolColor: string;
    height?: number;
  }

  export interface WebPreferences {
    contextIsolation?: boolean;
    nodeIntegration?: boolean;
    sandbox?: boolean;
    preload?: string;
  }

  export interface WindowOpenHandlerResponse {
    action: "allow" | "deny";
  }

  export class BrowserWindow {
    constructor(options?: Record<string, unknown>);
    static getAllWindows(): BrowserWindow[];
    loadURL(url: string): Promise<void>;
    show(): void;
    close(): void;
    focus(): void;
    isMinimized(): boolean;
    restore(): void;
    once(event: "ready-to-show", listener: () => void): void;
    on(event: "closed", listener: () => void): void;
    setTitleBarOverlay(options: TitleBarOverlayOptions): void;
    webContents: {
      setWindowOpenHandler(handler: (details: { url: string }) => WindowOpenHandlerResponse): void;
      openDevTools(options?: Record<string, unknown>): void;
    };
  }

  export interface IpcMain {
    handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
  }

  export const ipcMain: IpcMain;

  export interface Dialog {
    showErrorBox(title: string, content: string): void;
  }

  export const dialog: Dialog;

  export interface Shell {
    openExternal(url: string): Promise<void>;
  }

  export const shell: Shell;

  export interface App {
    quit(): void;
    requestSingleInstanceLock(): boolean;
    whenReady(): Promise<void>;
    on(event: string, listener: (...args: unknown[]) => void): void;
  }

  export const app: App;

  export interface ContextBridge {
    exposeInMainWorld(apiKey: string, api: Record<string, unknown>): void;
  }

  export const contextBridge: ContextBridge;

  export interface IpcRenderer {
    invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  }

  export const ipcRenderer: IpcRenderer;
}
