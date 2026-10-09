/**
 * U-05 / U-07 / U-08：任务参数校验、JSON 容错解析、工具分片拼装、路径穿越防护、URL 归一化。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  ToolCallAssembler,
  collectTasksFromExtraction,
  mapUpstreamError,
  normalizeExtractedTask,
  parseJsonLoose,
  resolveApiRoot,
} from '../server/lib/ai.mjs';
import { HttpError, resolveWithin } from '../server/lib/http.mjs';
import { iterateSse, sseEncode } from '../server/lib/sse.mjs';

describe('U-05 任务参数校验', () => {
  it('合法参数通过并补全默认值', () => {
    const result = normalizeExtractedTask({ title: '自动提醒', detail: '到点提醒值班人' });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.task.title, '自动提醒');
      assert.equal(result.task.category, 'feature');
      assert.equal(result.task.priority, 'P1');
      assert.deepEqual(result.task.acceptance, []);
    }
  });

  it('缺少 title / title 为空 / 非对象一律拒绝并说明原因', () => {
    for (const bad of [{ detail: '没有标题' }, { title: '   ' }, null, 'string', 42, []]) {
      const result = normalizeExtractedTask(bad);
      assert.equal(result.ok, false, `应拒绝：${JSON.stringify(bad)}`);
      if (!result.ok) assert.ok(result.reason.length > 0);
    }
  });

  it('非法枚举回退为默认值，超量验收要点被截断', () => {
    const result = normalizeExtractedTask({
      title: '导出',
      category: 'nonsense',
      priority: 'P9',
      acceptance: ['a', 'b', 'c', 'd', 'e'],
      confidence: 5,
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.task.category, 'feature');
      assert.equal(result.task.priority, 'P1');
      assert.equal(result.task.acceptance.length, 3);
      assert.equal(result.task.confidence, 1);
    }
  });
});

describe('U-07 JSON 容错解析', () => {
  it('解析裸 JSON', () => {
    assert.deepEqual(parseJsonLoose('{"tasks":[]}'), { tasks: [] });
  });

  it('剥离 markdown 代码围栏', () => {
    assert.deepEqual(parseJsonLoose('```json\n{"tasks":[{"title":"a"}]}\n```'), { tasks: [{ title: 'a' }] });
  });

  it('从前后夹杂解释文字中抠出 JSON', () => {
    const text = '好的，我分析如下：\n{"tasks":[{"title":"导出 Excel"}]}\n以上。';
    const parsed = parseJsonLoose(text);
    assert.deepEqual(parsed, { tasks: [{ title: '导出 Excel' }] });
  });

  it('处理字符串里的花括号不误判边界', () => {
    const parsed = parseJsonLoose('前缀 {"tasks":[{"title":"支持 {花括号} 的标题"}]} 后缀');
    assert.equal(parsed.tasks[0].title, '支持 {花括号} 的标题');
  });

  it('完全非法的文本返回 null', () => {
    assert.equal(parseJsonLoose('这里没有任何结构化内容'), null);
    assert.equal(parseJsonLoose(''), null);
    assert.equal(parseJsonLoose(null), null);
  });

  it('collectTasksFromExtraction 丢弃脏数据只留合法项', () => {
    const tasks = collectTasksFromExtraction({ tasks: [{ title: '好任务' }, { detail: '无标题' }, null] });
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].title, '好任务');
  });
});

describe('U-05 流式 tool_calls 拼装（AC-4.2）', () => {
  it('按 index 聚合分片参数', () => {
    const assembler = new ToolCallAssembler();
    assembler.push([{ index: 0, id: 'call_1', function: { name: 'create_task', arguments: '{"title":"自' } }]);
    assembler.push([{ index: 0, function: { arguments: '动提醒","detail":"到点提醒"}' } }]);
    const list = assembler.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 'create_task');
    const parsed = parseJsonLoose(list[0].args);
    assert.equal(parsed.title, '自动提醒');
  });

  it('多个工具调用互不干扰', () => {
    const assembler = new ToolCallAssembler();
    assembler.push([{ index: 0, function: { name: 'create_task', arguments: '{"title":"A","detail":"a"}' } }]);
    assembler.push([{ index: 1, function: { name: 'create_task', arguments: '{"title":"B","detail":"b"}' } }]);
    const titles = assembler.list().map((slot) => parseJsonLoose(slot.args).title);
    assert.deepEqual(titles, ['A', 'B']);
  });
});

describe('URL 归一化与错误映射', () => {
  it('补齐 /v1 与 /chat/completions 各种写法', () => {
    assert.equal(resolveApiRoot('https://api.deepseek.com'), 'https://api.deepseek.com/v1');
    assert.equal(resolveApiRoot('https://api.deepseek.com/'), 'https://api.deepseek.com/v1');
    assert.equal(resolveApiRoot('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1');
    assert.equal(resolveApiRoot('https://api.deepseek.com/v1/'), 'https://api.deepseek.com/v1');
    assert.equal(resolveApiRoot('https://api.deepseek.com/v1/chat/completions'), 'https://api.deepseek.com/v1');
    assert.equal(resolveApiRoot('http://localhost:11434/v1'), 'http://localhost:11434/v1');
  });

  it('拒绝非 http(s) 协议', () => {
    assert.throws(() => resolveApiRoot('ftp://example.com'), (err) => err instanceof HttpError && err.code === 'invalid_base_url');
    assert.throws(() => resolveApiRoot('不是网址'), (err) => err instanceof HttpError);
  });

  it('上游状态码映射为契约里的错误码', () => {
    assert.equal(mapUpstreamError(401, '').code, 'upstream_401');
    assert.equal(mapUpstreamError(429, '').code, 'upstream_429');
    assert.equal(mapUpstreamError(503, '').code, 'upstream_5xx');
    assert.equal(mapUpstreamError(418, 'teapot').code, 'upstream_4xx');
  });
});

describe('U-08 静态资源路径穿越防护（AC-6.2）', () => {
  const root = path.resolve('D:/exampleProduct/dist');

  it('正常路径被解析到 root 内', () => {
    assert.ok(resolveWithin(root, '/index.html')?.startsWith(root));
    assert.ok(resolveWithin(root, '/assets/app.js')?.startsWith(root));
    assert.equal(resolveWithin(root, '/'), root);
  });

  it('各种穿越写法一律返回 null', () => {
    for (const attack of [
      '/../server/index.mjs',
      '/..%2f..%2fpackage.json',
      '/static/../../package.json',
      '/%2e%2e/%2e%2e/package.json',
      '/..\\..\\package.json',
      '/a/../../../etc/passwd',
    ]) {
      assert.equal(resolveWithin(root, attack), null, `未拦截：${attack}`);
    }
  });
});

describe('SSE 编解码', () => {
  it('sseEncode 产出合法的事件块', () => {
    assert.equal(sseEncode({ type: 'delta', text: '好的' }), 'data: {"type":"delta","text":"好的"}\n\n');
  });

  it('iterateSse 能跨 chunk 正确切分事件', async () => {
    const encoder = new TextEncoder();
    const chunks = [encoder.encode('data: {"a":1}\n\ndata: {"b"'), encoder.encode(':2}\n\ndata: [DONE]\n\n')];
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    const events: Array<{ data?: string; done?: boolean }> = [];
    for await (const event of iterateSse(stream)) events.push(event);
    assert.equal(events.length, 3);
    assert.equal(events[0].data, '{"a":1}');
    assert.equal(events[1].data, '{"b":2}');
    assert.equal(events[2].done, true);
  });
});
