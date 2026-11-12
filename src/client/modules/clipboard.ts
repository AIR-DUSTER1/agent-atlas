/**
 * modules/clipboard.ts — 统一剪贴板写入与降级
 * ============================================================
 * 消息、总结和代码块共用同一入口：优先 Clipboard API，权限受限时回退到
 * 临时 textarea + execCommand；空内容直接失败，避免按钮给出虚假成功反馈。
 */
export async function writeClipboardText(raw: string): Promise<boolean> {
  const text = String(raw ?? "").trim();
  if (!text) return false;

  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Electron / 浏览器可能拒绝无用户手势或受限环境下的剪贴板权限，继续降级。
  }

  if (typeof document === "undefined" || !document.body) return false;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);
  try {
    return typeof document.execCommand === "function" && document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}
