/**
 * ============================================================
 * job-keywords.ts — 岗位方向族、关键词展开与相关性判定
 * ============================================================
 * 职责：把「用户说的方向」展开成站内可能出现的叫法，并判断某个岗位标题
 * 是否属于目标方向。筛选（采集后过滤）与打分（scoreTitle）共用这一份词表，
 * 保证「筛进来什么」和「打多少分」是同一套口径。
 *
 * 设计立场（与上游 job-hunter 的差异，必须保留）：
 *   - 方向族只用于**归并展示**（一个方向只出一页 Excel），不作为准入门槛。
 *     任何未命中族表的关键词自成一族，所以「产品经理」「护士」「电工」都能用。
 *   - 非研发类过滤必须**按目标方向自适应**：用户搜「Agent开发」时剔除
 *     「AI 培训讲师」是对的；用户搜「产品经理」时如果再剔除「产品经理」，
 *     就等于把用户自己要找的岗位全删了。上游硬编码 token 的写法不通用。
 */

/** 方向族 → 站内常见叫法（小写、去空格后做子串匹配）。族表可扩充，缺失不影响可用性。 */
export const DIRECTION_FAMILIES: Record<string, readonly string[]> = {
  AI应用开发: [
    "ai应用", "ai开发", "ai工程师", "aigc", "智能体", "agent", "multiagent",
    "multi-agent", "langchain", "langgraph", "rag", "大模型", "llm", "ai",
  ],
  前端开发: ["前端", "frontend", "front-end", "vue", "react", "h5", "小程序", "web开发"],
  后端开发: ["后端", "backend", "back-end", "java", "golang", "go开发", "python开发", "node", "服务端"],
  数据分析: ["数据分析", "bi", "商业分析", "数据仓库", "数据开发", "数仓", "etl"],
  算法工程: ["算法", "机器学习", "深度学习", "推荐算法", "nlp", "cv", "计算机视觉"],
  测试: ["测试", "qa", "自动化测试", "测试开发", "软件测试"],
  运维: ["运维", "sre", "devops", "系统运维", "网络运维", "k8s"],
  产品: ["产品经理", "产品", "product manager", "pm", "产品设计"],
  设计: ["设计", "ui", "ux", "交互设计", "视觉设计", "平面设计"],
  运营: ["运营", "内容运营", "用户运营", "活动运营", "新媒体运营"],
  销售: ["销售", "大客户", "销售代表", "商务拓展", "bd"],
  人力: ["人力资源", "hr", "招聘", "人事", "薪酬"],
  财务: ["财务", "会计", "出纳", "审计", "税务"],
};

/**
 * 非目标岗位的噪声词：招聘站点会把「培训讲师」「售前」「产品经理」也挂在
 * 技术关键词下，它们分数不低但投了没用。
 *
 * 注意：这张表是**相对**某一目标方向的排除项，不是绝对黑名单——见 isNonDevTitle。
 */
export const NON_DEV_TITLE_TOKENS: readonly string[] = [
  "讲师", "培训师", "售前", "销售", "产品经理", "项目经理", "运营",
  "咨询顾问", "实施顾问", "业务分析师", "研究员", "架构设计师",
];

/** 从关键词里剥掉的通用后缀，剥完剩下的才是方向核心词。 */
const GENERIC_SUFFIXES: readonly string[] = [
  "开发工程师", "工程师岗位", "高级工程师", "开发", "工程师", "岗位", "专员", "经理",
];

/** 子串匹配的最短长度：单字噪声太大（如「ai」除外，它本身够特指）。 */
const MIN_TOKEN_LEN = 2;

function normalize(text: string): string {
  return (text ?? "").toLowerCase().replace(/\s+/g, "");
}

/** 最短 token 长度例外：这些词本身就是方向名，即使短也保留。 */
const SHORT_TOKENS = new Set(["ai", "pm", "bs", "cv", "ui", "ux", "qa", "hr"]);

/**
 * 把用户关键词归到一个方向族。
 * 匹配不上时**返回关键词原样**——保证任意方向都有名字，不会退化成空串。
 */
