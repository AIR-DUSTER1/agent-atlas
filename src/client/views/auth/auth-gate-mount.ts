/**
 * ============================================================
 * apps/auth-gate-mount.ts — 认证门页挂载与流程编排（M4 批次 4.0）
 * ============================================================
 * 只被 auth-gate.ts 动态 import（bundle 世界）。职责：Vue 局部挂载承载
 * 登录门页 / 强制改密页，表单 fetch 都在这里；SFC 是哑表单。
 *
 * 流程（login 模式）：登录成功 → mustChangePassword 则切改密页 → 改密成功
 * （服务端已吊销全部会话）→ 用缓存凭据自动重登 → resolve。
 * 流程（force 模式）：已登录但 403 password_change_required → 直接改密 → resolve。
 *
 * 设计立场：gate 打开期间 legacy 应用驻留内存但 inert 不可交互；完成后卸载
 * 并恢复焦点（不刷新页面，保留发起请求的调用栈续跑）。
 */
import { createApp, h, reactive, type App as VueApp } from "vue";
import AuthLogin from "./auth-login.vue";
import AuthPassword from "./auth-password.vue";

type GateMode = "login" | "force";

interface GateState {
  mode: GateMode;
  busy: boolean;
  error: string;
  notice: string;
  /** 登录成功时的凭据缓存：改密成功后用新密码自动重登 */
  credentials: { username: string; password: string } | null;
  /** 登录后进入的强制改密：改密成功要用缓存凭据自动重登（区别于 force 直入模式） */
  pendingRelogin: boolean;
}

let gate: {
  host: HTMLElement;
  app: VueApp;
  state: GateState;
  previousFocus: HTMLElement | null;
} | null = null;

async function postJson(path: string, body: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({})) as Record<string, unknown>;
  return { status: res.status, data };
}

function mountGate(mode: GateMode, notice: string, resolve: () => void): void {
  const host = document.createElement("div");
  host.id = "auth-gate-root";
  document.body.appendChild(host);

  const appRoot = document.getElementById("app");
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (appRoot) {
    appRoot.setAttribute("aria-hidden", "true");
    if ("inert" in HTMLElement.prototype) appRoot.setAttribute("inert", "");
  }
  document.body.classList.add("auth-gate-open");

  const state = reactive<GateState>({ mode, busy: false, error: "", notice, credentials: null, pendingRelogin: false });

  function finish(): void {
    unmountGate();
    resolve();
  }

  const RootComponent = {
    setup() {
      const runLogin = async (username: string, password: string): Promise<void> => {
        state.busy = true;
        state.error = "";
        const { status, data } = await postJson("/api/auth/login", { username, password });
        state.busy = false;
        if (status !== 200) {
          state.error = (data.error as string) || `登录失败（HTTP ${status}）`;
          return;
        }
        const user = data.user as { mustChangePassword?: boolean } | undefined;
        state.credentials = { username, password };
        if (user?.mustChangePassword) {
          state.mode = "force";
          state.pendingRelogin = true;
          state.notice = "首次登录或密码已被重置，请设置新密码";
          return;
        }
        finish();
      };

      const runPasswordChange = async (currentPassword: string, newPassword: string): Promise<void> => {
        state.busy = true;
        state.error = "";
        const { status, data } = await postJson("/api/auth/password", { currentPassword, newPassword });
        state.busy = false;
        if (status !== 200) {
          state.error = (data.error as string) || `修改密码失败（HTTP ${status}）`;
          return;
        }
        // 改密已吊销全部会话：登录后进入的改密用缓存凭据自动重登；force 直入模式交回调用方重试
        if (state.pendingRelogin && state.credentials) {
          state.pendingRelogin = false;
          void runLogin(state.credentials.username, newPassword);
          return;
        }
        finish();
      };

      return () => {
        if (state.mode === "login") {
          return h(AuthLogin, {
            busy: state.busy,
            error: state.error,
            notice: state.notice,
            onSubmit: (payload: { username: string; password: string }) => { void runLogin(payload.username, payload.password); },
          });
        }
        return h(AuthPassword, {
          busy: state.busy,
          error: state.error,
          notice: state.notice,
          currentValue: state.credentials?.password ?? "",
          onSubmit: (payload: { currentPassword: string; newPassword: string }) => { void runPasswordChange(payload.currentPassword, payload.newPassword); },
        });
      };
    },
  };

  const app: VueApp = createApp(RootComponent);
  app.mount(host);
  gate = { host, app, state, previousFocus };
}

function unmountGate(): void {
  if (!gate) return;
  gate.app.unmount();
  gate.host.remove();
  const appRoot = document.getElementById("app");
  if (appRoot) {
    appRoot.removeAttribute("aria-hidden");
    appRoot.removeAttribute("inert");
  }
  document.body.classList.remove("auth-gate-open");
  gate.previousFocus?.focus();
  gate = null;
}

/** 展示登录门页并完成「登录 →（必要时）强制改密 → 重登」闭环；成功后 resolve。 */
export function mountLoginGate(notice = ""): Promise<void> {
  if (gate) return Promise.resolve();
  return new Promise((resolve) => {
    mountGate("login", notice, resolve);
  });
}

/** 已登录但收到 403 password_change_required 时的强制改密门页；改完 resolve。 */
export function mountForceChangeGate(notice = "首次登录或密码已被重置，必须先修改密码"): Promise<void> {
  if (gate) return Promise.resolve();
  return new Promise((resolve) => {
    mountGate("force", notice, resolve);
  });
}
