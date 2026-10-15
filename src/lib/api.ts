/**
 * 与后端代理通信：健康检查、模型列表、流式对话、结构化抽取。
 * 唯一负责网络的地方（架构约束：components 不得直接触网）。
 */
import type {
  HealthInfo,
  QuestDeclinePayload,
  QuestImpressionPayload,
  QuestSubmissionPayload,
  RawTaskPayload,
  Role,
  ServerEvent,
  Settings,
} from '../types.ts';
import type { QuestProposalDraft } from './quest/bridge.ts';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status = 0) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

async function readErrorBody(res: Response): Promise<{ code: string; message: string }> {
  try {
    const data = (await res.json()) as { error?: { code?: unknown; message?: unknown } };
    const code = typeof data?.error?.code === 'string' ? data.error.code : `http_${res.status}`;
    const message = typeof data?.error?.message === 'string' ? data.error.message : `请求失败（HTTP ${res.status}）`;
    return { code, message };
  } catch {
    return { code: `http_${res.status}`, message: `请求失败（HTTP ${res.status}）` };
  }
}

const CATEGORY_SET = new Set(['feature', 'bug', 'content', 'question', 'other']);
const PRIORITY_SET = new Set(['P0', 'P1', 'P2']);

/** 客户端侧再校验一次服务端给的任务参数（AC-4.4，纵深防御）。 */
export function sanitizeRawTaskPayload(raw: unknown): RawTaskPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  const title = typeof source.title === 'string' ? source.title.trim() : '';
  if (!title) return null;
  const detail = typeof source.detail === 'string' && source.detail.trim() ? source.detail.trim() : title;
  const category = CATEGORY_SET.has(String(source.category)) ? String(source.category) : 'feature';
  const priority = PRIORITY_SET.has(String(source.priority)) ? String(source.priority) : 'P1';
  const acceptance = Array.isArray(source.acceptance)
    ? source.acceptance.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).slice(0, 3)
    : [];
  const confidenceRaw = typeof source.confidence === 'number' ? source.confidence : 0.7;
  return {
    title: title.slice(0, 60),
    detail: detail.slice(0, 600),
    category: category as RawTaskPayload['category'],
    priority: priority as RawTaskPayload['priority'],
    acceptance: acceptance.map((x) => x.trim()),
    confidence: Math.min(1, Math.max(0, Number(confidenceRaw.toFixed(2)))),
  };
}

/* ------------------------------------------------------------------ */

const OBJECTIVE_KINDS = new Set(['deliver_item', 'has_item', 'talk_count', 'affinity_at_least']);
const REWARD_KINDS = new Set(['item', 'affinity', 'ability', 'info', 'none']);

/**
 * 客户端侧再校验一次模型给的委托提案（纵深防御，做法同 sanitizeRawTaskPayload）。
 * 这里只判"形状能不能喂给领域层"：**规则**裁决（道具白名单、档位上限、库存预留）
 * 由领域层负责，它本身是全函数 —— 非法输入会被拒绝而不是抛出。
 */
export function sanitizeQuestProposal(raw: unknown): QuestProposalDraft | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  const title = typeof source.title === 'string' ? source.title.trim() : '';
  const want = typeof source.want === 'string' ? source.want.trim() : '';
  const objective = source.objective as Record<string, unknown> | undefined;
  const reward = source.reward as Record<string, unknown> | undefined;
  if (!title || !want) return null;
  if (!objective || typeof objective !== 'object' || !OBJECTIVE_KINDS.has(String(objective.kind))) return null;
  if (!reward || typeof reward !== 'object' || !REWARD_KINDS.has(String(reward.kind))) return null;
  // 档位由代码算，模型不再自报 —— 这里也不接受 offerLevel
  return {
    title: title.slice(0, 40),
    want: want.slice(0, 300),
    tier: source.tier as QuestProposalDraft['tier'],
    objective: objective as unknown as QuestProposalDraft['objective'],
    reward: reward as unknown as QuestProposalDraft['reward'],
  };
}

const IMPRESSION_KINDS = new Set(['pleased', 'neutral', 'offended']);

/** 印象事件（note_impression）的客户端侧收敛 */
export function sanitizeQuestImpression(raw: unknown): QuestImpressionPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  const kind = typeof source.kind === 'string' ? source.kind.trim() : '';
  if (!IMPRESSION_KINDS.has(kind)) return null;
  const reason = typeof source.reason === 'string' ? source.reason.trim().slice(0, 200) : '';
  return reason
    ? { kind: kind as QuestImpressionPayload['kind'], reason }
    : { kind: kind as QuestImpressionPayload['kind'] };
}

