/**
 * 与后端代理通信：健康检查、模型列表、流式对话、结构化抽取。
 * 唯一负责网络的地方（架构约束：components 不得直接触网）。
 */
import type { HealthInfo, RawTaskPayload, Role, ServerEvent, Settings } from '../types.ts';

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
  try {
    const parsed = JSON.parse(payload) as ServerEvent;
    if (parsed && typeof (parsed as { type?: unknown }).type === 'string') onEvent(parsed);
  } catch {
    onEvent({ type: 'notice', code: 'malformed_chunk', message: '忽略了服务端一个无法解析的数据块' });
  }
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
