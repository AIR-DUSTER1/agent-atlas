/**
 * ============================================================
 * stores/pinia.ts — 共享 Pinia 实例（框架迁移 M4 批次 4.1）
 * ============================================================
 * 过渡期每个 Vue 面板都是独立的 createApp 挂载（挂在既有 h() 页面的
 * 容器里）；必须共用同一个 Pinia 实例，否则不同 app 拿到的 store 是
 * 两份互不相通的状态。setActivePinia 让 legacy 侧（面板装载入口、
 * 懒加载钩子）在组件 setup 之外也能直接 useStore。
 * 4.5 壳反转后整个应用单 app，本文件随之简化。
 */
import { createPinia, setActivePinia } from "pinia";

export const pinia = createPinia();
setActivePinia(pinia);