export function sanitizeQuestSubmission(raw: unknown): QuestSubmissionPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  const questId = typeof source.questId === 'string' ? source.questId.trim() : '';
  if (!questId) return null;
  const deliver = source.deliver as Record<string, unknown> | undefined;
  if (deliver && typeof deliver === 'object') {
    const itemId = typeof deliver.itemId === 'string' ? deliver.itemId : '';
    const count = typeof deliver.count === 'number' ? Math.trunc(deliver.count) : 0;
    if (!itemId || count <= 0) return null;
    return { questId, deliver: { itemId, count } };
  }
  return { questId };
}

export function sanitizeQuestDecline(raw: unknown): QuestDeclinePayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  const questId = typeof source.questId === 'string' ? source.questId.trim() : '';
  if (!questId) return null;
  const reason = typeof source.reason === 'string' ? source.reason.slice(0, 100) : '';
  return reason ? { questId, reason } : { questId };
}

function eventIndex(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0;
}

/** 把服务端来的原始 JSON 收敛成合法事件；不认识或结构不对的返回 null（丢弃而不是塞给 UI） */
export function normalizeServerEvent(raw: unknown): ServerEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  switch (source.type) {
    case 'delta':
      return typeof source.text === 'string' ? { type: 'delta', text: source.text } : null;
    case 'reasoning':
      return typeof source.text === 'string' ? { type: 'reasoning', text: source.text } : null;
    case 'tool_call': {
      const task = sanitizeRawTaskPayload(source.task);
      return task ? { type: 'tool_call', index: eventIndex(source.index), task } : null;
    }
    case 'quest_proposal': {
      const proposal = sanitizeQuestProposal(source.proposal);
      return proposal ? { type: 'quest_proposal', index: eventIndex(source.index), proposal } : null;
    }
    case 'quest_submit': {
      const submission = sanitizeQuestSubmission(source.submission);
      return submission ? { type: 'quest_submit', index: eventIndex(source.index), submission } : null;
    }
    case 'quest_decline': {
      const decline = sanitizeQuestDecline(source.decline);
      return decline ? { type: 'quest_decline', index: eventIndex(source.index), decline } : null;
    }
    case 'quest_impression': {
      const impression = sanitizeQuestImpression(source.impression);
      return impression
        ? { type: 'quest_impression', index: eventIndex(source.index), impression }
        : null;
    }
    case 'notice':
      return {
        type: 'notice',
        code: typeof source.code === 'string' ? source.code : 'notice',
        message: typeof source.message === 'string' ? source.message : '',
      };
    case 'usage':
      return source.usage && typeof source.usage === 'object'
        ? { type: 'usage', usage: source.usage as Record<string, unknown> }
        : null;
    case 'done':
      return { type: 'done' };
    case 'error':
      return {
        type: 'error',
        code: typeof source.code === 'string' ? source.code : 'error',
        message: typeof source.message === 'string' ? source.message : '',
      };
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */

export async function fetchHealth(fetchImpl: typeof fetch = fetch): Promise<HealthInfo> {
  const res = await fetchImpl('/api/health', { method: 'GET' });
  if (!res.ok) {
    const { code, message } = await readErrorBody(res);
    throw new ApiError(message, code, res.status);
  }
  return (await res.json()) as HealthInfo;
}

export async function fetchModels(
  settings: Settings,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const res = await fetchImpl('/api/models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseUrl: settings.baseUrl, apiKey: settings.apiKey }),
  });
  if (!res.ok) {
    const { code, message } = await readErrorBody(res);
    throw new ApiError(message, code, res.status);
  }
  const data = (await res.json()) as { models?: unknown };
  return Array.isArray(data?.models) ? data.models.filter((m): m is string => typeof m === 'string') : [];
}

/* ------------------------------------------------------------------ */

export interface StreamChatOptions {
  settings: Settings;
  messages: Array<{ role: Role; content: string }>;
  onEvent: (event: ServerEvent) => void;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/** 按契约切分 SSE 事件块（兼容 \n\n 与 \r\n\r\n）。 */
function splitBlocks(buffer: string): { blocks: string[]; rest: string } {
  const blocks: string[] = [];
  let rest = buffer;
  const separator = /\r?\n\r?\n/;
  for (;;) {
    const match = separator.exec(rest);
    if (!match) break;
    blocks.push(rest.slice(0, match.index));
    rest = rest.slice(match.index + match[0].length);
  }
  return { blocks, rest };
}

function parseBlock(block: string, onEvent: (event: ServerEvent) => void): void {
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  if (dataLines.length === 0) return;
  const payload = dataLines.join('\n').trim();
  if (!payload || payload === '[DONE]') return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    onEvent({ type: 'notice', code: 'malformed_chunk', message: '忽略了服务端一个无法解析的数据块' });
    return;
  }
  const event = normalizeServerEvent(parsed);
  if (event) onEvent(event);
}

