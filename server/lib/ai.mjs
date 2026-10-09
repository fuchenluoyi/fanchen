/**
 * 上游（OpenAI 兼容服务）调用层：URL 归一化、凭据解析、流式对话、结构化抽取、JSON 容错。
 */
import { HttpError } from './http.mjs';
import { iterateSse, parseSseData } from './sse.mjs';

export const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1';
export const DEFAULT_MODEL = 'deepseek-chat';
export const MAX_EXTRACT_CHARS = 8000;

const TASK_CATEGORIES = ['feature', 'bug', 'content', 'question', 'other'];
const TASK_PRIORITIES = ['P0', 'P1', 'P2'];

/* ------------------------------------------------------------------ *
 * URL 与凭据
 * ------------------------------------------------------------------ */

/**
 * 把用户填写的 baseUrl 归一化为 API 根（如 https://api.deepseek.com/v1）。
 * 容错：允许带/不带 /v1，允许直接粘贴 /chat/completions 全路径。
 * @param {string} rawBase
 * @returns {string}
 */
export function resolveApiRoot(rawBase) {
  const trimmed = String(rawBase ?? '').trim();
  if (!trimmed) {
    throw new HttpError(400, 'missing_credentials', '缺少 baseUrl（也未在服务端配置 AI_BASE_URL）');
  }
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    throw new HttpError(400, 'invalid_base_url', `baseUrl 无法解析：${trimmed}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HttpError(400, 'invalid_base_url', `baseUrl 只支持 http/https，收到 ${url.protocol}`);
  }
  let pathname = url.pathname.replace(/\/+$/, '');
  for (const suffix of ['/chat/completions', '/completions']) {
    if (pathname.endsWith(suffix)) {
      pathname = pathname.slice(0, -suffix.length);
      break;
    }
  }
  if (pathname === '') pathname = '/v1';
  url.pathname = pathname;
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

export function chatEndpoint(baseUrl) {
  return `${resolveApiRoot(baseUrl)}/chat/completions`;
}

export function modelsEndpoint(baseUrl) {
  return `${resolveApiRoot(baseUrl)}/models`;
}

/**
 * 合并请求体与进程环境变量中的凭据（环境变量仅作兜底）。
 * @param {Record<string, any>} body
 */
export function resolveCredentials(body = {}) {
  const baseUrl = String(body.baseUrl ?? '').trim() || String(process.env.AI_BASE_URL ?? '').trim() || DEFAULT_BASE_URL;
  const apiKey = String(body.apiKey ?? '').trim() || String(process.env.AI_API_KEY ?? '').trim();
  const model = String(body.model ?? '').trim() || String(process.env.AI_MODEL ?? '').trim() || DEFAULT_MODEL;
  if (!apiKey) {
    throw new HttpError(
      400,
      'missing_credentials',
      '缺少 apiKey：请在页面右上角「设置」里填写，或在服务端配置 AI_API_KEY',
    );
  }
  return { baseUrl, apiKey, model };
}

export function serverDefaults() {
  return {
    baseUrl: String(process.env.AI_BASE_URL ?? '').trim() || DEFAULT_BASE_URL,
    model: String(process.env.AI_MODEL ?? '').trim() || DEFAULT_MODEL,
    hasKey: Boolean(String(process.env.AI_API_KEY ?? '').trim()),
  };
}

/* ------------------------------------------------------------------ *
 * 错误映射
 * ------------------------------------------------------------------ */

/**
 * @param {number} status
 * @param {string} text
 */
export function mapUpstreamError(status, text) {
  const snippet = String(text ?? '').slice(0, 300);
  if (status === 401) return { code: 'upstream_401', message: '模型服务返回 401：API Key 无效或没有权限' };
  if (status === 403) return { code: 'upstream_403', message: '模型服务返回 403：请求被拒绝（地区限制或模型未开通）' };
  if (status === 404) return { code: 'upstream_404', message: `模型服务返回 404：baseUrl 或模型名可能不对。${snippet}` };
  if (status === 429) return { code: 'upstream_429', message: '模型服务返回 429：触发限流或额度不足，请稍后重试' };
  if (status >= 500) return { code: 'upstream_5xx', message: `模型服务返回 ${status}：上游异常。${snippet}` };
  if (status >= 400) return { code: 'upstream_4xx', message: `模型服务返回 ${status}：${snippet}` };
  return { code: 'upstream_error', message: `模型服务返回 ${status}：${snippet}` };
}

export function mapFetchFailure(err) {
  const reason = err?.cause?.code ?? err?.code ?? err?.name ?? 'unknown';
  return {
    code: 'upstream_unreachable',
    message: `无法连接到模型服务（${reason}）。请检查 baseUrl、网络代理或本机防火墙`,
  };
}

/* ------------------------------------------------------------------ *
 * 工具定义与提示词
 * ------------------------------------------------------------------ */

export const TASK_TOOL = {
  type: 'function',
  function: {
    name: 'create_task',
    description:
      '把对话者表达出的一个明确需求/期望/待办登记进右侧任务清单。当对方说"我需要…""帮我做个…""最好还能…""缺一个…"这类内容时调用。一次回复中可以调用多次；没有需求就不要调用。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '任务标题，不超过 20 个字，直接概括需求' },
        detail: { type: 'string', description: '需求详情，忠于对方原话，不要脑补' },
        category: { type: 'string', enum: TASK_CATEGORIES, description: '需求类别' },
        priority: { type: 'string', enum: TASK_PRIORITIES, description: 'P0 阻塞主流程 / P1 明显重要 / P2 锦上添花' },
        acceptance: {
          type: 'array',
          items: { type: 'string' },
          description: '0-3 条验收要点，写成可判定的句子',
        },
      },
      required: ['title', 'detail'],
      additionalProperties: false,
    },
  },
};

export const EXTRACT_SYSTEM_PROMPT = [
  '你是一个需求分析师。你的唯一任务：从给定文本中抽取说话人明确表达的"需求 / 期望 / 待办"。',
  '硬性规则：',
  '1. 只抽取文本中确实表达出来的需求，绝不脑补、不补充文本没有的信息。',
  '2. 如果文本里没有任何需求，必须返回 {"tasks": []}。',
  '3. 只输出 JSON 对象本身，不要解释，不要 markdown 代码围栏。',
  '4. 输出格式：{"tasks":[{"title":"","detail":"","category":"feature|bug|content|question|other","priority":"P0|P1|P2","acceptance":[""],"confidence":0.0}]}',
  '5. title 不超过 20 个字；detail 1-2 句、忠于原意；acceptance 0-3 条。',
  '6. confidence 是 0 到 1 的小数，表示你有多确定这是一条真需求。',
].join('\n');

/**
 * @param {string} text
 * @param {string} context
 * @param {number} maxTasks
 */
export function buildExtractPrompt(text, context, maxTasks) {
  const parts = [];
  if (context) parts.push(`【对话者上一句】\n${context}`);
  parts.push(`【需要分析的文本】\n${text}`);
  parts.push(`最多返回 ${maxTasks} 条任务，按重要性排序。只输出 JSON。`);
  return parts.join('\n\n');
}

/* ------------------------------------------------------------------ *
 * JSON 容错解析（AC-5.3 / U-07）
 * ------------------------------------------------------------------ */

/**
 * 尽最大努力从模型输出中解析出 JSON 对象。
 * @param {any} text
 * @returns {any | null}
 */
export function parseJsonLoose(text) {
  if (typeof text !== 'string') return null;
  let raw = text.replace(/^\uFEFF/, '').trim();
  if (!raw) return null;

  const fenced = raw.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fenced && fenced[1]) raw = fenced[1].trim();

  const direct = tryParse(raw);
  if (direct !== undefined) return direct;

  const objSlice = extractBalanced(raw, '{', '}');
  if (objSlice) {
    const parsed = tryParse(objSlice);
    if (parsed !== undefined) return parsed;
  }
  const arrSlice = extractBalanced(raw, '[', ']');
  if (arrSlice) {
    const parsed = tryParse(arrSlice);
    if (parsed !== undefined) return parsed;
  }
  return null;
}

/** @param {string} s */
function tryParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/**
 * 从文本中截取第一个括号平衡的片段（忽略字符串内的括号）。
 * @param {string} s
 * @param {string} open
 * @param {string} close
 */
function extractBalanced(s, open, close) {
  const start = s.indexOf(open);
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i += 1) {
    const ch = s[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 任务对象校验归一化（AC-4.4 / U-05）
 * ------------------------------------------------------------------ */

/**
 * @param {any} raw
 * @returns {{ ok: true; task: { title: string; detail: string; category: string; priority: string; acceptance: string[]; confidence: number } } | { ok: false; reason: string }}
 */
export function normalizeExtractedTask(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: '任务不是一个对象' };
  }
  const source = /** @type {Record<string, unknown>} */ (raw);
  const title = typeof source.title === 'string' ? source.title.trim() : '';
  if (!title) return { ok: false, reason: '缺少 title 或 title 为空' };
  const detailRaw = typeof source.detail === 'string' ? source.detail.trim() : '';
  const category = TASK_CATEGORIES.includes(/** @type {string} */ (source.category))
    ? /** @type {string} */ (source.category)
    : 'feature';
  const priority = TASK_PRIORITIES.includes(/** @type {string} */ (source.priority))
    ? /** @type {string} */ (source.priority)
    : 'P1';
  const acceptance = Array.isArray(source.acceptance)
    ? source.acceptance.filter((x) => typeof x === 'string' && x.trim()).map((x) => String(x).trim()).slice(0, 3)
    : [];
  const confidenceNumber = typeof source.confidence === 'number' && Number.isFinite(source.confidence)
    ? Math.min(1, Math.max(0, source.confidence))
    : 0.7;

  return {
    ok: true,
    task: {
      title: title.slice(0, 60),
      detail: (detailRaw || title).slice(0, 600),
      category,
      priority,
      acceptance,
      confidence: Number(confidenceNumber.toFixed(2)),
    },
  };
}

/**
 * 从抽取结果里取出任务数组并逐个校验。
 * @param {any} parsed
 * @returns {Array<Record<string, unknown>>}
 */
export function collectTasksFromExtraction(parsed) {
  if (!parsed) return [];
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.tasks) ? parsed.tasks : [];
  /** @type {Array<Record<string, unknown>>} */
  const out = [];
  for (const item of list) {
    const result = normalizeExtractedTask(item);
    if (result.ok) out.push(result.task);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 流式 tool_calls 拼装（AC-4.2）
 * ------------------------------------------------------------------ */

export class ToolCallAssembler {
  constructor() {
    /** @type {Map<number, { index: number; id: string; name: string; args: string }>} */
    this.slots = new Map();
  }

  /** @param {any[]} deltas */
  push(deltas) {
    if (!Array.isArray(deltas)) return;
    for (const delta of deltas) {
      const index = Number.isInteger(delta?.index) ? delta.index : 0;
      if (!this.slots.has(index)) this.slots.set(index, { index, id: '', name: '', args: '' });
      const slot = this.slots.get(index);
      if (typeof delta?.id === 'string') slot.id = delta.id;
      if (typeof delta?.function?.name === 'string') slot.name = delta.function.name;
      if (typeof delta?.function?.arguments === 'string') slot.args += delta.function.arguments;
    }
  }

  list() {
    return [...this.slots.values()].sort((a, b) => a.index - b.index);
  }
}

/* ------------------------------------------------------------------ *
 * 上游调用
 * ------------------------------------------------------------------ */

/**
 * 调用上游 /chat/completions。
 * @param {{ baseUrl: string; apiKey: string; payload: Record<string, unknown>; signal?: AbortSignal }} options
 */
export async function callChatCompletions({ baseUrl, apiKey, payload, signal }) {
  // URL 归一化放在 try 之外：协议/格式错误应当原样冒泡成 400，而不是被当成"连不上上游"
  const endpoint = chatEndpoint(baseUrl);
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new HttpError(502, mapFetchFailure(err).code, mapFetchFailure(err).message);
  }
  return response;
}

/**
 * 非流式读取上游文本响应。
 */
export async function readUpstreamText(response) {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

export { iterateSse, parseSseData };
