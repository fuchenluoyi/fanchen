/**
 * 规则引擎：判断一段文本里是否含有"需求"，并在无凭据时直接产出候选任务。
 * 纯函数、零运行时依赖（NFR-004）。是抽取通道的第一道闸门（AC-5.1）。
 */
import type { RawTaskPayload, TaskCategory, TaskPriority } from '../types.ts';

export interface RuleCandidate {
  /** 清洗后的句子原文 */
  text: string;
  title: string;
  score: number;
  reasons: string[];
}

export interface RuleAnalysis {
  hit: boolean;
  score: number;
  reasons: string[];
  candidates: RuleCandidate[];
}

/** 默认触发阈值（分数制：强表述 3 分、中等 2 分、产品名词 1 分、列表项 +1） */
export const DEFAULT_TRIGGER_THRESHOLD = 3;

const SIGNALS: ReadonlyArray<{ re: RegExp; label: string; weight: number }> = [
  { re: /需求/, label: '出现「需求」', weight: 3 },
  { re: /我需要|我们要|咱们要|公司要|客户要/, label: '出现「我需要」', weight: 3 },
  { re: /帮我(做|写|加|实现|搞|弄|改|看|查|搭|建)|帮忙(做|加|实现|写|搭)/, label: '出现「帮我…」', weight: 3 },
  { re: /缺一[个条块项]|少一[个条块项]|差一[个条块项]/, label: '出现「缺一个…」', weight: 3 },
  { re: /(实现|做|搞|加|写|搭|建)一[个套款下]/, label: '出现「做一个…」', weight: 3 },
  { re: /要能|要可以|必须(能|支持|有|要)|一定要/, label: '出现「要能 / 必须支持」', weight: 3 },
  { re: /用户故事|验收标准|痛点|业务方要求/, label: '出现需求工程术语', weight: 3 },
  {
    re: /\brequirements?\b|\bi want\b|\bhelp me\b|\bplease add\b|\bcan you\b|\bwe need\b|\bneed to\b|\bshould be able\b/i,
    label: '出现英文需求表述',
    weight: 3,
  },
  {
    re: /希望(能|可以|支持|有|加上)|最好.{0,2}能|最好是|建议(加|增加|支持|做)|还能(再)?(加|做|写|有|支持|导)/,
    label: '出现「希望 / 最好还能」',
    weight: 2,
  },
  { re: /支持[了]?[\u4e00-\u9fa5A-Za-z]|兼容[\u4e00-\u9fa5A-Za-z]/, label: '出现「支持…」', weight: 2 },
  { re: /增加|新增|加上|加个|添加|引入/, label: '出现「增加 / 添加」', weight: 2 },
  { re: /优化|改进|提升|修复|解决|完善|重构/, label: '出现「优化 / 修复」', weight: 2 },
  { re: /接入|对接|集成|打通|同步|迁移/, label: '出现「接入 / 对接」', weight: 2 },
  { re: /自动(化)?(提醒|生成|同步|统计|排班|通知|发送|备份|汇总|校验)/, label: '出现「自动…」', weight: 2 },
  { re: /应该(能|要|有|加|支持)|需要(加|支持|有|做|实现)/, label: '出现「应该有 / 需要加」', weight: 2 },
  { re: /待办|todo|\bto-do\b/i, label: '出现「待办 / TODO」', weight: 2 },
  {
    re: /导出|导入|上传|下载|统计|汇总|筛选|搜索|排序|分页|打印|分享|提醒|通知|审批|签到|打卡|排班|备份|校验|重试|缓存|埋点|监控|报警|对账/,
    label: '出现具体功能动作词',
    weight: 2,
  },
  {
    re: /\bneeds?\b|\bneeded\b|\bshould\b|\bmust\b|\bfeature\b|\badd\b|\bsupport\b|\bimplement\b/i,
    label: '出现英文需求动词',
    weight: 2,
  },
  { re: /功能|模块|页面|界面|流程|工具|系统|报表|看板|面板|表单|权限|接口|字段/, label: '出现产品名词', weight: 1 },
];

/** 否定表达：出现这些就不该被当成需求 */
const NEGATIONS = /不需要|不用|没必要|无需|别加|不要(加|做|这个)|暂时不|先不/;

const LIST_MARKER = /^\s*(?:[-*•·]|(?:\d+)\s*[.、)）]|\((?:\d+)\)|（(?:\d+)）)\s*/;

const MAX_CANDIDATES = 6;
const MIN_UNIT_LENGTH = 6;
const MAX_UNIT_LENGTH = 200;

