/**
 * U-06：抽取通道编排与降级（注入假 fetch，不产生真实网络请求）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_SETTINGS } from '../src/lib/settings.ts';
import { pickEvidence, runExtraction, taskFromCandidate } from '../src/lib/extract.ts';
import type { Settings } from '../src/types.ts';

function settingsWith(patch: Partial<Settings>): Settings {
  return { ...DEFAULT_SETTINGS, ...patch };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('抽取通道编排', () => {
  it("extractMode='off' 时不产出候选，且完全不触网", async () => {
    let calls = 0;
    const fakeFetch: typeof fetch = async () => {
      calls += 1;
      throw new Error('不应被调用');
    };
    const outcome = await runExtraction({
      text: '我需要一个排班工具',
      settings: settingsWith({ extractMode: 'off', apiKey: 'sk-test' }),
      serverHasKey: false,
      existingTitles: [],
      sourceMessageId: 'msg-1',
      fetchImpl: fakeFetch,
    });
    assert.equal(outcome.candidates.length, 0);
    assert.equal(outcome.channel, 'none');
    assert.equal(calls, 0);
  });

  it('规则未命中时（auto 模式）不调用模型', async () => {
    let calls = 0;
    const fakeFetch: typeof fetch = async () => {
      calls += 1;
      return jsonResponse({ tasks: [] });
    };
    const outcome = await runExtraction({
      text: '今天天气不错，我们聊点别的吧。',
      settings: settingsWith({ extractMode: 'auto', apiKey: 'sk-test' }),
      serverHasKey: false,
      existingTitles: [],
      sourceMessageId: 'msg-1',
      fetchImpl: fakeFetch,
    });
    assert.equal(calls, 0);
    assert.equal(outcome.triggered, false);
    assert.equal(outcome.candidates.length, 0);
  });

  it('FR-006 无凭据时降级为规则候选且不抛错', async () => {
    const outcome = await runExtraction({
      text: '我需要一个能给团队用的值班排班工具',
      settings: settingsWith({ apiKey: '' }),
      serverHasKey: false,
      existingTitles: [],
      sourceMessageId: 'msg-1',
      fetchImpl: async () => {
        throw new Error('不应被调用');
      },
    });
    assert.ok(outcome.candidates.length >= 1);
    assert.equal(outcome.candidates[0].origin, 'rule');
    assert.equal(outcome.candidates[0].sourceMessageId, 'msg-1');
    assert.match(outcome.note ?? '', /降级/);
  });

  it('模型抽取失败时回退规则，不冒泡异常（AC-5.4）', async () => {
    const outcome = await runExtraction({
      text: '最好还能把排班结果导出成 Excel',
      settings: settingsWith({ apiKey: 'sk-test' }),
      serverHasKey: false,
      existingTitles: [],
      sourceMessageId: 'msg-2',
      fetchImpl: async () => {
        throw new Error('网络炸了');
      },
    });
    assert.equal(outcome.channel, 'rule');
    assert.ok(outcome.candidates.length >= 1);
    assert.match(outcome.note ?? '', /回退规则/);
  });

  it('有凭据且模型返回结果时走 LLM 通道', async () => {
    const outcome = await runExtraction({
      text: '另外我还需要一个自动提醒的功能',
      settings: settingsWith({ apiKey: 'sk-test' }),
      serverHasKey: false,
      existingTitles: [],
      sourceMessageId: 'msg-3',
      fetchImpl: async () =>
        jsonResponse({
          tasks: [
            {
              title: '自动提醒',
              detail: '排班后自动提醒值班人',
              category: 'feature',
              priority: 'P1',
              acceptance: ['到点能收到提醒'],
              confidence: 0.88,
            },
            { title: '', detail: '脏数据，应被丢弃' },
          ],
        }),
    });
    assert.equal(outcome.channel, 'llm');
    assert.equal(outcome.candidates.length, 1);
    assert.equal(outcome.candidates[0].origin, 'llm');
    assert.equal(outcome.candidates[0].title, '自动提醒');
    assert.deepEqual(outcome.candidates[0].acceptance, ['到点能收到提醒']);
  });

  it('与既有任务重复的候选会被丢弃（AC-9.1）', async () => {
    const outcome = await runExtraction({
      text: '我需要支持换班申请',
      settings: settingsWith({ apiKey: '' }),
      serverHasKey: false,
      existingTitles: ['支持换班申请'],
      sourceMessageId: 'msg-4',
    });
    assert.equal(outcome.candidates.length, 0);
    assert.ok(outcome.dropped.length >= 1);
  });

  it('pickEvidence 会挑出与原话最贴近的一句', () => {
    const text = '先说说别的。\n排班表要能导出 Excel 文件。\n今天就聊到这。';
    const evidence = pickEvidence(text, '导出 Excel');
    assert.match(evidence, /Excel/);
  });

  it('taskFromCandidate 生成 pending 任务并保留溯源信息', () => {
    const task = taskFromCandidate({
      id: 'cand-1',
      title: '自动提醒',
      detail: '排班后自动提醒',
      category: 'feature',
      priority: 'P1',
      acceptance: ['能收到提醒'],
      confidence: 0.8,
      origin: 'llm',
      evidence: '排班后自动提醒值班人',
      sourceMessageId: 'msg-9',
      triggerReasons: ['模型主动调用 create_task'],
      createdAt: Date.now(),
    });
    assert.equal(task.status, 'pending');
    assert.equal(task.sourceMessageId, 'msg-9');
    assert.equal(task.origin, 'llm');
    assert.notEqual(task.id, 'cand-1');
  });
});
