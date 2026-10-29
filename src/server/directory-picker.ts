/**
 * ============================================================
 * directory-picker.ts — 本机系统目录选择框
 * ============================================================
 * 浏览器拿不到本地绝对路径，项目授权又必须使用服务器可见路径，因此 Web 模式
 * 由本机服务端打开原生目录选择框。Electron 优先走 preload 的原生 dialog；
 * 这里负责没有 Electron 桥时的系统级兜底。
 *
 * 约束：
 *  - 弹出窗口可能一直等待用户，必须有超时并限制同一时间只开一个；
 *  - 命令参数全部固定生成，不接收网页传入的 title/path，避免命令注入；
 *  - 无桌面会话（容器 / SSH）返回中文错误，由前端显式降级到手动输入。
 */
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const PICK_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT_BYTES = 16_384;
const TITLE = "选择要添加的本地项目文件夹";

export interface DirectoryPickerResult {
  canceled: boolean;
  path?: string;
}

interface ExecFailure extends Error {
  code?: string | number;
  signal?: string;
  stderr?: string;
  killed?: boolean;
}

let activePicker: Promise<DirectoryPickerResult> | null = null;

/** Windows 使用 WinForms 自带目录选择器；脚本经 Base64 传给 PowerShell，不经过 shell 拼接。 */
export function buildWindowsPickerScript(): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "Add-Type -AssemblyName System.Windows.Forms",
    "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
    `$dialog.Description = '${TITLE}'`,
    "$dialog.ShowNewFolderButton = $true",
    "if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { exit 2 }",
    "[Console]::Out.Write($dialog.SelectedPath)",
  ].join("\n");
}

function failureText(err: unknown): string {
  const e = err as ExecFailure;
  return `${e.stderr ?? ""}\n${e.message ?? String(err)}`.trim().slice(0, 1_000);
}

/** 各平台取消选择时返回的退出码/提示不同，统一识别为正常取消。 */
export function isDirectoryPickerCancel(
  err: unknown,
  platform: NodeJS.Platform = process.platform
): boolean {
  const e = err as ExecFailure;
  if (e?.code === 2 || e?.code === "2") return true;
  // zenity / kdialog / osascript 都用退出码 1 表示用户取消；
  // Windows PowerShell 的 1 仍可能是脚本异常，不能一并吞掉。
  if (platform !== "win32" && (e?.code === 1 || e?.code === "1")) return true;
  return /cancel(?:led|ed)?|用户取消|已取消|-128/i.test(failureText(err));
}

async function runCommand(command: string, args: string[]): Promise<string> {
  const { stdout } = await run(command, args, {
    encoding: "utf8",
    timeout: PICK_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  return stdout.trim();
}

async function pickOnWindows(): Promise<DirectoryPickerResult> {
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const command = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const encoded = Buffer.from(buildWindowsPickerScript(), "utf16le").toString("base64");
  try {
    const selected = await runCommand(command, ["-NoLogo", "-NoProfile", "-STA", "-EncodedCommand", encoded]);
    return selected ? { canceled: false, path: selected } : { canceled: true };
  } catch (err) {
    if (isDirectoryPickerCancel(err)) return { canceled: true };
    throw new Error(`无法打开系统目录选择框：${failureText(err)}`);
  }
}

async function pickOnMac(): Promise<DirectoryPickerResult> {
  try {
    const selected = await runCommand("/usr/bin/osascript", [
      "-e", `POSIX path of (choose folder with prompt "${TITLE}")`,
    ]);
    return selected ? { canceled: false, path: selected } : { canceled: true };
  } catch (err) {
    if (isDirectoryPickerCancel(err)) return { canceled: true };
    throw new Error(`无法打开系统目录选择框：${failureText(err)}`);
  }
}

async function pickOnLinux(): Promise<DirectoryPickerResult> {
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    throw new Error("当前服务没有桌面会话，无法打开系统目录选择框；请手动输入服务器绝对路径");
  }
  const candidates = [
    { command: "zenity", args: ["--file-selection", "--directory", `--title=${TITLE}`] },
    { command: "kdialog", args: ["--getexistingdirectory", process.cwd()] },
  ];
  for (const candidate of candidates) {
    try {
      const selected = await runCommand(candidate.command, candidate.args);
      return selected ? { canceled: false, path: selected } : { canceled: true };
    } catch (err) {
      const code = (err as ExecFailure).code;
      if (code === "ENOENT") continue;
      if (isDirectoryPickerCancel(err)) return { canceled: true };
      throw new Error(`无法打开系统目录选择框：${failureText(err)}`);
    }
  }
  throw new Error("未找到 zenity 或 kdialog，无法打开系统目录选择框；请手动输入服务器绝对路径");
}

export async function pickDirectory(): Promise<DirectoryPickerResult> {
  if (activePicker) throw new Error("系统目录选择框已经打开，请先完成当前选择");
  const task = process.platform === "win32"
    ? pickOnWindows()
    : process.platform === "darwin"
      ? pickOnMac()
      : pickOnLinux();
  activePicker = task;
  try {
    return await task;
  } finally {
    activePicker = null;
  }
}