/** 去掉 markdown 装饰与列表符号 */
export function stripDecorations(line: string): string {
  return line
    .replace(LIST_MARKER, '')
    .replace(/\*\*/g, '')
    .replace(/`+/g, '')
    .replace(/^#{1,6}\s*/, '')
    .replace(/^[>\s]+/, '')
    .trim();
}

interface Unit {
  text: string;
  isListItem: boolean;
}

function splitUnits(raw: string): Unit[] {
  const units: Unit[] = [];
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const isListItem = LIST_MARKER.test(line);
    const body = stripDecorations(line);
    if (!body) continue;
    // 再按句末标点切分，保留标点
    const sentences = body.split(/(?<=[。！!？?；;])\s*/).map((s) => s.trim()).filter(Boolean);
    for (const sentence of sentences) units.push({ text: sentence, isListItem });
  }
  return units;
}

function scoreUnit(unit: Unit): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  for (const signal of SIGNALS) {
    if (signal.re.test(unit.text)) {
      score += signal.weight;
      reasons.push(signal.label);
    }
  }
  if (unit.isListItem && score > 0) {
    score += 1;
    reasons.push('位于列表项中');
  }
  return { score, reasons };
}

/** 清理句首的连接词，让标题更像一件事 */
function trimLead(text: string): string {
  return text
    .replace(/^(而且|另外|还有|然后|所以|不过|但是|另外呢|同时|此外|我觉得|我认为|个人觉得|可能|其实|总之)[，,、]?/, '')
    .trim();
}

export function makeTitle(text: string): string {
  const cleaned = trimLead(stripDecorations(text))
    .replace(/^[，,、：:\s]+/, '')
    .replace(/[。！!？?；;，,、]+$/g, '')
    .replace(/[（(][^）)]{0,20}[）)]$/, '')
    .replace(/[*`#]/g, '')
    .trim();
  const core = cleaned || stripDecorations(text).trim();
  if (core.length <= 20) return core;
  return `${core.slice(0, 20)}…`;
}

export function guessCategory(text: string): TaskCategory {
  if (/修复|报错|错误|bug|崩溃|异常|不生效|失效|挂了|失败|闪退/i.test(text)) return 'bug';
  if (/文案|文档|说明|介绍|教程|示例|素材/.test(text)) return 'content';
  if (/[?？]$/.test(text.trim()) && text.trim().length <= 24) return 'question';
  return 'feature';
}

export function guessPriority(text: string): TaskPriority {
  if (/必须|一定要|关键|阻塞|核心|紧急|上线前|卡住|不能少/.test(text)) return 'P0';
  if (/最好|可选|锦上添花|以后|将来|有空|不急|无所谓/.test(text)) return 'P2';
  return 'P1';
}

function toPayload(candidate: RuleCandidate): RawTaskPayload {
  return {
    title: candidate.title,
    detail: candidate.text,
    category: guessCategory(candidate.text),
    priority: guessPriority(candidate.text),
    acceptance: [],
    confidence: Number(Math.min(0.8, 0.25 + candidate.score * 0.08).toFixed(2)),
  };
}

/**
 * 分析文本中的需求。
 * @param rawText 助手回复原文
 * @param threshold 触发阈值
 */
export function analyzeForRequirements(rawText: string, threshold = DEFAULT_TRIGGER_THRESHOLD): RuleAnalysis {
  const units = splitUnits(rawText);
  const allReasons: string[] = [];
  let best = 0;
  const candidates: RuleCandidate[] = [];

  for (const unit of units) {
    // 列表项天生简短（"2. 自动提醒"），阈值放低；正文句仍要求有一定长度
    const minLength = unit.isListItem ? 3 : MIN_UNIT_LENGTH;
    if (unit.text.length < minLength || unit.text.length > MAX_UNIT_LENGTH) continue;
    if (NEGATIONS.test(unit.text)) continue;
    const { score, reasons } = scoreUnit(unit);
    if (score > best) best = score;
    if (score >= threshold) {
      candidates.push({ text: unit.text, title: makeTitle(unit.text), score, reasons });
      for (const reason of reasons) if (!allReasons.includes(reason)) allReasons.push(reason);
    }
  }

  const hit = best >= threshold;
  return {
    hit,
    score: best,
    reasons: hit ? allReasons : [],
    candidates: candidates.sort((a, b) => b.score - a.score).slice(0, MAX_CANDIDATES),
  };
}

/** 便捷方法：只问"是否值得一提"，用于省掉无谓的 LLM 调用。 */
export function detectRequirement(text: string, threshold = DEFAULT_TRIGGER_THRESHOLD): boolean {
  return analyzeForRequirements(text, threshold).hit;
}

/** 把文本切成句子单元（供抽取通道挑选"原话"证据用）。 */
export function sentenceUnits(rawText: string): string[] {
  return splitUnits(rawText).map((unit) => unit.text);
}

/** 规则通道直接产出候选（无凭据时的降级路径，FR-006）。 */
export function ruleCandidates(text: string, threshold = DEFAULT_TRIGGER_THRESHOLD): RawTaskPayload[] {
  return analyzeForRequirements(text, threshold).candidates.map(toPayload);
}
