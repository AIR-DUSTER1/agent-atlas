/**
 * ============================================================
 * stores/users.ts — 用户管理（框架迁移 M4 批次 4.2）
 * ============================================================
 * 职责：账号与安全分区的业务状态与写回（pg 用户管理四卡 / file 密码锁卡）。
 * 设计立场：
 *  - 临时密码 / 新令牌只展示一次，store 不留存明文（调用方直接拿返回值）；
 *  - mode 由 /api/auth/me 决定；分区入口对「pg 且非 admin」隐藏（壳侧处理）。
 */
import { defineStore } from "pinia";
import { api, postJson } from "../core/api.js";
import "./pinia.js";

export interface ManagedUser {
  userId: string;
  username: string | null;
  displayName: string;
  role: "admin" | "member";
  status: "active" | "disabled";
  mustChangePassword: boolean;
  hasPassword: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface UserTokenRow {
  id: string;
  label: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export const useUsersStore = defineStore("users", {
  state: () => ({
    /** "" = 尚未探测；"postgres" = 多用户；"file" = 单用户。 */
    mode: "" as "" | "postgres" | "file",
    isAdmin: false,
    users: [] as ManagedUser[],
    tokens: [] as UserTokenRow[],
    tokenUserId: "",
    lockEnabled: false,
  }),
  actions: {
    /** 每次进入分区调用：探测后端形态并拉取对应数据。 */
    async init(): Promise<void> {
      const me = await api<{ role?: string; backend?: string }>("/api/auth/me").catch(() => null);
      const isPg = me?.backend === "postgres";
      this.mode = isPg ? "postgres" : "file";
      this.isAdmin = isPg && me?.role === "admin";
      if (isPg) {
        if (!this.isAdmin) return;
        await this.refreshUsers();
      } else {
        await this.refreshLocalLock();
      }
    },
    async refreshUsers(): Promise<void> {
      const data = await api<{ users: ManagedUser[] }>("/api/users");
      this.users = data.users;
    },
    async createUser(payload: { username: string; displayName: string; password: string; role: string }): Promise<void> {
      await postJson("/api/users", payload);
      await this.refreshUsers();
    },
    async setUserStatus(user: ManagedUser, status: "active" | "disabled"): Promise<void> {
      await api(`/api/users/${user.userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      await this.refreshUsers();
    },
    /** 生成一次性临时密码；只在这里返回一次。 */
    async resetPassword(user: ManagedUser): Promise<string> {
      const data = await postJson<{ tempPassword: string }>(`/api/users/${user.userId}/reset-password`, {});
      return data.tempPassword;
    },
    async deleteUser(user: ManagedUser): Promise<void> {
      await api(`/api/users/${user.userId}`, { method: "DELETE" });
      await this.refreshUsers();
    },
    async loadTokens(userId: string): Promise<void> {
      const data = await api<{ tokens: UserTokenRow[] }>(`/api/users/${userId}/tokens`);
      this.tokens = data.tokens;
      this.tokenUserId = userId;
    },
    /** 生成访问令牌；只在这里返回一次。 */
    async createToken(payload: { label: string; expiresInDays?: number }): Promise<string> {
      const data = await postJson<{ token: string }>(`/api/users/${this.tokenUserId}/tokens`, payload);
      await this.loadTokens(this.tokenUserId);
      return data.token;
    },
    async revokeToken(tokenId: string): Promise<void> {
      await api(`/api/users/${this.tokenUserId}/tokens/${tokenId}`, { method: "DELETE" });
      await this.loadTokens(this.tokenUserId);
    },
    async refreshLocalLock(): Promise<void> {
      const state = await api<{ enabled: boolean }>("/api/auth/local-lock");
      this.lockEnabled = state.enabled;
    },
    async setLock(currentPassword: string, newPassword: string): Promise<void> {
      await postJson("/api/auth/local-lock", { currentPassword, newPassword });
      await this.refreshLocalLock();
    },
    async clearLock(currentPassword: string): Promise<void> {
      await api("/api/auth/local-lock", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword }),
      });
      await this.refreshLocalLock();
    },
  },
});
