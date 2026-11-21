/**
 * ============================================================
 * projects.ts — 用户隔离的项目文件夹管理（本地 / 云端）
 * ============================================================
 * 文件模式把 userId 一并写入 .web-config.json；PostgreSQL 模式落到 projects 表。
 * 每次目录授权都绑定当前用户，成员只能浏览自己添加的项目，不能复用管理员路径。
 */
import { promises as fsp } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { resolve, basename, join } from "node:path";
import { PROJECT_ROOT, authorizeRoot, unauthorizeRoot } from "./files.js";
import { readConfig, mergeConfig } from "./config-store.js";
import { isPostgresBackend, withUserTransaction } from "./persistence/postgres.js";
import { runWithUserContext, userContextOrLocal } from "./user-context.js";

const run = promisify(execFile);
const CLOUD_DIR = join(PROJECT_ROOT, ".setting", "cloud");
const MAX_PROJECTS = 12;

export interface Project {
  id: string;
  userId: string;
  name: string;
  type: "local" | "cloud";
  path: string;
  url?: string;
  builtin?: boolean;
}

const projectsByUser = new Map<string, Project[]>();
const activeByUser = new Map<string, string>();
let fileLoaded = false;

function currentUserId(): string {
  return userContextOrLocal().userId;
}

function userProjects(userId = currentUserId()): Project[] {
  let list = projectsByUser.get(userId);
  if (!list) {
    list = [];
    projectsByUser.set(userId, list);
  }
  return list;
}

function activeProjectId(userId = currentUserId()): string {
  return activeByUser.get(userId) ?? "default";
}

async function persist(userId = currentUserId()): Promise<void> {
  if (isPostgresBackend()) {
    const list = userProjects(userId);
    await withUserTransaction(userId, async (client) => {
      await client.query("DELETE FROM projects WHERE user_id = $1 AND id <> 'default'", [userId]);
      for (const project of list) {
        await client.query(
          `INSERT INTO projects(user_id, id, name, type, path, url, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (user_id, id) DO UPDATE SET
             name = EXCLUDED.name, type = EXCLUDED.type, path = EXCLUDED.path,
             url = EXCLUDED.url, updated_at = EXCLUDED.updated_at`,
          [userId, project.id, project.name, project.type, project.path, project.url ?? null,
            Date.now(), Date.now()],
        );
      }
      await client.query(
        `INSERT INTO user_settings(user_id, settings, updated_at)
         VALUES ($1, jsonb_build_object('activeProjectId', $2), now())
         ON CONFLICT (user_id) DO UPDATE SET
           settings = jsonb_set(user_settings.settings, '{activeProjectId}', to_jsonb($2::text), true),
           updated_at = now()`,
        [userId, activeProjectId(userId)],
      );
    });
    return;
  }

  const projects = [...projectsByUser.values()].flat();
  const activeProjects = Object.fromEntries(activeByUser);
  await mergeConfig({ projects, activeProjects });
}

async function authorizeProject(project: Project): Promise<void> {
  await runWithUserContext({ userId: project.userId, deviceId: "project", role: "admin" }, async () => {
    authorizeRoot(project.path, project.name);
  });
}

export async function loadProjects(): Promise<void> {
  if (isPostgresBackend()) return;
  if (fileLoaded) return;
  fileLoaded = true;
  const saved = await readConfig();
  const savedList = Array.isArray(saved.projects) ? saved.projects as Array<Partial<Project>> : [];
  const fallbackUser = "local";
  for (const item of savedList) {
    if (!item || !item.id || typeof item.path !== "string" || (item.type !== "local" && item.type !== "cloud")) continue;
    if (item.id === "default") continue;
    const exists = await fsp.stat(item.path).then((s) => s.isDirectory()).catch(() => false);
    if (!exists) continue;
    // 反序列化边界：历史配置项的归属键是 ownerId（用户体系改造前），读出后归一到 userId。
    const legacy = item as Partial<Project> & { ownerId?: unknown };
    const userId = typeof item.userId === "string" && item.userId
      ? item.userId
      : (typeof legacy.ownerId === "string" && legacy.ownerId ? legacy.ownerId : fallbackUser);
    const project: Project = {
      id: item.id,
      userId,
      name: item.name || "未命名项目",
      type: item.type,
      path: resolve(item.path),
      ...(typeof item.url === "string" ? { url: item.url } : {}),
    };
    userProjects(userId).push(project);
    await authorizeProject(project);
  }
  const activeProjects = saved.activeProjects && typeof saved.activeProjects === "object"
    ? saved.activeProjects as Record<string, unknown>
    : {};
  for (const [userId, id] of Object.entries(activeProjects)) {
    if (typeof id === "string" && userProjects(userId).some((project) => project.id === id)) {
      activeByUser.set(userId, id);
    }
  }
  if (typeof saved.activeProjectId === "string" && userProjects(fallbackUser).some((project) => project.id === saved.activeProjectId)) {
    activeByUser.set(fallbackUser, saved.activeProjectId);
  }
}

