/**
 * ============================================================
 * server/build-info.ts — 服务端构建身份单一入口
 * ============================================================
 * 读取构建期生成的 build-info.json；探针、诊断、日志与版本接口共享同一份对象。
 */
import { readRuntimeBuildInfo } from "../versioning.js";

export const BUILD_INFO = readRuntimeBuildInfo();
export const RUNTIME_VERSION = BUILD_INFO.version;
