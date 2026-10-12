/**
 * 凡尘·需求台 —— 后端代理（零第三方依赖）
 * 路由：GET /api/health、POST /api/models、POST /api/chat、POST /api/extract
 * 另：生产模式下托管 dist/ 静态文件。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HttpError, applyCors, sendJson, sendError, readJsonBody, serveStatic } from './lib/http.mjs';
import { sseEncode, iterateSse, parseSseData } from './lib/sse.mjs';
import { QUEST_TOOLS, QUEST_TOOL_NAMES, mapQuestToolCall } from './lib/quest-tools.mjs';
import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  MAX_EXTRACT_CHARS,
  EXTRACT_SYSTEM_PROMPT,
  TASK_TOOL,
  ToolCallAssembler,
  buildExtractPrompt,
  callChatCompletions,
  collectTasksFromExtraction,
  mapFetchFailure,
  mapUpstreamError,
  modelsEndpoint,
  normalizeExtractedTask,
  parseJsonLoose,
  resolveApiRoot,
  resolveCredentials,
  serverDefaults,
} from './lib/ai.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.dirname(HERE);
const DIST_DIR = path.join(ROOT_DIR, 'dist');

const argv = process.argv.slice(2);
const argPortIndex = argv.indexOf('--port');
const PORT = Number(argPortIndex >= 0 ? argv[argPortIndex + 1] : process.env.API_PORT ?? 8787) || 8787;
const FORCE_SERVE_DIST = argv.includes('--serve-dist');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
const VERSION = pkg.version ?? '0.0.0';
const SERVER_NAME = pkg.name ?? 'fanchen-desk';

/* ------------------------------------------------------------------ */

function clampNumber(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * 在 URL 解析之前，用原始请求目标判断是否为路径穿越。
 * 必须早于 `new URL()`：URL 解析器会把 `%2e%2e` 之类的双点段直接归一化掉，
 * 归一化后就再也看不出这是一次穿越尝试了（AC-6.2）。
 * @param {string} rawTarget
 */
function looksLikeTraversal(rawTarget) {
  let decoded = rawTarget;
  try {
    decoded = decodeURIComponent(rawTarget);
  } catch {
    /* 解码失败就按原样检查 */
  }
  return /(^|[\\/])\.\.([\\/]|$)/.test(decoded);
}

function handleError(res, err) {
  if (res.headersSent || res.writableEnded) {
    if (!res.writableEnded) res.end();
    return;
  }
  if (err instanceof HttpError) {
    sendError(res, err.status, err.code, err.message, err.extra);
    return;
  }
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
    res.end();
    return;
  }
  // 注意：绝不打印请求体，避免 apiKey 进入日志（AC-6.1）
  console.error('[api] 未预期错误:', err?.message ?? err);
  sendError(res, 500, 'internal_error', '服务端内部错误');
}

/* ------------------------------------------------------------------ *
 * GET /api/health
 * ------------------------------------------------------------------ */
function handleHealth(res) {
  sendJson(res, 200, {
    ok: true,
    name: SERVER_NAME,
    version: VERSION,
    defaults: serverDefaults(),
  });
}

/* ------------------------------------------------------------------ *
 * POST /api/models
 * ------------------------------------------------------------------ */
