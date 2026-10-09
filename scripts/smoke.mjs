/**
 * 端到端冒烟（不需要真实模型即可跑通；有 AI_API_KEY 时额外验证真实调用）。
 * 用法：node scripts/smoke.mjs [baseUrl]
 * 默认会在 8799 端口自行拉起一个后端实例，并在结束后关闭。
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.SMOKE_PORT ?? 8799);
const MOCK_PORT = Number(process.env.SMOKE_MOCK_PORT ?? 8801);
const EXTERNAL = process.argv[2] ?? '';
const BASE = EXTERNAL || `http://127.0.0.1:${PORT}`;

/** @type {Array<{id: string; ok: boolean; detail: string}>} */
const results = [];

function check(id, ok, detail) {
  results.push({ id, ok, detail });
  console.log(`${ok ? '\u2714' : '\u2716'} ${id} ${detail}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  let parsed = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed };
}

/** 直接发原始路径，绕开 fetch 对 .. 的归一化 */
function rawGet(rawPath) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: rawPath, method: 'GET' }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', () => resolve(0));
    req.end();
  });
}

/* ------------------------------------------------------------------ *
 * 模拟上游：一个只会说 OpenAI 兼容 SSE 的假模型
 * ------------------------------------------------------------------ */

let mockRejectTools = false;
let mockServer = null;

function startMockUpstream() {
  mockServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      let payload = {};
      try {
        payload = JSON.parse(body || '{}');
      } catch {
        /* 忽略 */
      }
      const wantsTools = Array.isArray(payload.tools) && payload.tools.length > 0;

      if (mockRejectTools && wantsTools) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'this model does not support tools / functions' } }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      /** @type {unknown[]} */
      const chunks = [
        { choices: [{ delta: { content: '好的，' } }] },
        { choices: [{ delta: { content: '我记下了。' } }] },
      ];
      if (wantsTools) {
        // 故意把 tool_calls 的 arguments 拆成两个分片，验证服务端拼装能力
        chunks.push({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'call_1', function: { name: 'create_task', arguments: '{"title":"自动提' } },
                ],
              },
            },
          ],
        });
        chunks.push({
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '醒","detail":"到点提醒值班人"}' } }] } }],
        });
        chunks.push({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        chunks.push({ choices: [{ delta: {}, finish_reason: 'stop' }] });
      }
      chunks.push({ choices: [{ delta: {} }], usage: { prompt_tokens: 11, completion_tokens: 22 } });

      for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((resolve) => mockServer.listen(MOCK_PORT, '127.0.0.1', () => resolve(true)));
}

function stopMockUpstream() {
  if (mockServer) {
    try {
      mockServer.close();
    } catch {
      /* 忽略 */
    }
  }
}

/* ------------------------------------------------------------------ */

let child = null;

function startServer() {
  // 剥掉 AI_* 环境变量，让"无凭据"用例的结果不受本机配置影响
  const env = { ...process.env };
  delete env.AI_API_KEY;
  delete env.AI_BASE_URL;
  delete env.AI_MODEL;
  child = spawn(process.execPath, ['server/index.mjs', '--port', String(PORT)], {
    cwd: ROOT,
    stdio: 'ignore',
    env,
  });
}

function stopServer() {
  if (child && child.exitCode === null) {
    try {
      child.kill();
    } catch {
      /* 忽略 */
    }
  }
}

async function waitForHealth(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  return false;
}

/* ------------------------------------------------------------------ */

async function main() {
  if (!EXTERNAL) startServer();
  const alive = await waitForHealth();
  if (!alive) {
    check('S-00', false, `后端在 ${BASE} 未就绪，请检查端口占用或启动日志`);
    return;
  }

  // S-01 健康检查
  const health = await fetch(`${BASE}/api/health`);
  const healthBody = await health.json();
  check(
    'S-01',
    health.status === 200 && healthBody.ok === true && typeof healthBody.defaults === 'object',
    `GET /api/health → ${health.status}`,
  );

  // S-02 无凭据
  const noCreds = await postJSON(`${BASE}/api/chat`, {
    baseUrl: 'https://example.com/v1',
    apiKey: '',
    messages: [{ role: 'user', content: '你好' }],
  });
  check(
    'S-02',
    noCreds.status === 400 && noCreds.body?.error?.code === 'missing_credentials',
    `空凭据 → ${noCreds.status} ${noCreds.body?.error?.code ?? ''}`,
  );

  // S-03 非法协议
  const badBase = await postJSON(`${BASE}/api/chat`, {
    baseUrl: 'ftp://example.com',
    apiKey: 'sk-dummy',
    messages: [{ role: 'user', content: '你好' }],
  });
  check(
    'S-03',
    badBase.status === 400 && badBase.body?.error?.code === 'invalid_base_url',
    `ftp 协议 → ${badBase.status} ${badBase.body?.error?.code ?? ''}`,
  );

  // S-04 空 messages
  const badMessages = await postJSON(`${BASE}/api/chat`, {
    baseUrl: 'https://example.com/v1',
    apiKey: 'sk-dummy',
    messages: [],
  });
  check(
    'S-04',
    badMessages.status === 400 && badMessages.body?.error?.code === 'invalid_messages',
    `空 messages → ${badMessages.status} ${badMessages.body?.error?.code ?? ''}`,
  );

  // S-05 抽取接口无凭据
  const badExtract = await postJSON(`${BASE}/api/extract`, { text: '我需要一个排班工具' });
  check(
    'S-05',
    badExtract.status === 400 && badExtract.body?.error?.code === 'missing_credentials',
    `抽取空凭据 → ${badExtract.status} ${badExtract.body?.error?.code ?? ''}`,
  );

  // S-06 请求体超限
  const big = JSON.stringify({
    baseUrl: 'https://example.com/v1',
    apiKey: 'sk-dummy',
    messages: [{ role: 'user', content: 'a'.repeat(2 * 1024 * 1024) }],
  });
  const tooLarge = await postJSON(`${BASE}/api/chat`, big);
  check('S-06', tooLarge.status === 413, `2MB 请求体 → ${tooLarge.status}`);

  // S-07 路径穿越
  let traversalOk = true;
  const traversalDetail = [];
  if (!EXTERNAL) {
    for (const attack of ['/..%2f..%2fpackage.json', '/%2e%2e/%2e%2e/package.json', '/../../server/index.mjs']) {
      const status = await rawGet(attack);
      traversalDetail.push(`${attack}→${status}`);
      if (status >= 200 && status < 300) traversalOk = false;
    }
  } else {
    traversalDetail.push('外部服务模式跳过');
  }
  check('S-07', traversalOk, `路径穿越被拒：${traversalDetail.join(', ')}`);

  // S-10 静态托管（dist 存在时）
  if (fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    const page = await fetch(`${BASE}/`);
    const html = await page.text();
    check(
      'S-10',
      page.status === 200 && html.includes('<div id="root">'),
      `GET / → ${page.status}，${html.length} 字节`,
    );
  } else {
    check('S-10', true, 'dist 不存在，跳过静态托管检查（先执行 pnpm build）');
  }

  // S-11 / S-12 用模拟上游验证流式拼装与降级重试（无需真实 Key）
  if (!EXTERNAL) {
    await startMockUpstream();
    const mockBase = `http://127.0.0.1:${MOCK_PORT}/v1`;

    mockRejectTools = false;
    const chat = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseUrl: mockBase,
        apiKey: 'sk-mock',
        model: 'mock-model',
        stream: true,
        enableTools: true,
        messages: [{ role: 'user', content: '需要一个自动提醒' }],
      }),
    });
    const streamText = await chat.text();
    const deltaText = (streamText.match(/"type":"delta"/g) ?? []).length;
    const toolCallMatch = streamText.match(/"type":"tool_call"[^\n]*/);
    check(
      'S-11',
      chat.status === 200 &&
        deltaText >= 2 &&
        streamText.includes('"type":"done"') &&
        Boolean(toolCallMatch) &&
        streamText.includes('自动提醒'),
      `模拟上游流式 → ${chat.status}，delta=${deltaText}，tool_call 拼装=${Boolean(toolCallMatch)}`,
    );

    mockRejectTools = true;
    const retry = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseUrl: mockBase,
        apiKey: 'sk-mock',
        model: 'mock-model',
        stream: true,
        enableTools: true,
        messages: [{ role: 'user', content: '需要一个自动提醒' }],
      }),
    });
    const retryText = await retry.text();
    check(
      'S-12',
      retry.status === 200 &&
        retryText.includes('tools_unsupported') &&
        retryText.includes('"type":"done"') &&
        !retryText.includes('"type":"tool_call"'),
      `模型拒绝 tools 时自动降级重试（AC-4.5）`,
    );
    stopMockUpstream();
  } else {
    console.log('· 外部服务模式，跳过 S-11 / S-12 模拟上游用例');
  }

  // S-08 / S-09 真实调用（需自备凭据）
  const apiKey = process.env.AI_API_KEY ?? '';
  if (!apiKey) {
    console.log('\n· 未检测到 AI_API_KEY，跳过 S-08 / S-09 真实调用用例');
  } else {
    const baseUrl = process.env.AI_BASE_URL ?? 'https://api.deepseek.com/v1';
    const model = process.env.AI_MODEL ?? 'deepseek-chat';

    const extract = await postJSON(`${BASE}/api/extract`, {
      baseUrl,
      apiKey,
      model,
      text: '这个工具最好还能把排班结果导出成 Excel，方便发给财务。',
    });
    check(
      'S-08',
      extract.status === 200 && Array.isArray(extract.body?.tasks),
      `真实抽取 → ${extract.status}，得到 ${extract.body?.tasks?.length ?? '?'} 条任务`,
    );

    const chat = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseUrl,
        apiKey,
        model,
        stream: true,
        enableTools: true,
        messages: [
          { role: 'system', content: '你是助手。当对方提出需求时调用 create_task 登记。' },
          { role: 'user', content: '我需要一个自动提醒功能。' },
        ],
      }),
    });
    const text = await chat.text();
    const hasDelta = text.includes('"type":"delta"');
    const hasDone = text.includes('"type":"done"');
    const hasToolCall = text.includes('"type":"tool_call"');
    check(
      'S-09',
      chat.status === 200 && hasDelta && hasDone,
      `真实流式 → ${chat.status}，delta=${hasDelta} done=${hasDone} tool_call=${hasToolCall}`,
    );
  }
}

/* ------------------------------------------------------------------ */

try {
  await main();
} catch (err) {
  check('S-XX', false, `冒烟脚本异常：${err?.message ?? err}`);
} finally {
  stopServer();
  stopMockUpstream();
}

const failed = results.filter((item) => !item.ok);
console.log(`\n=== 冒烟结果：${results.length - failed.length}/${results.length} 通过 ===`);
if (failed.length > 0) {
  for (const item of failed) console.log(`  失败 ${item.id}: ${item.detail}`);
  process.exitCode = 1;
}