/**
 * 发起一轮对话。所有事件通过 onEvent 回调抛出（契约 §2.1 / §5）。
 */
export async function streamChat(options: StreamChatOptions): Promise<void> {
  const { settings, messages, onEvent, signal } = options;
  const fetchImpl = options.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await fetchImpl('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        model: settings.model,
        temperature: settings.temperature,
        stream: settings.stream,
        enableTools: settings.enableTools,
        // 只有 npc 模式才把委托工具交给模型；desk 模式的请求体与从前逐字节一致
        ...(settings.chatMode === 'npc' && settings.enableTools ? { questTools: true } : {}),
        messages,
      }),
      signal,
    });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err;
    throw new ApiError('无法连接到本地代理服务，请确认后端已启动（pnpm dev）', 'proxy_unreachable', 0);
  }

  if (!res.ok) {
    const { code, message } = await readErrorBody(res);
    throw new ApiError(message, code, res.status);
  }

  const contentType = res.headers.get('content-type') ?? '';

  // 非流式：服务端返回一个 JSON 对象，转成等价事件
  if (contentType.includes('application/json')) {
    const data = (await res.json()) as {
      text?: unknown;
      reasoning?: unknown;
      toolCalls?: unknown;
      questCalls?: unknown;
      notices?: unknown;
      usage?: unknown;
    };
    if (Array.isArray(data.notices)) {
      for (const notice of data.notices as Array<{ code?: unknown; message?: unknown }>) {
        onEvent({
          type: 'notice',
          code: typeof notice?.code === 'string' ? notice.code : 'notice',
          message: typeof notice?.message === 'string' ? notice.message : '',
        });
      }
    }
    if (typeof data.reasoning === 'string' && data.reasoning) onEvent({ type: 'reasoning', text: data.reasoning });
    if (typeof data.text === 'string' && data.text) onEvent({ type: 'delta', text: data.text });
    if (Array.isArray(data.toolCalls)) {
      for (const call of data.toolCalls as Array<{ index?: unknown; task?: unknown }>) {
        const task = sanitizeRawTaskPayload(call?.task);
        if (task) {
          onEvent({ type: 'tool_call', index: typeof call.index === 'number' ? call.index : 0, task });
        }
      }
    }
    if (Array.isArray(data.questCalls)) {
      for (const call of data.questCalls as Array<{ index?: unknown; event?: unknown }>) {
        const event = normalizeServerEvent(call?.event);
        if (!event) continue;
        onEvent(
          event.type === 'quest_proposal' ||
            event.type === 'quest_submit' ||
            event.type === 'quest_decline' ||
            event.type === 'quest_impression'
            ? { ...event, index: typeof call.index === 'number' ? call.index : event.index }
            : event,
        );
      }
    }
    if (data.usage && typeof data.usage === 'object') onEvent({ type: 'usage', usage: data.usage as Record<string, unknown> });
    onEvent({ type: 'done' });
    return;
  }

  if (!res.body) throw new ApiError('服务端没有返回响应体', 'empty_body', 0);

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { blocks, rest } = splitBlocks(buffer);
      buffer = rest;
      for (const block of blocks) parseBlock(block, onEvent);
    }
    buffer += decoder.decode();
    if (buffer.trim()) parseBlock(buffer, onEvent);
  } finally {
    reader.releaseLock?.();
  }
}

/* ------------------------------------------------------------------ */

export interface ExtractionRequest {
  settings: Settings;
  text: string;
  context?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/** 调用服务端 /api/extract 做结构化抽取（AC-5.2）。 */
export async function requestExtraction(request: ExtractionRequest): Promise<RawTaskPayload[]> {
  const fetchImpl = request.fetchImpl ?? fetch;
  const res = await fetchImpl('/api/extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      baseUrl: request.settings.baseUrl,
      apiKey: request.settings.apiKey,
      model: request.settings.model,
      text: request.text,
      context: request.context ?? '',
      maxTasks: 5,
    }),
    signal: request.signal,
  });

  if (!res.ok) {
    const { code, message } = await readErrorBody(res);
    throw new ApiError(message, code, res.status);
  }
  const data = (await res.json()) as { tasks?: unknown };
  if (!Array.isArray(data?.tasks)) return [];
  return data.tasks.map(sanitizeRawTaskPayload).filter((task): task is RawTaskPayload => task !== null);
}