async function handleModels(req, res) {
  const body = await readJsonBody(req);
  const baseUrl = String(body.baseUrl ?? '').trim() || String(process.env.AI_BASE_URL ?? '').trim() || DEFAULT_BASE_URL;
  const apiKey = String(body.apiKey ?? '').trim() || String(process.env.AI_API_KEY ?? '').trim();
  const endpoint = modelsEndpoint(baseUrl); // 同时校验协议（AC-6.3）

  let response;
  try {
    response = await fetch(endpoint, {
      method: 'GET',
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    const mapped = mapFetchFailure(err);
    throw new HttpError(502, mapped.code, mapped.message);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const mapped = mapUpstreamError(response.status, text);
    throw new HttpError(502, mapped.code, mapped.message);
  }
  let parsed;
  try {
    parsed = await response.json();
  } catch {
    throw new HttpError(502, 'upstream_error', '上游 /models 返回了非 JSON 响应');
  }
  const models = Array.isArray(parsed?.data)
    ? parsed.data.map((m) => (typeof m?.id === 'string' ? m.id : null)).filter(Boolean)
    : [];
  sendJson(res, 200, { models });
}

/* ------------------------------------------------------------------ *
 * POST /api/chat
 * ------------------------------------------------------------------ */
async function handleChat(req, res) {
  const body = await readJsonBody(req);
  const { baseUrl, apiKey, model } = resolveCredentials(body);

  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new HttpError(400, 'invalid_messages', 'messages 必须是非空数组');
  }
  for (const message of messages) {
    if (!message || typeof message !== 'object') {
      throw new HttpError(400, 'invalid_messages', '消息必须是对象');
    }
    if (!['system', 'user', 'assistant'].includes(message.role)) {
      throw new HttpError(400, 'invalid_messages', `非法角色：${String(message.role)}`);
    }
    if (typeof message.content !== 'string') {
      throw new HttpError(400, 'invalid_messages', '消息 content 必须是字符串');
    }
  }

  const temperature = clampNumber(body.temperature, 0, 2, 0.8);
  const wantStream = body.stream !== false;
  const enableTools = body.enableTools !== false;
  // 委托工具是可选通道：前端显式带上 questTools 才把 NPC 委托能力交给模型（ADR-013）
  const enableQuestTools = body.questTools === true;

  const controller = new AbortController();
  // 只在连接真的断开时中断；响应正常结束不算
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]);

  /** @type {Array<{code: string; message: string}>} */
  const notices = [];
  const payload = { model, messages, temperature, stream: wantStream };
  if (enableTools) payload.tools = enableQuestTools ? [TASK_TOOL, ...QUEST_TOOLS] : [TASK_TOOL];

  let response = await callChatCompletions({ baseUrl, apiKey, payload, signal });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    // AC-4.5：模型明确拒绝 tools 时，去掉 tools 重试一次
    const toolRelated = enableTools && response.status === 400 && /tool|function/i.test(errText);
    if (toolRelated) {
      notices.push({
        code: 'tools_unsupported',
        message: '该模型不支持工具调用，已自动降级为纯文本模式；需求仍会通过抽取通道识别',
      });
      delete payload.tools;
      response = await callChatCompletions({ baseUrl, apiKey, payload, signal });
      if (!response.ok) {
        const retryText = await response.text().catch(() => '');
        const mapped = mapUpstreamError(response.status, retryText);
        throw new HttpError(response.status === 401 || response.status === 429 ? 502 : 502, mapped.code, mapped.message);
      }
    } else {
      const mapped = mapUpstreamError(response.status, errText);
      throw new HttpError(502, mapped.code, mapped.message);
    }
  }

  /* ---------------- 非流式 ---------------- */
  if (!wantStream) {
    const raw = await response.text().catch(() => '');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new HttpError(502, 'upstream_error', '上游返回了非 JSON 响应');
    }
    const message = parsed?.choices?.[0]?.message ?? {};
    /** @type {Array<{index: number; id: string; task: Record<string, unknown>}>} */
    const toolCalls = [];
    /** @type {Array<{index: number; id: string; event: Record<string, unknown>}>} */
    const questCalls = [];
    for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
      const name = String(call?.function?.name ?? '');
      const args = parseJsonLoose(call?.function?.arguments ?? '');
      if (name === 'create_task') {
        const result = normalizeExtractedTask(args);
        if (result.ok) toolCalls.push({ index: toolCalls.length, id: String(call?.id ?? ''), task: result.task });
        else notices.push({ code: 'tool_call_rejected', message: `模型提交的任务参数不合法：${result.reason}` });
        continue;
      }
      if (!enableQuestTools || !QUEST_TOOL_NAMES.includes(name)) continue;
      const mapped = mapQuestToolCall(name, args);
      if (mapped.ok) questCalls.push({ index: questCalls.length, id: String(call?.id ?? ''), event: mapped.event });
      else notices.push({ code: 'quest_call_rejected', message: `模型提交的委托参数不合法：${mapped.reason}` });
    }
    sendJson(res, 200, {
      text: typeof message.content === 'string' ? message.content : '',
      reasoning: typeof message.reasoning_content === 'string' ? message.reasoning_content : '',
      toolCalls,
      questCalls,
      notices,
      usage: parsed?.usage ?? null,
    });
    return;
  }

  /* ---------------- 流式 ---------------- */
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  const write = (payloadOut) => {
    if (!res.writableEnded && !res.destroyed) res.write(sseEncode(payloadOut));
  };
  for (const notice of notices) write({ type: 'notice', ...notice });

  const assembler = new ToolCallAssembler();
  let usage = null;
  let streamFailed = false;

  try {
    if (!response.body) throw new Error('上游没有返回响应体');
    for await (const event of iterateSse(response.body)) {
      if (event.done) break;
      if (event.malformed) {
        write({ type: 'notice', code: 'malformed_chunk', message: '忽略了上游一个无法解析的数据块' });
        continue;
      }
      const { value, malformed } = parseSseData(event.data);
      if (malformed !== undefined) {
        write({ type: 'notice', code: 'malformed_chunk', message: '忽略了上游一个无法解析的数据块' });
        continue;
      }
      const choice = value?.choices?.[0];
      const delta = choice?.delta ?? {};
      if (typeof delta.content === 'string' && delta.content) write({ type: 'delta', text: delta.content });
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
        write({ type: 'reasoning', text: delta.reasoning_content });
      }
      if (delta.tool_calls) assembler.push(delta.tool_calls);
      if (value?.usage) usage = value.usage;
      if (choice?.finish_reason === 'error') streamFailed = true;
    }
  } catch (err) {
    if (controller.signal.aborted) {
      if (!res.writableEnded) res.end();
      return;
    }
    const mapped =
      err?.name === 'TimeoutError'
        ? { code: 'upstream_timeout', message: '等待模型响应超时（180 秒），已中断本次生成' }
        : mapFetchFailure(err);
    write({ type: 'error', code: mapped.code, message: mapped.message });
  }

  if (!streamFailed) {
    // 流结束后统一 flush 拼装好的工具调用（AC-4.2）
    for (const slot of assembler.list()) {
      const args = parseJsonLoose(slot.args);
      if (slot.name === 'create_task') {
        const result = normalizeExtractedTask(args);
        if (result.ok) write({ type: 'tool_call', index: slot.index, task: result.task });
        else write({ type: 'notice', code: 'tool_call_rejected', message: `模型提交的任务参数不合法：${result.reason}` });
        continue;
      }
      if (!enableQuestTools || !QUEST_TOOL_NAMES.includes(slot.name)) continue;
      const mapped = mapQuestToolCall(slot.name, args);
      if (mapped.ok) write({ index: slot.index, ...mapped.event });
      else write({ type: 'notice', code: 'quest_call_rejected', message: `模型提交的委托参数不合法：${mapped.reason}` });
    }
  }
  if (usage) write({ type: 'usage', usage });
  write({ type: 'done' });
  if (!res.writableEnded) res.end();
}

