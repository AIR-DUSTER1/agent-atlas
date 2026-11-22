/**
 * ============================================================
 * views/settings-users.ts — 用户管理分区装载入口（M4 批次 4.2 起）
 * ============================================================
 * 用户管理四卡与本地密码锁卡已迁往 Vue（settings-users-vue.vue +
 * stores/users.ts）；本文件只保留 legacy 侧职责：
 *  1. 分区懒加载入口 refreshUsers（探测后端形态 + 隐藏非 admin 的导航项）；
 *  2. 非 admin 的 pg 用户直开 URL 时回 models 分区（调用方依据返回值）。
 * Vue 面板与 store 都经动态 import 进入（1:1 过渡树静态图不得出现 .vue
 * 与裸包名 vue/pinia），本模块静态依赖图保持纯 .ts。
 */

/**
 * 进入 users 分区：store.init() 探测形态并拉数据；返回 false 表示
 * pg 且非 admin（导航项已隐藏，调用方应回退到默认分区）。
 */
export async function refreshUsers(): Promise<boolean> {
  void import("./settings-users-vue.js")
    .then((m) => m.mountUsersVue())
    .catch(() => {});
  const { useUsersStore } = await import("../../../stores/settings/users/users.js");
  const store = useUsersStore();
  await store.init();
  const isPg = store.mode === "postgres";
  const isAdmin = store.isAdmin;
  // 分区入口对「pg 且非 admin」隐藏（壳级 DOM，组件管不到导航）
  const navItem = document.querySelector<HTMLElement>(".settings-nav-item[data-settings-view='users']");
  navItem?.classList.toggle("hidden", isPg && !isAdmin);
  if (isPg && !isAdmin) return false;
  return true;
}
