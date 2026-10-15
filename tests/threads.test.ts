/**
 * 对话线索切分（纯逻辑）：每个 NPC 一条独立会话，互不污染。
 *
 * 这一层必须自己可单测 —— React 胶水进不了 `node --test`（.tsx 没法被类型剥离），
 * 所以切分逻辑刻意抽在 `src/lib/threads.ts` 里，而不是写在 store 里。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DESK_THREAD_ID,
  messagesOfThread,
  normalizeThreadId,
  threadIdFor,
  threadMessageCounts,
} from '../src/lib/threads.ts';
import type { Settings } from '../src/types.ts';

function settings(patch: Partial<Settings> = {}): Pick<Settings, 'chatMode' | 'questNpcId'> {
  return { chatMode: 'npc', questNpcId: 'su-wanzhao', ...patch };
}

describe('对话线索：每条线索一段独立会话', () => {
  it('npc 模式下一人一线索，desk 模式归需求台', () => {
    assert.equal(threadIdFor(settings()), 'su-wanzhao');
    assert.equal(threadIdFor(settings({ questNpcId: 'lu-xingzhou' })), 'lu-xingzhou');
    assert.equal(threadIdFor(settings({ questNpcId: 'a-lai' })), 'a-lai');
    assert.equal(threadIdFor(settings({ chatMode: 'desk' })), DESK_THREAD_ID);
    // desk 模式下 questNpcId 不参与线索判定
    assert.equal(threadIdFor(settings({ chatMode: 'desk', questNpcId: 'lu-xingzhou' })), DESK_THREAD_ID);
  });

  it('旧存档里没有线索字段的消息一律归需求台（避免第一轮串戏）', () => {
    assert.equal(normalizeThreadId(undefined), DESK_THREAD_ID);
    assert.equal(normalizeThreadId(null), DESK_THREAD_ID);
    assert.equal(normalizeThreadId(''), DESK_THREAD_ID);
    assert.equal(normalizeThreadId('   '), DESK_THREAD_ID);
    assert.equal(normalizeThreadId(42), DESK_THREAD_ID);
    assert.equal(normalizeThreadId({}), DESK_THREAD_ID);
    assert.equal(normalizeThreadId(' su-wanzhao '), 'su-wanzhao');
  });

  it('按线索取消息：各自独立、顺序不变、原数组不动', () => {
    const messages: Array<{ id: string; npcId?: string; content: string }> = [
      { id: '1', npcId: 'su-wanzhao', content: '三七' },
      { id: '2', npcId: 'lu-xingzhou', content: '走商' },
      { id: '3', content: '老对话' }, // 旧存档 → 归需求台
      { id: '4', npcId: 'su-wanzhao', content: '再说一句' },
    ];
    assert.deepEqual(
      messagesOfThread(messages, 'su-wanzhao').map((m) => m.id),
      ['1', '4'],
    );
    assert.deepEqual(
      messagesOfThread(messages, 'lu-xingzhou').map((m) => m.id),
      ['2'],
    );
    assert.deepEqual(
      messagesOfThread(messages, DESK_THREAD_ID).map((m) => m.id),
      ['3'],
    );
    assert.deepEqual(messagesOfThread(messages, 'a-lai'), []);
    assert.equal(messages.length, 4); // 切片不改原数据
  });

  it('切走再切回，另一位的历史原样还在（不丢数据）', () => {
    const messages: Array<{ id: string; npcId?: string; content: string }> = [
      { id: 'a', npcId: 'su-wanzhao', content: '药' },
      { id: 'b', npcId: 'lu-xingzhou', content: '货' },
    ];
    // 切到陆行舟：只看得到他的
    assert.deepEqual(messagesOfThread(messages, 'lu-xingzhou').map((m) => m.content), ['货']);
    // 再切回苏晚照：她的那条还在
    assert.deepEqual(messagesOfThread(messages, 'su-wanzhao').map((m) => m.content), ['药']);
  });

  it('按线索计数（给切换器显示用）', () => {
    const counts = threadMessageCounts([
      { npcId: 'su-wanzhao' },
      { npcId: 'su-wanzhao' },
      { npcId: 'lu-xingzhou' },
      {}, // 旧的、没线索的
    ]);
    assert.deepEqual(counts, { 'su-wanzhao': 2, 'lu-xingzhou': 1, [DESK_THREAD_ID]: 1 });
  });
});
