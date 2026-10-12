/**
 * U-21：委托工具的参数归一化。
 * 服务端只做**形状收敛**，不做规则裁决 —— 边界由本文件的两条断言钉住。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  QUEST_TOOL_NAMES,
  QUEST_TOOLS,
  mapQuestToolCall,
  normalizeQuestDecline,
  normalizeQuestProposal,
  normalizeQuestSubmission,
} from '../server/lib/quest-tools.mjs';

/** 服务端模块返回的是联合类型，这里统一取"拒绝原因" */
function reasonOf(result: unknown): string {
  const value = result as { ok?: boolean; reason?: string };
  return value.ok === false ? String(value.reason ?? '') : '';
}

function proposal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: '寻一味三七',
    want: '我旧疾复发，需一味三七入药',
    tier: 2,
    objective_kind: 'deliver_item',
    objective_item_id: 'sanqi',
    objective_count: 1,
    reward_kind: 'item',
    reward_item_id: 'jinchuang-gao',
    reward_count: 1,
    ...overrides,
  };
}

describe('工具定义', () => {
  it('三个工具都是提案，没有一个是执行', () => {
    assert.deepEqual(
      QUEST_TOOLS.map((tool) => tool.function.name),
      QUEST_TOOL_NAMES,
    );
    for (const tool of QUEST_TOOLS) {
      assert.ok(tool.function.description.length > 10, `${tool.function.name} 缺少可读描述`);
      assert.ok(Array.isArray(tool.function.parameters.required));
      assert.equal(tool.function.parameters.type, 'object');
    }
  });

  it('propose_quest 明确禁止模型自己决定收没收到东西（写进 submit_quest 描述）', () => {
    const submit = QUEST_TOOLS.find((tool) => tool.function.name === 'submit_quest');
    assert.ok(submit);
    assert.match(submit.function.description, /无权决定|系统会去核对/);
  });
});

describe('propose_quest 归一化', () => {
  it('交付型委托收敛成领域层要的形状', () => {
    const result = normalizeQuestProposal(proposal());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.proposal.objective, { kind: 'deliver_item', itemId: 'sanqi', count: 1 });
    assert.deepEqual(result.proposal.reward, { kind: 'item', itemId: 'jinchuang-gao', count: 1 });
    assert.equal(result.proposal.tier, 2);
  });

  it('对话轮数与好感度两类目标', () => {
    const talk = normalizeQuestProposal(
      proposal({ objective_kind: 'talk_count', objective_rounds: 3, objective_item_id: undefined }),
    );
    assert.equal(talk.ok, true);
    if (talk.ok) assert.deepEqual(talk.proposal.objective, { kind: 'talk_count', rounds: 3 });

    const affinity = normalizeQuestProposal(
      proposal({ objective_kind: 'affinity_at_least', objective_value: 20, objective_item_id: undefined }),
    );
    assert.equal(affinity.ok, true);
    if (affinity.ok) assert.deepEqual(affinity.proposal.objective, { kind: 'affinity_at_least', value: 20 });
  });

  it('四种非道具谢礼都能收敛', () => {
    const affinity = normalizeQuestProposal(proposal({ reward_kind: 'affinity', reward_affinity: 3 }));
    assert.equal(affinity.ok, true);
    if (affinity.ok) assert.deepEqual(affinity.proposal.reward, { kind: 'affinity', amount: 3 });

    const ability = normalizeQuestProposal(
      proposal({ reward_kind: 'ability', reward_ability: 'jieyuan', reward_item_id: undefined }),
    );
    assert.equal(ability.ok, true);
    if (ability.ok) assert.deepEqual(ability.proposal.reward, { kind: 'ability', abilityId: 'jieyuan' });

    const info = normalizeQuestProposal(proposal({ reward_kind: 'info', reward_topic: '后山有条暗道' }));
    assert.equal(info.ok, true);
    if (info.ok) assert.deepEqual(info.proposal.reward, { kind: 'info', topic: '后山有条暗道' });

    const none = normalizeQuestProposal(proposal({ reward_kind: 'none' }));
    assert.equal(none.ok, true);
    if (none.ok) assert.deepEqual(none.proposal.reward, { kind: 'none' });
  });

  it('缺字段与错枚举给出可读原因，而不是脏对象', () => {
    assert.match(reasonOf(normalizeQuestProposal(proposal({ want: '' }))), /want/);
    assert.match(reasonOf(normalizeQuestProposal(proposal({ tier: 9 }))), /tier/);
    assert.match(reasonOf(normalizeQuestProposal(proposal({ objective_kind: '让我开心就行' }))), /objective_kind/);
    assert.match(reasonOf(normalizeQuestProposal(proposal({ objective_item_id: '' }))), /objective_item_id/);
    assert.match(reasonOf(normalizeQuestProposal(proposal({ reward_kind: '黄金万两' }))), /reward_kind/);
    assert.equal(normalizeQuestProposal(null).ok, false);
    assert.equal(normalizeQuestProposal([]).ok, false);
  });

  it('offer_level 可选，越界则拒绝', () => {
    const without = normalizeQuestProposal(proposal());
    assert.equal(without.ok, true);
    if (without.ok) assert.equal('offerLevel' in without.proposal, false);

    const withLevel = normalizeQuestProposal(proposal({ offer_level: 3 }));
    assert.equal(withLevel.ok, true);
    if (withLevel.ok) assert.equal(withLevel.proposal.offerLevel, 3);

    assert.match(reasonOf(normalizeQuestProposal(proposal({ offer_level: 0 }))), /offer_level/);
  });

  it('职责边界：未登记的道具 id 在这里**照样通过**，留给前端裁决层去拒', () => {
    const result = normalizeQuestProposal(proposal({ reward_item_id: 'nope-not-registered' }));
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.proposal.reward.itemId, 'nope-not-registered');
  });
});

