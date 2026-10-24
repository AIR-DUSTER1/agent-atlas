/**
 * ============================================================
 * tools-computer.ts — 电脑控制工具集（Computer Use，仅 Windows）
 * ============================================================
 * 给通用 Agent 提供「看屏幕 + 操作屏幕」的能力：
 *   computer_screenshot  截取全屏（只读，不审批；多模态模型直接看图）
 *   computer_click        移动鼠标并单击 / 双击 / 右键（高风险，需审批）
 *   computer_type         向当前窗口输入文本（高风险，需审批）
 *   computer_key          发送组合键，如 ctrl+s（高风险，需审批）
 *   computer_scroll       滚轮上下滚动（高风险，需审批）
 *
 * 实现立场（零新依赖红线）：
 *   - 不引入 robotjs / nut.js 等原生依赖，全部动作通过 powershell.exe
 *     调 .NET（System.Windows.Forms / System.Drawing）与 user32.dll 实现；
 *   - PS5.1 默认控制台是 GBK（§8 平台坑），中文参数内联脚本必乱码 ——
 *     这里统一走 -EncodedCommand（脚本先按 UTF-16LE 编成 base64），
 *     从根上绕开命令行编码问题，脚本本身也保持全英文；
 *   - 中文 / 非 ASCII 文本输入 SendKeys 不可靠，改走「Set-Clipboard + Ctrl+V」
 *     （副作用：会覆盖用户剪贴板，描述里已注明）。
 *
 * 已知边界：无桌面会话（CI / 服务进程）截图会失败并返回中文错误，
 * 由模型转述，不影响其它工具。
 */