/* ------------------------------------------------------------------ *
 * POST /api/extract
 * ------------------------------------------------------------------ */
async function handleExtract(req, res) {
  const body = await readJsonBody(req);
  const { baseUrl, apiKey, model } = resolveCredentials(body);

  const text = String(body.text ?? '').trim();
  if (!text) throw new HttpError(400, 'invalid_text', 'text 不能为空');
  const clipped = text.slice(0, MAX_EXTRACT_CHARS);
  const maxTasks = clampNumber(body.maxTasks, 1, 10, 5);
  const context = String(body.context ?? '').slice(0, 2000);

  const payload = {
    model,
    messages: [
      { role: 'system', content: EXTRACT_SYSTEM_PROMPT },
      { role: 'user', content: buildExtractPrompt(clipped, context, maxTasks) },
    ],
    temperature: 0,
    stream: false,
    max_tokens: 1200,
    response_format: { type: 'json_object' },
  };

  const signal = AbortSignal.timeout(60000);
  let response = await callChatCompletions({ baseUrl, apiKey, payload, signal });

  if (!response.ok && response.status === 400) {
    const errText = await response.text().catch(() => '');
    if (/response_format|json_object/i.test(errText)) {
      // 上游不支持 JSON 模式，去掉该字段重试
      delete payload.response_format;
      response = await callChatCompletions({ baseUrl, apiKey, payload, signal });
      if (!response.ok) {
        const retryText = await response.text().catch(() => '');
        const mapped = mapUpstreamError(response.status, retryText);
        throw new HttpError(502, mapped.code, mapped.message);
      }
    } else {
      const mapped = mapUpstreamError(response.status, errText);
      throw new HttpError(502, mapped.code, mapped.message);
    }
  } else if (!response.ok) {
    const errText = await response.text().catch(() => '');
    const mapped = mapUpstreamError(response.status, errText);
    throw new HttpError(502, mapped.code, mapped.message);
  }

  const raw = await response.text().catch(() => '');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError(502, 'upstream_error', '上游返回了非 JSON 响应');
  }
  const content = parsed?.choices?.[0]?.message?.content ?? '';
  const json = parseJsonLoose(typeof content === 'string' ? content : '');
  if (!json) {
    throw new HttpError(422, 'invalid_json', '模型没有返回可解析的 JSON', { raw: String(content).slice(0, 500) });
  }
  const tasks = collectTasksFromExtraction(json).slice(0, maxTasks);
  sendJson(res, 200, { tasks });
}

