/**
 * ============================================================
 * job-jdtext.ts — JD 正文清洗（招聘站点页面 UI 噪声）
 * ============================================================
 * 职责：把详情页抓回来的「职位描述」正文洗成可读、可引用的纯正文。
 *
 * 为什么必须有这一层：采集器为省事会把正文从「职位描述」切到固定长度，
 * 末尾连带把站点 UI 带了进来——BOSS 的「去App 与BOSS随时沟通」「工作地址」
 * 「查看更多信息」、猎聘的「职位发布者」「公司介绍」尾巴、`kanzhun` 水印。
 * 这些内容一旦进入招呼语，就会变成「真诚期待与您在去App 与BOSS随时沟通」，
 * 直接暴露给 HR。
 *
 * 设计立场（移植自上游 core/jdtext.py，三类噪声形态都实测过）：
 *   1. **尾部**：正文后挂 UI 标记 → 在标记处截断
 *   2. **头部**：猎聘把「竞争力分析 / 职位分享」放在正文前 → 从标记之后开始取
 *   3. **混在正文里**：「负责公司介绍材料的整理」是真内容 → **不能截**
 * 所以判据不是「出现即截」，而是**按位置**：正文前 15% / 后 40% 视为 UI 区，
 * 中段出现的标记一律当正文保留。只做尾部截断 + 水印删除，不改写正文语义。
 */

/** 清洗后保留的最大字符数；超过部分截断（上游 1500，本地略放宽以容纳完整 JD）。 */
const JD_CLEAN_MAX_LEN = 3_000;

/** 弱标记只在这个比例之后的位置才认定为 UI（正文前段出现的同名词算正文）。 */
const WEAK_TAIL_RATIO = 0.6;

/** 列表类标记只在这个比例之后才认定为推荐列表标题。 */
const LIST_MARKER_TAIL_RATIO = 0.5;

/** 「相似岗位」列表至少连续命中几条「岗位名+薪资」才认定。 */
const JOB_LIST_MIN_HITS = 3;

/** 推荐列表条目之间的最大间隔字符数；超过视为列表断开。 */
const JOB_LIST_GAP_CHARS = 200;

/** 头部 UI 检测窗口（字符数）。 */
const HEAD_UI_WINDOW = 200;

/** 列表标记命中后，往后看多少字符内出现薪资形态才算真列表。 */
const LIST_SHAPE_WINDOW = 80;

/**
 * 强标记：这些词只可能来自页面 UI，正文不会这么写。出现即截断，不限位置。
 */
const STRONG_TAIL_MARKERS: readonly string[] = [
  "去App", "去APP", "与BOSS随时沟通", "前往App", "点击查看地图", "查看更多信息",
  "猎聘APP", "我要反馈", "打开微信扫一扫", "查看完整个人竞争力",
  "扣押求职者证件", "请立即举报", "违法违规使用求职者简历", "投诉举报",
  "严禁用人单位和招聘者",
  // 猎聘 / 51job 的结构化元数据尾巴
  "职能类别", "关键字：", "关键字:",
];

/**
 * 弱标记：正文里也可能正常出现（「负责公司介绍材料整理」「工作地址解析」），
 * 必须落在文档后段才认定为 UI（见 WEAK_TAIL_RATIO）。
 */
const WEAK_TAIL_MARKERS: readonly string[] = [
  "工作地址", "公司地址", "工商信息", "公司介绍", "公司简介",
  "其他信息", "竞争力分析", "安全提示", "职位推荐", "职位发布者",
  "扫码查看", "微信扫码", "查看更多",
];

/**
 * 列表类标记：本身很强，但正文里也可能顺口提到（「相似职位推荐功能」）。
 * 只有落在后段、且后面紧跟「岗位名 薪资」形态时才算 UI。
 */
const LIST_LIKE_MARKERS: readonly string[] = [
  "相似职位", "相关职位", "猜你喜欢", "为你推荐", "看了又看", "更多职位",
  "看过该职位的人还看了",
];

/** 出现在 JD 头部时，从最后一个标记之后开始取正文（不是截断，是切掉开头）。 */
const HEAD_MARKERS: readonly string[] = [
  "竞争力分析", "查看竞争力分析", "打开微信扫一扫", "职位分享",
  "职位发布者", "举报该职位",
];

/**
 * 站点名 / 水印。BOSS 会把水印插在词中间（「算BOSSA」），只能按子串删。
 * 顺序有讲究：长词先删，避免短词先删掉一半导致长词匹配不上。
 */
const WATERMARKS: readonly string[] = [
  "来自BOSS直聘", "BOSS直聘", "直聘", "kanzhun.com", "kanzhun", "看准网",
];

/**
 * HR 卡片残片：BOSS 把招聘者信息插在正文之后，形如
 * 「张女士5月内活跃 河南快联网络科技·经理」。整块去掉。
 */
const HR_BLOCK = /[\u4e00-\u9fa5]{1,3}(先生|女士)?\s*\d*\s*(刚刚活跃|今日活跃|本周活跃|今日在线|本周在线|月内活跃|\d+\s*(?:分钟|小时|天|周|个月)前活跃|\d+\s*月内活跃).{0,40}/g;

/**
 * 「相似岗位」条目特征：岗位名紧接薪资（「Python数据工程师 6-10K 云智环境 青岛」）。
 * 这类列表没有分隔标题（被站点裁掉了），只能靠形态识别。
 */