import { tool, StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { spawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import { getActiveModality } from "./server/settings.js";

const ACTION_TIMEOUT_MS = 10_000;  // 单个电脑动作的超时（截图含 JPEG 编码，给足）
const MAX_SCREENSHOT_EDGE = 1_280; // 截图最长边（再大 token 浪费，1080p 会等比缩到 1280）
const JPEG_QUALITY = 72;           // 截图 JPEG 质量：肉眼可读即可，压 base64 体积
const MAX_TYPE_CHARS = 500;        // 单次输入文本上限
const MAX_SCROLL_LINES = 20;       // 单次滚动行数上限
const MAX_COORD = 49_999;          // 像素坐标上限（防荒谬值，虚拟屏一般 ≤ 16384）

// ---------------------------------------------------------------------------
// PowerShell 执行底座
// ---------------------------------------------------------------------------

/** user32 P/Invoke 声明：点击 / 滚轮都要它（mouse_event 的 data 用 int，
 *  滚轮负值（向上滚）按补码传递，声明成 uint 会转换失败）。 */
const WIN32_HELPER = `
Add-Type @"
using System.Runtime.InteropServices;
public static class CuWin {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, int data, System.UIntPtr extra);
}
"@`.trim();

interface PowerShellResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 以 -EncodedCommand 方式执行 PowerShell：脚本 UTF-16LE → base64，
 *  规避 PS5.1 GBK 控制台下中文 / 特殊字符的编码坑。 */
function runPowerShell(script: string): Promise<PowerShellResult> {
  if (process.platform !== "win32") {
    return Promise.reject(new Error("电脑控制工具仅支持 Windows 桌面环境"));
  }
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((resolveDone, rejectDone) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", encoded], {
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), ACTION_TIMEOUT_MS);
    child.stdout?.on("data", (c: Buffer) => { stdout += c.toString("utf8"); });
    child.stderr?.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });
    child.on("error", (err) => {
      clearTimeout(timer);
      rejectDone(new Error(`PowerShell 启动失败：${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveDone({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** 单引号 PS 字符串的字面量转义（' → ''）；脚本走 EncodedCommand，只需防 PS 语法层 */
function psQuote(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}

async function runAction(script: string): Promise<string> {
  const result = await runPowerShell(script);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout || "").trim().split("\n").slice(-3).join(" ").slice(0, 300);
    throw new Error(`电脑操作失败（退出码 ${result.code}）：${detail || "无输出"}`);
  }
  return result.stdout.trim();
}

// ---------------------------------------------------------------------------
// 纯函数：SendKeys 语法（导出供单测）
// ---------------------------------------------------------------------------

/** SendKeys 需要大括号转义的特殊字符集 */
const SENDKEYS_SPECIAL = new Set(["+", "^", "%", "~", "(", ")", "{", "}", "[", "]"]);

/** 把明文转成 SendKeys 可发送的串：特殊字符加 {} 包裹，换行 → {ENTER}，制表 → {TAB} */
export function escapeSendKeys(text: string): string {
  return Array.from(text)
    .map((ch) => {
      if (ch === "\n") return "{ENTER}";
      if (ch === "\r") return "";
      if (ch === "\t") return "{TAB}";
      if (SENDKEYS_SPECIAL.has(ch)) return `{${ch}}`;
      return ch;
    })
    .join("");
}

/** 仅 ASCII（且不含需要转义的字符歧义）时 SendKeys 可直接可靠发送 */
function isSendKeysSafe(text: string): boolean {
  return /^[\x20-\x7E]*$/.test(text);
}

/** 组合键名 → SendKeys 语法键名；未知键返回 null（调用方转中文错误） */
const KEY_NAMES: Record<string, string> = {
  enter: "{ENTER}", tab: "{TAB}", esc: "{ESC}", escape: "{ESC}",
  bksp: "{BKSP}", backspace: "{BKSP}", del: "{DEL}", delete: "{DEL}",
  ins: "{INS}", insert: "{INS}", home: "{HOME}", end: "{END}",
  pgup: "{PGUP}", pgdn: "{PGDN}",
  up: "{UP}", down: "{DOWN}", left: "{LEFT}", right: "{RIGHT}",
  space: " ",
};

/** 解析 "ctrl+shift+t" / "enter" / "f5" 这类组合键为 SendKeys 语法；
 *  校验失败返回 null：修饰键只认 ctrl/alt/shift，主键必须恰好一个。 */
export function parseKeyCombo(combo: string): string | null {
  const parts = combo.toLowerCase().split("+").map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return null;
  const modifiers: string[] = [];
  let main = "";
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    const isModifier = part === "ctrl" || part === "alt" || part === "shift";
    if (isModifier) {
      // 修饰键必须都在主键之前
      if (main) return null;
      modifiers.push(part);
      continue;
    }
    if (main) return null; // 出现第二个主键
    if (KEY_NAMES[part]) { main = KEY_NAMES[part]; continue; }
    if (/^f([1-9]|1[0-2])$/.test(part)) { main = `{${part.toUpperCase()}}`; continue; }
    if (/^[a-z0-9]$/.test(part) || part.length === 1) { main = part; continue; }
    return null;
  }
  if (!main) return null; // 只有修饰键（如只按住 ctrl）无法表达
  return `${modifiers.includes("ctrl") ? "^" : ""}${modifiers.includes("alt") ? "%" : ""}${modifiers.includes("shift") ? "+" : ""}${main}`;
}

// ---------------------------------------------------------------------------
// 动作实现
// ---------------------------------------------------------------------------

interface ScreenshotCapture {
  /** 给模型 / 前端看的元数据行 */
  summary: string;
  /** JPEG base64（无多模态价值时为空，避免无谓的大 payload） */
  base64: string | null;
  width: number;
  height: number;
}

async function captureScreenshot(): Promise<ScreenshotCapture> {
  const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$w = [int]$b.Width; $h = [int]$b.Height
if ($w -lt 1 -or $h -lt 1) { Write-Error "empty virtual screen"; exit 1 }
$scale = [Math]::Min(1.0, ${MAX_SCREENSHOT_EDGE} / [Math]::Max($w, $h))
$tw = [int][Math]::Round($w * $scale); $th = [int][Math]::Round($h * $scale)
$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.X, $b.Y, 0, 0, (New-Object System.Drawing.Size($w, $h)))
$g.Dispose()
if ($scale -lt 1.0) {
  $small = New-Object System.Drawing.Bitmap($tw, $th)
  $g2 = [System.Drawing.Graphics]::FromImage($small)
  $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g2.DrawImage($bmp, 0, 0, $tw, $th)
  $g2.Dispose(); $bmp.Dispose(); $bmp = $small
}
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$ep = New-Object System.Drawing.Imaging.EncoderParameters(1)
$ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]${JPEG_QUALITY})
$out = Join-Path $env:TEMP ("cu_" + [guid]::NewGuid().ToString('N') + ".jpg")
$bmp.Save($out, $codec, $ep)
$bmp.Dispose()
Write-Output $out
Write-Output ("META $w $h $tw $th")`.trim();

  const stdout = await runAction(script);
  const lines = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  const filePath = lines[0] ?? "";
  const meta = (lines[1] ?? "").split(" ");
  const width = Number(meta[1]);
  const height = Number(meta[2]);
  if (!filePath || !Number.isFinite(width) || !Number.isFinite(height)) {
    throw new Error("截图结果解析失败，请重试一次");
  }
  try {
    const buf = await fsp.readFile(filePath);
    return {
      summary: `已截取全屏 ${width}x${height} 像素${lines[3] && lines[3] !== lines[1] ? `（已等比缩放至 ${meta[3]}x${meta[4]} 供模型查看）` : ""}。`,
      base64: buf.toString("base64"),
      width,
      height,
    };
  } finally {
    void fsp.unlink(filePath).catch(() => {}); // 临时截图文件即读即删
  }
}

/**
 * 截屏工具是多模态内容块（text + image_url）的唯一生产者：
 * LangChain tool() 会把非字符串返回值 JSON.stringify 成文本，
 * 图片块会因此丢失 —— 所以这里继承 StructuredTool 并覆写 invoke()，
 * 直接返回 content blocks 数组（hitl.ts 的 invokeTool 会原样透传）。
 */
class ComputerScreenshotTool extends StructuredTool {
  name = "computer_screenshot";
  description =
    "截取整块屏幕（多显示器为虚拟屏拼接）并返回给模型查看（只读操作，无需审批）。" +
    "操作电脑前应先截图确认界面元素与坐标；当前模型不支持视觉时只返回尺寸元数据。";
  schema = z.object({});

  async _call(): Promise<string> {
    return screenshotSummary(await captureScreenshot());
  }

  override async invoke(): Promise<unknown> {
    const shot = await captureScreenshot();
    if (getActiveModality() !== "vision") {
      return screenshotSummary(shot, true);
    }
    return [
      { type: "text", text: screenshotSummary(shot) },
      { type: "image_url", image_url: { url: `data:image/jpeg;base64,${shot.base64 ?? ""}` } },
    ];
  }
}

function screenshotSummary(shot: ScreenshotCapture, textOnly = false): string {
  if (textOnly) {
    return `${shot.summary}当前模型不支持视觉输入，看不到画面内容；` +
      `可在设置里切换多模态模型后重试。`;
  }
  return shot.summary;
}

// 坐标一律由 zod 保证整数，再在 JS 层夹紧范围 —— 数字内插 PowerShell 无注入面
function clampCoord(value: number): number {
  return Math.max(0, Math.min(MAX_COORD, Math.round(value)));
}

const computerClick = tool(
  async ({ x, y, button, double }) => {
    const cx = clampCoord(x);
    const cy = clampCoord(y);
    const down = button === "right" ? 8 : 2;  // LEFTDOWN=2/UP=4；RIGHTDOWN=8/UP=16
    const up = button === "right" ? 16 : 4;
    const clicks = double ? 2 : 1;
    const events = Array.from({ length: clicks }, () =>
      `[CuWin]::mouse_event(${down},0,0,0,[UIntPtr]::Zero)
Start-Sleep -Milliseconds 40
[CuWin]::mouse_event(${up},0,0,0,[UIntPtr]::Zero)`).join("\nStart-Sleep -Milliseconds 60\n");
    await runAction(`${WIN32_HELPER}
[CuWin]::SetCursorPos(${cx}, ${cy}) | Out-Null
${events}`);
    return `已在屏幕坐标 (${cx}, ${cy}) 完成${double ? "双" : ""}击（${button === "right" ? "右键" : "左键"}）。`;
  },
  {
    name: "computer_click",
    description:
      "把鼠标移动到屏幕像素坐标并点击（高风险操作，执行前需要用户批准）。" +
      "坐标以「截屏时的左上角为原点」计算；双击用 double=true，右键用 button=\"right\"。" +
      "点击前应先 computer_screenshot 确认目标位置。",
    schema: z.object({
      x: z.number().int().describe("屏幕 X 像素坐标（截图左上角为 0,0）"),
      y: z.number().int().describe("屏幕 Y 像素坐标"),
      button: z.enum(["left", "right"]).default("left").describe("鼠标键：left 左键（默认）/ right 右键"),
      double: z.boolean().default(false).describe("是否双击（默认单击）"),
    }),
  }
);

const computerType = tool(
  async ({ text }) => {
    const body = isSendKeysSafe(text)
      ? `[System.Windows.Forms.SendKeys]::SendWait(${psQuote(escapeSendKeys(text))})`
      // 非 ASCII（中文等）SendKeys 发不准：剪贴板中转 + Ctrl+V（会覆盖用户剪贴板）
      : `Set-Clipboard -Value ${psQuote(text)}
Start-Sleep -Milliseconds 80
[System.Windows.Forms.SendKeys]::SendWait('^v')`;
    await runAction(`Add-Type -AssemblyName System.Windows.Forms
${body}`);
    return `已向当前窗口输入 ${text.length} 字符${isSendKeysSafe(text) ? "" : "（经剪贴板粘贴，用户剪贴板被覆盖）"}。`;
  },
  {
    name: "computer_type",
    description:
      "向当前获得焦点的窗口输入文本（高风险操作，执行前需要用户批准）。" +
      "用于在输入框 / 编辑器里打字；中文等非 ASCII 文本会经剪贴板粘贴（会临时覆盖用户剪贴板）。" +
      "需要回车确认时请再用 computer_key 发送 enter。",
    schema: z.object({
      text: z.string().max(MAX_TYPE_CHARS).describe(`要输入的文本（上限 ${MAX_TYPE_CHARS} 字符）`),
    }),
  }
);

const computerKey = tool(
  async ({ combo }) => {
    const sendKeys = parseKeyCombo(combo);
    if (!sendKeys) {
      return `组合键「${combo}」无法解析：只支持 ctrl / alt / shift 修饰键加一个主键（字母、数字、F1-F12、enter、tab、esc、del、方向键等）。`;
    }
    await runAction(`Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait(${psQuote(sendKeys)})`);
    return `已发送按键 ${combo}。`;
  },
  {
    name: "computer_key",
    description:
      "向当前窗口发送组合键 / 功能键（高风险操作，执行前需要用户批准）。" +
      '写法如 "ctrl+s"、"alt+f4"、"enter"、"ctrl+shift+t"。不支持 Windows 徽标键。',
    schema: z.object({
      combo: z.string().describe('组合键，修饰键在前，如 "ctrl+s"、"alt+f4"、"enter"'),
    }),
  }
);

const computerScroll = tool(
  async ({ direction, lines }) => {
    const amount = (direction === "up" ? -1 : 1) * Math.max(1, Math.min(MAX_SCROLL_LINES, lines)) * 120;
    await runAction(`${WIN32_HELPER}
[CuWin]::mouse_event(0x0800, 0, 0, ${amount}, [UIntPtr]::Zero)`);
    return `已在当前鼠标位置${direction === "up" ? "向上" : "向下"}滚动 ${Math.abs(amount) / 120} 行。`;
  },
  {
    name: "computer_scroll",
    description:
      "在当前鼠标位置滚动滚轮（高风险操作，执行前需要用户批准）。适合浏览长页面；" +
      "滚动的是鼠标当前所指窗口，必要时先用 computer_click 聚焦目标窗口。",
    schema: z.object({
      direction: z.enum(["up", "down"]).describe("滚动方向：up 向上 / down 向下"),
      lines: z.number().int().min(1).max(MAX_SCROLL_LINES).describe(`滚动行数（1-${MAX_SCROLL_LINES}）`),
    }),
  }
);

export const computerScreenshot = new ComputerScreenshotTool();

/** 电脑控制工具集（general agent 绑定；动作类四项登记审批，截图只读直接执行） */
export const computerTools = [computerScreenshot, computerClick, computerType, computerKey, computerScroll];

// 供单测断言工具命名与前缀一致性
export const COMPUTER_TOOL_NAMES = computerTools.map((item) => item.name);