describe('submit_quest / decline_quest 归一化', () => {
  it('交付参数兼容扁平与嵌套两种写法', () => {
    const flat = normalizeQuestSubmission({ quest_id: 'quest-1', item_id: 'sanqi', count: 2 });
    assert.equal(flat.ok, true);
    if (flat.ok) assert.deepEqual(flat.submission, { questId: 'quest-1', deliver: { itemId: 'sanqi', count: 2 } });

    const nested = normalizeQuestSubmission({ questId: 'quest-1', deliver: { itemId: 'sanqi', count: 1 } });
    assert.equal(nested.ok, true);
    if (nested.ok) assert.deepEqual(nested.submission, { questId: 'quest-1', deliver: { itemId: 'sanqi', count: 1 } });
  });

  it('不带道具也可以提交（非交付型目标）', () => {
    const result = normalizeQuestSubmission({ quest_id: 'quest-2' });
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.submission, { questId: 'quest-2' });
  });

  it('缺 quest_id 或件数不合法时拒绝', () => {
    assert.match(reasonOf(normalizeQuestSubmission({ item_id: 'sanqi' })), /quest_id/);
    assert.match(reasonOf(normalizeQuestSubmission({ quest_id: 'q', item_id: 'sanqi', count: 0 })), /件数/);
  });

  it('婉拒只要 quest_id，理由过长会被截断', () => {
    const result = normalizeQuestDecline({ quest_id: 'quest-3', reason: '话'.repeat(200) });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.decline.questId, 'quest-3');
      assert.equal(result.decline.reason.length, 100);
    }
    assert.match(reasonOf(normalizeQuestDecline({})), /quest_id/);
  });
});

describe('工具调用派发', () => {
  it('三个工具分别映射成对应事件', () => {
    const propose = mapQuestToolCall('propose_quest', proposal());
    assert.equal(propose.ok, true);
    if (propose.ok) assert.equal(propose.event.type, 'quest_proposal');

    const submit = mapQuestToolCall('submit_quest', { quest_id: 'quest-1', item_id: 'sanqi' });
    assert.equal(submit.ok, true);
    if (submit.ok) assert.equal(submit.event.type, 'quest_submit');

    const decline = mapQuestToolCall('decline_quest', { quest_id: 'quest-1' });
    assert.equal(decline.ok, true);
    if (decline.ok) assert.equal(decline.event.type, 'quest_decline');
  });

  it('归一化失败与未知工具都返回 ok:false 与原因', () => {
    const bad = mapQuestToolCall('propose_quest', { title: '没头没尾' });
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.match(bad.reason, /want/);

    const unknown = mapQuestToolCall('create_task', {});
    assert.equal(unknown.ok, false);
    if (!unknown.ok) assert.match(unknown.reason, /不是委托类工具/);
  });
});