const JOB_LIST_ITEM = /[\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9/.+#\- ]{2,24}\s*(\d+-\d+[Kk千万元]|\d+[Kk]-\d+[Kk]|面议)\s*[\u4e00-\u9fa5A-Za-z（）()]{2,24}/g;

/** 薪资形态（列表标记后的形态校验用）。 */
const SALARY_SHAPE = /\d+\s*-\s*\d+\s*[Kk千万]/;

/** 连续空白归一（含全角空格），保留中英文之间必要的分隔。 */
const WHITESPACE = /[ \t\u3000]+/g;

/** 末尾悬空分隔符（截断/删除留下的）。 */
const TRAILING_SEPARATORS = /[\s·,，、/|+\-]+$/;

/**
 * 列表类标记 + 形态校验：命中处后方 LIST_SHAPE_WINDOW 字内需出现「岗位名 薪资」样式。
 * 这样「相似职位推荐等业务功能」不会被当成列表标题切掉，而
 * 「相似职位 Python开发 10-15K 某公司」会。
 */
function tailMarkerWithShape(text: string, markers: readonly string[]): number {
  let cut = text.length;
  const tailFrom = Math.floor(text.length * LIST_MARKER_TAIL_RATIO);
  for (const marker of markers) {
    let start = tailFrom;
    for (;;) {
      const index = text.indexOf(marker, start);
      if (index < 0) break;
      const after = text.slice(index, index + LIST_SHAPE_WINDOW);
      if (SALARY_SHAPE.test(after)) {
        cut = Math.min(cut, index);
        break;
      }
      start = index + marker.length;
    }
  }
  return cut;
}

/**
 * 返回「相似岗位」推荐列表的起始位置；不是列表则返回 text.length。
 *
 * 判据是**条目条数**（≥3 条且连续聚在尾部），不是单条位置——
 * 正文里偶尔提一句「10-15K」不会凑够 3 条。
 */
function jobListCut(text: string): number {
  if (!text) return 0;
  const hits = [...text.matchAll(JOB_LIST_ITEM)];
  if (hits.length < JOB_LIST_MIN_HITS) return text.length;
  const tailStart = Math.floor(text.length * 0.6);
  const last = hits[hits.length - 1]!;
  if ((last.index ?? 0) < tailStart) return text.length;
  // 从后往前回溯这一簇（间隔超过阈值视为断开）
  let firstIndex = hits.length - 1;
  while (firstIndex > 0) {
    const prev = hits[firstIndex - 1]!;
    const cur = hits[firstIndex]!;
    if ((cur.index ?? 0) - ((prev.index ?? 0) + prev[0].length) > JOB_LIST_GAP_CHARS) break;
    firstIndex -= 1;
  }
  if (hits.length - firstIndex < JOB_LIST_MIN_HITS) return text.length;
  return hits[firstIndex]!.index ?? text.length;
}

/**
 * 清洗 JD 正文：去掉首尾页面 UI → 去 HR 卡片 → 去水印 → 压缩空白 → 限长。
 *
 * 只做尾部截断与水印删除，不改写正文——宁可少留一点，也不动原文语义。
 */
export function cleanJd(text: string, maxLen = JD_CLEAN_MAX_LEN): string {
  if (!text) return "";
  let out = text;

  // ---- 头部：切掉开头那一段页面 UI ----
  // 头部 UI 的特征是**从第 0 个字符附近开始**连续出现标记；正文里偶尔提到的词
  // 不会出现在开头。命中则从最后一个命中标记之后开始取正文。
  const headWindow = Math.min(out.length, HEAD_UI_WINDOW);
  let headEnd = 0;
  for (const marker of HEAD_MARKERS) {
    const index = out.slice(0, headWindow).indexOf(marker);
    if (index >= 0) headEnd = Math.max(headEnd, index + marker.length);
  }
  if (headEnd) out = out.slice(headEnd);

  // ---- 尾部：强/弱标记 + 列表形态，取最早的一处截断 ----
  let cut = out.length;
  for (const marker of STRONG_TAIL_MARKERS) {
    const index = out.indexOf(marker);
    // index > 0：正文恰好以标记开头说明整个内容是 UI，交给头部逻辑处理
    if (index > 0) cut = Math.min(cut, index);
  }
  cut = Math.min(cut, tailMarkerWithShape(out, LIST_LIKE_MARKERS));

  // 弱标记只认后段：正文里「负责公司介绍材料整理」不能被误切
  const weakFrom = Math.floor(out.length * WEAK_TAIL_RATIO);
  for (const marker of WEAK_TAIL_MARKERS) {
    const index = out.indexOf(marker, weakFrom);
    if (index > 0) cut = Math.min(cut, index);
  }
  cut = Math.min(cut, jobListCut(out));
  out = out.slice(0, cut);

  // ---- 尾段清理 ----
  out = out.replace(HR_BLOCK, "");
  for (const watermark of WATERMARKS) out = out.split(watermark).join("");
  out = out.replace(WHITESPACE, " ").trim();
  out = out.replace(TRAILING_SEPARATORS, "");
  return out.slice(0, maxLen).trim();
}

/** 粗略评估 JD 可用性（清洗后的长度）；0 表示没有可用 JD，只能写简版招呼语。 */
export function jdQuality(text: string): number {
  return cleanJd(text).length;
}

/**
 * 就地清洗一批岗位的 jdText，返回实际改动的条数。
 *
 * 在入库前统一调用（采集合成后 / 补详情存回前），这样快照、Excel 和招呼语
 * 拿到的都是干净 JD；招呼语导出时的清洗是第二道保险，不是唯一防线。
 */
export function cleanJobsInPlace(jobs: Array<{ jdText: string }>, maxLen = JD_CLEAN_MAX_LEN): number {
  let changed = 0;
  for (const job of jobs) {
    const raw = job.jdText ?? "";
    if (!raw) continue;
    const cleaned = cleanJd(raw, maxLen);
    if (cleaned !== raw) {
      job.jdText = cleaned;
      changed += 1;
    }
  }
  return changed;
}
