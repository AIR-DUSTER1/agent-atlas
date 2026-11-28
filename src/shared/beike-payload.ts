/**
 * ============================================================
 * shared/beike-payload.ts — 贝壳 CLI 结果信封解包与反转义（前后端共用）
 * ============================================================
 * 为什么需要这一层：贝壳 CLI 的成功输出是信封 `{ "data": "<正文文本>", "ok": true }`，
 * 正文里的业务字段本身是 JSON 字面量（`{"基础信息": {"租赁价格": "2800元/月"}}`）。
 * 一旦把整个信封当对象再 `JSON.stringify`，引号会被二次转义成 `\"租赁价格\"`，
 * 于是所有 `"租赁价格"\s*:\s*"…"` 形式的取值正则**全部失配** —— 表现为价格一律
 * 「价格待补」、小区/户型/面积全是空、`是否有VR` 也读不到（真实事故）。
 *
 * 契约：
 *  - 信封对象只走 `data` 字段，不要再 stringify 整只信封；
 *  - 反转义必须幂等：已经是明文（不含反斜杠）时原样返回，不重复处理；
 *  - 只做展示/取值用的文本还原，不试图把正文 JSON.parse 成对象 —— 正文由
 *    `<参考数据>` 文本块和 `<metadata>` 尾巴混合而成，不是合法 JSON。
 */

/** 内部正文可能出现的转义形态：`\"` 引号、`\/` 与 `\u002f` 斜杠、`\n` 换行。 */
export function unescapeBeikeText(text: string): string {
  if (!text || !text.includes("\\")) return text;
  return text
    .replace(/\\u002f/gi, "/")
    .replace(/\\\//g, "/")
    .replace(/\\"/g, '"')
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\\\/g, "\\");
}

/**
 * 把任意形态的贝壳结果值还原成「可跑字段正则」的文本。
 *  - 信封 `{ data, ok }`：只取 `data`（字符串），反转义；
 *  - 裸字符串：直接反转义；
 *  - 其它对象/数组：保守地 JSON.stringify（内部字符串仍会被上层逐层扫描）。
 */
export function beikeText(value: unknown): string {
  if (typeof value === "string") return unescapeBeikeText(value);
  if (value == null) return "";
  if (typeof value === "object" && !Array.isArray(value)) {
    const inner = (value as { data?: unknown }).data;
    if (typeof inner === "string") return unescapeBeikeText(inner);
  }
  try {
    return unescapeBeikeText(JSON.stringify(value));
  } catch {
    return "";
  }
}
