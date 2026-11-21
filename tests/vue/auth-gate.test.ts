/**
 * auth-login.test.ts — 登录门页组件与门页编排（M4 批次 4.0）
 * 覆盖：表单校验、提交事件、门页编排（登录成功 / 服务端错误 /
 * mustChangePassword 切改密页 / 改密后重登闭环）。fetch 全部打桩。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import AuthLogin from "../../src/client/views/auth-login.vue";
import AuthPassword from "../../src/client/views/auth-password.vue";

type FetchResponse = { status: number; json: () => Promise<unknown> };
type FetchMock = (input: string, init?: RequestInit) => FetchResponse;

function stubFetch(mock: FetchMock): void {
  const impl = (input: string, init?: RequestInit): Promise<FetchResponse> => Promise.resolve(mock(input, init));
  vi.stubGlobal("fetch", vi.fn(impl as unknown as typeof fetch));
}

function loginResponse(status: number, body: Record<string, unknown>): FetchResponse {
  return { status, json: () => Promise.resolve(body) };
}

beforeEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("AuthLogin 表单", () => {
  it("提交事件携带用户名与密码", async () => {
    const wrapper = mount(AuthLogin, { props: { busy: false, error: "", notice: "" } });
    await wrapper.find("#auth-username").setValue("alice");
    await wrapper.find("#auth-password").setValue("a-good-password");
    await wrapper.find("form").trigger("submit");
    const emitted = wrapper.emitted<{ username: string; password: string }[]>("submit");
    expect(emitted?.[0]?.[0]).toEqual({ username: "alice", password: "a-good-password" });
  });

  it("空用户名/密码本地拦截，不发提交事件", async () => {
    const wrapper = mount(AuthLogin, { props: { busy: false, error: "", notice: "" } });
    await wrapper.find("form").trigger("submit");
    expect(wrapper.emitted("submit")).toBeUndefined();
    expect(wrapper.text()).toContain("请输入用户名");
  });

  it("busy 时按钮禁用且文案切换", async () => {
    const wrapper = mount(AuthLogin, { props: { busy: true, error: "", notice: "" } });
    const button = wrapper.find("button[type=submit]");
    expect((button.element as HTMLButtonElement).disabled).toBe(true);
    expect(button.text()).toContain("登录中");
  });

  it("服务端错误经 error prop 以 role=alert 播报", () => {
    const wrapper = mount(AuthLogin, { props: { busy: false, error: "用户名或密码不正确", notice: "" } });
    const alert = wrapper.find('[role="alert"]');
    expect(alert.text()).toBe("用户名或密码不正确");
  });
});

describe("AuthPassword 表单", () => {
  it("新密码不足 10 位本地拦截", async () => {
    const wrapper = mount(AuthPassword, { props: { busy: false, error: "", notice: "" } });
    await wrapper.find("#auth-pass-next").setValue("short");
    await wrapper.find("#auth-pass-confirm").setValue("short");
    await wrapper.find("form").trigger("submit");
    expect(wrapper.emitted("submit")).toBeUndefined();
    expect(wrapper.text()).toContain("新密码至少 10 个字符");
  });

  it("两次不一致本地拦截", async () => {
    const wrapper = mount(AuthPassword, { props: { busy: false, error: "", notice: "" } });
    await wrapper.find("#auth-pass-next").setValue("a-good-password-1");
    await wrapper.find("#auth-pass-confirm").setValue("a-good-password-2");
    await wrapper.find("form").trigger("submit");
    expect(wrapper.text()).toContain("两次输入的新密码不一致");
  });

  it("合法输入发出提交事件（当前密码可为空 = 首设）", async () => {
    const wrapper = mount(AuthPassword, { props: { busy: false, error: "", notice: "" } });
    await wrapper.find("#auth-pass-next").setValue("a-good-password-1");
    await wrapper.find("#auth-pass-confirm").setValue("a-good-password-1");
    await wrapper.find("form").trigger("submit");
    const emitted = wrapper.emitted<{ currentPassword: string; newPassword: string }[]>("submit");
    expect(emitted?.[0]?.[0]).toEqual({ currentPassword: "", newPassword: "a-good-password-1" });
  });
});

describe("auth-gate 编排", () => {
  /** 等动态 import 完成、门页表单渲染出来 */
  async function waitForForm(selector: string): Promise<HTMLInputElement> {
    await vi.waitFor(() => expect(document.querySelector(selector)).toBeTruthy());
    return document.querySelector(selector) as HTMLInputElement;
  }

  function setInput(selector: string, value: string): void {
    const input = document.querySelector(selector) as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event("input"));
  }

  /** 驱动门页 DOM：填登录表单并提交（先等动态 import 渲染出表单） */
  async function submitLogin(username: string, password: string): Promise<void> {
    await waitForForm("#auth-username");
    setInput("#auth-username", username);
    setInput("#auth-password", password);
    document.querySelector("form")?.dispatchEvent(new Event("submit", { cancelable: true }));
  }

  it("登录成功且无强制改密 → 门页关闭", async () => {
    stubFetch(() => loginResponse(200, {
      ok: true,
      user: { displayName: "Alice", role: "admin", mustChangePassword: false },
    }));
    const { showLoginGate, isAuthGateOpen } = await import("../../src/client/apps/auth-gate.js");
    const done = showLoginGate();
    await submitLogin("alice", "a-good-password");
    await vi.waitFor(() => expect(isAuthGateOpen()).toBe(false));
    await done;
  });

  it("mustChangePassword → 切改密页 → 改密成功后自动重登并关闭", async () => {
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    stubFetch((input, init) => {
      const path = String(input);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ path, body });
      if (path === "/api/auth/login") {
        return loginResponse(200, {
          ok: true,
          user: { displayName: "Alice", role: "member", mustChangePassword: body.password === "temp-pass-123" },
        });
      }
      return loginResponse(200, { ok: true });
    });
    const { showLoginGate, isAuthGateOpen } = await import("../../src/client/apps/auth-gate.js");
    const done = showLoginGate();
    await submitLogin("alice", "temp-pass-123");
    // 强制改密页已切换：等表单渲染后填新密码并提交
    await waitForForm("#auth-pass-next");
    setInput("#auth-pass-next", "brand-new-pass-9");
    setInput("#auth-pass-confirm", "brand-new-pass-9");
    document.querySelector("form")?.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(isAuthGateOpen()).toBe(false));
    await done;
    expect(calls.map((c) => c.path)).toEqual(["/api/auth/login", "/api/auth/password", "/api/auth/login"]);
    expect(calls[1].body).toMatchObject({ currentPassword: "temp-pass-123", newPassword: "brand-new-pass-9" });
    expect(calls[2].body).toMatchObject({ username: "alice", password: "brand-new-pass-9" });
  });

  it("登录失败时错误回显且门页保持打开（不 resolve）", async () => {
    stubFetch(() => loginResponse(401, { error: "用户名或密码不正确" }));
    const { showLoginGate, isAuthGateOpen } = await import("../../src/client/apps/auth-gate.js");
    void showLoginGate();
    await submitLogin("alice", "wrong-pass-xxx");
    expect(isAuthGateOpen()).toBe(true);
    // Vue 响应式重渲染是异步的：等服务端错误播报出现
    await vi.waitFor(() => {
      const alert = document.querySelector(".auth-error");
      expect(alert?.textContent).toContain("用户名或密码不正确");
    });
  });
});