/** PostgreSQL 模式按用户懒加载，不把全库项目列表读进进程。 */
export async function ensureProjectsLoaded(userId = currentUserId()): Promise<void> {
  if (!isPostgresBackend() || projectsByUser.has(userId)) return;
  const rows = await withUserTransaction(userId, (client) => client.query<{
    id: string; name: string; type: "local" | "cloud"; path: string; url: string | null;
  }>("SELECT id, name, type, path, url FROM projects WHERE user_id = $1 ORDER BY updated_at DESC", [userId]));
  const list: Project[] = [];
  for (const row of rows.rows) {
    const project: Project = {
      id: row.id, userId, name: row.name, type: row.type, path: resolve(row.path),
      ...(row.url ? { url: row.url } : {}),
    };
    list.push(project);
    await authorizeProject(project);
  }
  projectsByUser.set(userId, list);
  const settings = await withUserTransaction(userId, (client) => client.query<{ settings: { activeProjectId?: unknown } }>(
    "SELECT settings FROM user_settings WHERE user_id = $1", [userId],
  ));
  const active = settings.rows[0]?.settings?.activeProjectId;
  if (typeof active === "string" && list.some((project) => project.id === active)) activeByUser.set(userId, active);
}

export function listProjects(): Project[] {
  return userProjects();
}

export function getActiveProjectId(): string {
  return activeProjectId();
}

export function getProject(id: string): Project | undefined {
  return userProjects().find((project) => project.id === id);
}

export function setActiveProject(id: string): void {
  if (!userProjects().some((project) => project.id === id)) throw new Error("项目不存在");
  activeByUser.set(currentUserId(), id);
  void persist().catch(() => {});
}

function slugFromUrl(url: string): string {
  const tail = url.replace(/\.git$/, "").split(/[/:]/).filter(Boolean).pop() ?? "repo";
  return tail.replace(/[^\w.-]+/g, "-").slice(0, 48) || "repo";
}

export async function addProject(input: { name?: string; type?: string; path?: string; url?: string }): Promise<Project> {
  const userId = currentUserId();
  const list = userProjects(userId);
  if (list.length >= MAX_PROJECTS) throw new Error(`项目数量已达上限（${MAX_PROJECTS} 个）`);
  const type = input.type === "cloud" ? "cloud" : "local";

  if (type === "local") {
    if (!input.path?.trim()) throw new Error("请填写服务器上的文件夹绝对路径");
    const path = resolve(input.path.trim());
    const st = await fsp.stat(path).catch(() => { throw new Error("路径不存在"); });
    if (!st.isDirectory()) throw new Error("该路径不是文件夹");
    if (list.some((project) => resolve(project.path) === path)) throw new Error("该文件夹已添加过");
    const name = input.name?.trim() || basename(path) || path;
    const project: Project = { id: randomUUID(), userId, name, type: "local", path };
    list.push(project);
    authorizeRoot(path, name);
    await persist(userId);
    return project;
  }

  const url = input.url?.trim() ?? "";
  if (!/^(https?:\/\/\S+|git@[\w.-]+:\S+)$/.test(url)) {
    throw new Error("请填写合法的 Git 仓库地址（https://…/xxx.git 或 git@…）");
  }
  const name = input.name?.trim() || slugFromUrl(url);
  if (list.some((project) => project.url === url)) throw new Error("该仓库已添加过");
  const userCloudDir = join(CLOUD_DIR, userId.replace(/[^A-Za-z0-9_-]/g, "_"));
  await fsp.mkdir(userCloudDir, { recursive: true });
  const target = join(userCloudDir, `${name}-${randomUUID().slice(0, 6)}`);
  try {
    await run("git", ["clone", "--depth", "1", url, target], { timeout: 120_000 });
  } catch (err) {
    await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`git clone 失败（确认已安装 git、有网络与仓库权限）：${message.slice(0, 160)}`);
  }
  const project: Project = { id: randomUUID(), userId, name, type: "cloud", path: target, url };
  list.push(project);
  authorizeRoot(target, name);
  await persist(userId);
  return project;
}

export async function refreshCloudProject(id: string): Promise<Project> {
  const project = getProjectChecked(id);
  if (project.type !== "cloud") throw new Error("只有云端项目支持刷新（本地目录即最新）");
  await run("git", ["-C", project.path, "pull", "--ff-only"], { timeout: 120_000 });
  return project;
}

export async function deleteProject(id: string): Promise<void> {
  const userId = currentUserId();
  const project = getProjectChecked(id);
  if (project.builtin) throw new Error("内置项目（本仓库）不可删除");
  unauthorizeRoot(project.path);
  if (project.type === "cloud") await fsp.rm(project.path, { recursive: true, force: true }).catch(() => {});
  projectsByUser.set(userId, userProjects(userId).filter((item) => item.id !== id));
  if (activeProjectId(userId) === id) activeByUser.set(userId, "default");
  await persist(userId);
}

function getProjectChecked(id: string): Project {
  const project = getProject(id);
  if (!project) throw new Error("项目不存在");
  return project;
}