/* ------------------------------------------------------------------ *
 * 服务器
 * ------------------------------------------------------------------ */
const server = http.createServer(async (req, res) => {
  applyCors(req, res);
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const pathname = url.pathname;

  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (pathname === '/api/health' && req.method === 'GET') {
      handleHealth(res);
      return;
    }
    if (pathname === '/api/models' && req.method === 'POST') {
      await handleModels(req, res);
      return;
    }
    if (pathname === '/api/chat' && req.method === 'POST') {
      await handleChat(req, res);
      return;
    }
    if (pathname === '/api/extract' && req.method === 'POST') {
      await handleExtract(req, res);
      return;
    }
    if (pathname.startsWith('/api/')) {
      sendError(res, 404, 'not_found', `接口不存在：${req.method} ${pathname}`);
      return;
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (looksLikeTraversal(req.url ?? '')) {
        sendError(res, 403, 'forbidden_path', '非法的资源路径');
        return;
      }
      if (FORCE_SERVE_DIST || fs.existsSync(path.join(DIST_DIR, 'index.html'))) {
        const served = await serveStatic(req, res, DIST_DIR, pathname);
        if (served) return;
      }
      sendError(res, 404, 'not_found', '未找到该资源；开发模式请访问 Vite 端口，生产模式请先执行 pnpm build');
      return;
    }
    sendError(res, 405, 'method_not_allowed', `不支持的方法：${req.method}`);
  } catch (err) {
    handleError(res, err);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const defaults = serverDefaults();
  console.log(`[api] ${SERVER_NAME} v${VERSION} 监听 http://127.0.0.1:${PORT}`);
  console.log(`[api] 默认模型 ${defaults.model} @ ${defaults.baseUrl}，服务端 Key：${defaults.hasKey ? '已配置' : '未配置'}`);
  const hasDist = fs.existsSync(path.join(DIST_DIR, 'index.html'));
  console.log(`[api] 静态托管：${FORCE_SERVE_DIST || hasDist ? `开启（${DIST_DIR}）` : '未开启（dist 不存在）'}`);
});

server.on('error', (err) => {
  if (err?.code === 'EADDRINUSE') {
    console.error(`[api] 端口 ${PORT} 已被占用，请换端口：node server/index.mjs --port 8788`);
  } else {
    console.error('[api] 启动失败:', err?.message ?? err);
  }
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 300).unref();
  });
}