export function familyOf(keyword: string): string {
  const key = normalize(keyword);
  if (!key) return "";
  let best = "";
  let bestLen = 0;
  for (const [family, tokens] of Object.entries(DIRECTION_FAMILIES)) {
    for (const token of tokens) {
      if (key.includes(token) && token.length > bestLen) {
        best = family;
        bestLen = token.length;
      }
    }
  }
  return best || keyword.trim();
}

/**
 * 把一个关键词展开成可匹配的词集合：原词 + 去后缀核心词 + 所属方向族的全部叫法。
 * 与上游 core/keywords.py::expand 同口径。
 */
export function expandKeyword(keyword: string): string[] {
  const key = normalize(keyword);
  if (!key) return [];
  const out = new Set<string>([key]);

  let core = key;
  for (const suffix of GENERIC_SUFFIXES) {
    if (core.endsWith(suffix) && core.length > suffix.length) {
      core = core.slice(0, -suffix.length);
      break;
    }
  }
  out.add(core);

  const family = familyOf(keyword);
  const familyTokens = DIRECTION_FAMILIES[family] ?? [];
  for (const token of familyTokens) out.add(token);

  // 用户自己写的中文方向也要能匹配到英文族成员，反之亦然；
  // 族内 token 可能是多词（"product manager"），去掉空格后仍参与匹配。
  return [...out]
    .map((token) => normalize(token))
    .filter((token) => token.length >= MIN_TOKEN_LEN || SHORT_TOKENS.has(token));
}

/** 关键词列表展开并去重，供批量匹配复用（避免每行重复展开）。 */
export function expandAll(keywords: readonly string[]): string[] {
  const out = new Set<string>();
  for (const keyword of keywords) {
    for (const token of expandKeyword(keyword)) out.add(token);
  }
  return [...out];
}

/**
 * 标题是否属于「非目标方向」的噪声岗。
 *
 * 判据：目标关键词自身**不**落在同一类岗位上时才剔除。例如：
 *   - 目标「Agent开发」+ 标题「AI 培训讲师」→ 剔除（讲师不是开发）
 *   - 目标「产品经理」+ 标题「AI 产品经理」→ 保留（目标就是产品经理）
 *   - 目标「运营」+ 标题「内容运营」→ 保留
 *
 * 这样同一张能力表对任何求职方向都成立，不需要为每个职业维护白名单。
 */
export function isNonDevTitle(title: string, keywords: readonly string[]): boolean {
  const target = normalize(title);
  if (!target) return false;
  const targetText = keywords.map(normalize).join(" ");
  for (const token of NON_DEV_TITLE_TOKENS) {
    if (!target.includes(token)) continue;
    // 目标方向本身就属于这一类岗位 → 该 token 不作为排除依据
    if (targetText.includes(token)) continue;
    return true;
  }
  return false;
}

/** 岗位标题是否属于目标方向：命中任一展开词，且不是非目标方向的噪声岗。 */
export function isRelevantTitle(title: string, keywords: readonly string[]): boolean {
  const target = normalize(title);
  if (!target || !keywords.length) return false;
  if (isNonDevTitle(title, keywords)) return false;
  const tokens = expandAll(keywords);
  return tokens.some((token) => target.includes(token));
}

/**
 * 判断岗位属于哪个方向。
 *   - 只命中一个方向族 → 返回该族名
 *   - 同时命中多个族 → 「跨方向」（如「AI Agent 前端开发」）
 *   - 都不命中 → 空串（调用方按「其他」处理）
 *
 * 关键点：先按族去重再计数。用户同时传「Agent开发,大模型开发」时两者同属
 * 「AI应用开发」，只算一个方向，不会再被误判成「跨方向」。
 */
export function matchDirection(title: string, keywords: readonly string[]): string {
  const target = normalize(title);
  if (!target) return "";
  const hits: string[] = [];
  for (const keyword of keywords) {
    const tokens = expandKeyword(keyword);
    if (!tokens.some((token) => target.includes(token))) continue;
    const family = familyOf(keyword);
    if (family && !hits.includes(family)) hits.push(family);
  }
  if (hits.length === 1) return hits[0]!;
  return hits.length > 1 ? "跨方向" : "";
}
