/**
 * 任务去重：字符级相似度（中文短标题友好）+ 动作动词冲突惩罚。
 * 纯函数，无副作用（NFR-004）。
 */

/** 归一化：小写、去掉标点与空白、去掉常见无意义前后缀。 */
export function normalizeText(input: string): string {
  return String(input ?? '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。、；：！？,.;:!?"'“”‘’()（）\[\]【】<>《》~`*#\-_/\\|+]+/g, '')
    .replace(/^(请|麻烦|帮我|帮忙|我们|我|需要|想要|应该|最好|希望)+/g, '')
    .replace(/(吧|呢|啊|了|的|吗)$/g, '');
}

function bigrams(text: string): Set<string> {
  const grams = new Set<string>();
  if (text.length <= 2) {
    if (text) grams.add(text);
    return grams;
  }
  for (let i = 0; i < text.length - 1; i += 1) grams.add(text.slice(i, i + 2));
  return grams;
}

/** 二元组 Dice 系数 */
function diceCoefficient(a: string, b: string): number {
  const ga = bigrams(a);
  const gb = bigrams(b);
  if (ga.size === 0 || gb.size === 0) return a === b ? 1 : 0;
  let shared = 0;
  for (const gram of ga) if (gb.has(gram)) shared += 1;
  return (2 * shared) / (ga.size + gb.size);
}

/** 最长公共子串长度（动态规划，标题都很短，成本可忽略） */
export function longestCommonSubstringLength(a: string, b: string): number {
  if (!a || !b) return 0;
  let best = 0;
  let previous = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    const current = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j += 1) {
      if (a[i - 1] === b[j - 1]) {
        current[j] = previous[j - 1] + 1;
        if (current[j] > best) best = current[j];
      }
    }
    previous = current;
  }
  return best;
}

/** 动作动词表：用于识别"导出 vs 导入"这类实质不同的需求 */
const ACTION_VERBS = [
  '导出', '导入', '新增', '添加', '删除', '移除', '编辑', '修改', '优化', '修复', '支持', '接入', '对接',
  '同步', '提醒', '统计', '筛选', '排序', '搜索', '上传', '下载', '分享', '生成', '计算', '记录', '管理',
  '配置', '分配', '审批', '通知', '备份', '还原', '迁移', '监控', '报警', '打卡', '签到', '登录', '注册',
  '支付', '打印', '发送', '接收', '展示', '保存', '校验', '合并', '拆分', '推荐',
];

function primaryVerb(text: string): string | null {
  let best: string | null = null;
  let bestIndex = Number.POSITIVE_INFINITY;
  for (const verb of ACTION_VERBS) {
    const index = text.indexOf(verb);
    if (index >= 0 && index < bestIndex) {
      bestIndex = index;
      best = verb;
    }
  }
  return best;
}

/**
 * 两个标题的相似度，取值 0..1。
 * 组合指标：二元组 Dice 与"最长公共子串 / 较短串长度"取较大者；
 * 若双方的主要动作动词不同（导出 vs 导入），则判定为不同需求并大幅降权。
 */
export function similarity(a: string, b: string): number {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.length < 3 || nb.length < 3) return na === nb ? 1 : 0;

  const dice = diceCoefficient(na, nb);
  const lcs = longestCommonSubstringLength(na, nb) / Math.min(na.length, nb.length);
  let score = Math.max(dice, lcs);

  const va = primaryVerb(na);
  const vb = primaryVerb(nb);
  if (va && vb && va !== vb) score *= 0.45;

  return Number(score.toFixed(4));
}

/** 候选是否与既有标题重复。 */
export function isDuplicate(title: string, existingTitles: readonly string[], threshold: number): boolean {
  for (const existing of existingTitles) {
    if (similarity(title, existing) >= threshold) return true;
  }
  return false;
}

export interface DedupeResult<T> {
  kept: T[];
  dropped: Array<{ item: T; duplicateOf: string; score: number }>;
}

/**
 * 批量去重：既对比既有标题，也对比同批次内先出现的项（AC-9.1 / AC-9.3）。
 */
export function dedupeCandidates<T extends { title: string }>(
  items: readonly T[],
  existingTitles: readonly string[],
  threshold: number,
): DedupeResult<T> {
  const kept: T[] = [];
  const dropped: Array<{ item: T; duplicateOf: string; score: number }> = [];

  for (const item of items) {
    let duplicateOf: string | null = null;
    let bestScore = 0;

    for (const existing of existingTitles) {
      const score = similarity(item.title, existing);
      if (score >= threshold && score > bestScore) {
        bestScore = score;
        duplicateOf = existing;
      }
    }
    for (const accepted of kept) {
      const score = similarity(item.title, accepted.title);
      if (score >= threshold && score > bestScore) {
        bestScore = score;
        duplicateOf = accepted.title;
      }
    }

    if (duplicateOf !== null) {
      dropped.push({ item, duplicateOf, score: bestScore });
    } else {
      kept.push(item);
    }
  }

  return { kept, dropped };
}
