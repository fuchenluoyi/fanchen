/**
 * 裁决层：幂等、原子性、奖励预留锁、资源守恒、串行任务链。
 * U-09~U-16 的自动化形式，全程不经 LLM、不触网。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  acceptQuest,
  cancelQuest,
  declineQuest,
  proposeQuest,
  submitQuest,
} from '../src/lib/quest/adjudicate.ts';
import type { ProposeQuestInput } from '../src/lib/quest/adjudicate.ts';
import { availableOf, holdItem, totalOf } from '../src/lib/quest/inventory.ts';
import {
  auditWorld,
  createWorld,
  getNpc,
  inspectNpc,
  inspectPlayer,
  openQuestOfNpc,
  worldTotalOf,
} from '../src/lib/quest/world.ts';

/** 一条合法委托的模板：NPC 旧疾求药（交接文档里的例子） */
function propose(overrides: Partial<ProposeQuestInput> = {}): ProposeQuestInput {
  return {
    requestId: 'req-1',
    npcId: 'su-wanzhao',
    title: '寻一味三七',
    want: '我旧疾复发，需一味三七入药',
    tier: 2,
    objective: { kind: 'deliver_item', itemId: 'sanqi', count: 1 },
    reward: { kind: 'item', itemId: 'jinchuang-gao', count: 1 },
    sourceDialogueId: 'msg-42',
    now: 1000,
    ...overrides,
  };
}

describe('发布委托', () => {
  it('所求者是 NPC，任务现场落库且没有策划模板', () => {
    const world = createWorld();
    const result = proposeQuest(world, propose());
    assert.equal(result.ok, true);
    if (!result.ok) return;

    const quest = result.quest;
    assert.ok(quest);
    assert.equal(quest.requesterId, 'su-wanzhao'); // 所求者：NPC
    assert.equal(quest.takerId, 'player'); // 接取方：玩家
    assert.equal(quest.status, 'offered');
    assert.equal(quest.provenance.sourceDialogueId, 'msg-42');
    assert.equal(quest.provenance.draftedBy, 'dialogue');
    assert.equal('templateId' in quest, false);
  });

  it('发布时预留奖励：可用减少，拥有总量不变；入参世界不被修改', () => {
    const world = createWorld();
    const result = proposeQuest(world, propose());
    assert.equal(result.ok, true);
    if (!result.ok) return;

    const su = getNpc(result.world, 'su-wanzhao');
    assert.ok(su);
    assert.equal(availableOf(su.inventory, 'jinchuang-gao'), 1); // 1 份被预留
    assert.equal(totalOf(su.inventory, 'jinchuang-gao'), 2); // 总量不变
    assert.equal(result.quest?.rewardReservation?.itemId, 'jinchuang-gao');

    const original = getNpc(world, 'su-wanzhao');
    assert.ok(original);
    assert.equal(availableOf(original.inventory, 'jinchuang-gao'), 2);
    assert.equal(Object.keys(world.quests).length, 0);
  });

  it('缺少被求之物时拒绝登记', () => {
    const world = createWorld();
    const result = proposeQuest(world, propose({ want: '   ' }));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'invalid_field');
  });

  it('无法裁决的目标原语与未登记的道具都被挡在门外', () => {
    const world = createWorld();
    const defeat = proposeQuest(world, propose({ objective: { kind: 'defeat', targetId: 'wolf' } }));
    assert.equal(defeat.ok, false);
    if (!defeat.ok) assert.equal(defeat.code, 'unsupported_objective');

    const unknown = proposeQuest(
      world,
      propose({ objective: { kind: 'deliver_item', itemId: 'nope', count: 1 } }),
    );
    assert.equal(unknown.ok, false);
    if (!unknown.ok) assert.equal(unknown.code, 'unknown_item');
  });

  it('自循环套利被拒：任务所要之物不能就是奖励本身', () => {
    const world = createWorld();
    const result = proposeQuest(world, propose({ reward: { kind: 'item', itemId: 'sanqi', count: 1 } }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'self_loop_objective_reward');
  });
});

describe('奖励的档位裁决', () => {
  it('道具奖励不再按价值驳回：小事也拿得出百年灵芝（有守恒，只挪位置）', () => {
    const world = createWorld();
    const before = worldTotalOf(world, 'century-lingzhi');
    const result = proposeQuest(
      world,
      propose({ tier: 1, reward: { kind: 'item', itemId: 'century-lingzhi', count: 1 } }),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // 只是被预留锁住：总量不变，可用 -1
    assert.equal(worldTotalOf(result.world, 'century-lingzhi'), before);
    assert.equal(getNpc(result.world, 'su-wanzhao')?.inventory.holds.length, 1);
  });

  it('档位由代码算：模型没有自报的口子（小事 → 薄礼）', () => {
    const world = createWorld();
    const result = proposeQuest(
      world,
      propose({ tier: 1, reward: { kind: 'item', itemId: 'gancao', count: 1 } }),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // 苏晚照 generosity 0.6 + 小事 → maxOfferLevel = 1
    assert.equal(result.quest?.offerLevel, 1);
  });

  it('NPC 背包空了就发不出任务（天然的奖励闸门）', () => {
    const world = createWorld();
    const result = proposeQuest(
      world,
      propose({ npcId: 'a-lai', reward: { kind: 'item', itemId: 'rations', count: 1 } }),
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'reward_not_owned');

    // 不依赖背包的好感度奖励仍然可以发布
    const affinity = proposeQuest(
      world,
      propose({ npcId: 'a-lai', reward: { kind: 'affinity', amount: 1 } }),
    );
    assert.equal(affinity.ok, true);
  });

  it('预留锁：已被别的任务锁住的奖励拿不出来', () => {
    const world = createWorld();
    const su = getNpc(world, 'su-wanzhao');
    assert.ok(su);
    // 手工造出「这件道具已被别的任务预留」的合法世界状态
    su.inventory = holdItem(su.inventory, {
      questId: 'quest-other',
      itemId: 'century-lingzhi',
      count: 1,
      holdId: 'hold-other',
      at: 1,
    }).inventory;

    const result = proposeQuest(
      world,
      propose({ tier: 3, reward: { kind: 'item', itemId: 'century-lingzhi', count: 1 } }),
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'npc_reward_unavailable');
  });
});

describe('幂等与原子性', () => {
  it('同一个 requestId 重放只返回首次结果，世界不再变一次', () => {
    const world = createWorld();
    const first = proposeQuest(world, propose());
    assert.equal(first.ok, true);
    if (!first.ok) return;

    const again = proposeQuest(first.world, propose());
    assert.equal(again.ok, true);
    if (!again.ok) return;
    assert.equal(again.replay, true);
    assert.equal(again.world, first.world); // 同一个对象：什么都没改
    assert.equal(again.quest?.id, first.quest?.id);
    assert.equal(Object.keys(first.world.quests).length, 1);
  });

  it('同一个 requestId 换参数复用会被拒（客户端 bug）', () => {
    const world = createWorld();
    const first = proposeQuest(world, propose());
    assert.equal(first.ok, true);
    if (!first.ok) return;

    const reused = proposeQuest(first.world, propose({ title: '换了个标题' }));
    assert.equal(reused.ok, false);
    if (reused.ok) return;
    assert.equal(reused.code, 'idempotency_key_reused');
    assert.equal(reused.world, first.world);
  });

  it('缺 requestId 直接拒绝（幂等键是硬要求）', () => {
    const world = createWorld();
    const result = proposeQuest(world, propose({ requestId: '  ' }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'invalid_field');
  });

  it('玩家道具不够时整笔拒绝，世界逐字节不变（原子性）', () => {
    const world = createWorld();
    const proposed = proposeQuest(
      world,
      propose({ objective: { kind: 'deliver_item', itemId: 'sanqi', count: 2 } }),
    );
    assert.equal(proposed.ok, true);
    if (!proposed.ok) return;
    const accepted = acceptQuest(proposed.world, { requestId: 'req-2', questId: proposed.quest!.id });
    assert.equal(accepted.ok, true);
    if (!accepted.ok) return;

    const before = JSON.stringify(accepted.world);
    const failed = submitQuest(accepted.world, {
      requestId: 'req-3',
      questId: proposed.quest!.id,
      deliver: { itemId: 'sanqi', count: 2 },
    });
    assert.equal(failed.ok, false);
    if (failed.ok) return;
    assert.equal(failed.code, 'player_item_insufficient');
    assert.equal(JSON.stringify(failed.world), before); // 道具没扣、奖励没动、任务状态没变
    assert.equal(failed.quest?.status, 'accepted');
    assert.equal(availableOf(accepted.world.player.inventory, 'sanqi'), 1);
  });

  it('提交的幂等重放不会重复发奖', () => {
    const world = createWorld();
    const proposed = proposeQuest(world, propose());
    assert.equal(proposed.ok, true);
    if (!proposed.ok) return;
    const accepted = acceptQuest(proposed.world, { requestId: 'req-2', questId: proposed.quest!.id });
    assert.equal(accepted.ok, true);
    if (!accepted.ok) return;
    const settled = submitQuest(accepted.world, {
      requestId: 'req-3',
      questId: proposed.quest!.id,
      deliver: { itemId: 'sanqi', count: 1 },
    });
    assert.equal(settled.ok, true);
    if (!settled.ok) return;

    const replay = submitQuest(settled.world, {
      requestId: 'req-3',
      questId: proposed.quest!.id,
      deliver: { itemId: 'sanqi', count: 1 },
    });
    assert.equal(replay.ok, true);
    if (!replay.ok) return;
    assert.equal(replay.replay, true);
    assert.equal(replay.world, settled.world);
    assert.equal(availableOf(settled.world.player.inventory, 'jinchuang-gao'), 1); // 只发了一次
  });
});

describe('完整链路：发布 → 接取 → 交付 → 扣除 → 发奖 → 结算', () => {
  it('道具守恒、事件齐全、任务收尾干净', () => {
    const world = createWorld();
    const sanqiBefore = worldTotalOf(world, 'sanqi');
    const gaoBefore = worldTotalOf(world, 'jinchuang-gao');

    const proposed = proposeQuest(world, propose());
    assert.equal(proposed.ok, true);
    if (!proposed.ok) return;
    const questId = proposed.quest!.id;

    const accepted = acceptQuest(proposed.world, { requestId: 'req-2', questId, now: 2000 });
    assert.equal(accepted.ok, true);
    if (!accepted.ok) return;
    assert.equal(accepted.quest?.status, 'accepted');

    const settled = submitQuest(accepted.world, {
      requestId: 'req-3',
      questId,
      deliver: { itemId: 'sanqi', count: 1 },
      now: 3000,
    });
    assert.equal(settled.ok, true);
    if (!settled.ok) return;

    const quest = settled.quest;
    assert.ok(quest);
    assert.equal(quest.status, 'settled');
    assert.deepEqual(quest.delivered, [{ itemId: 'sanqi', count: 1 }]);
    assert.equal(quest.rewardReservation, null);
    assert.equal(quest.closeReason, null);

    const finalWorld = settled.world;
    // 玩家：交出一份三七，拿到一份金疮药
    assert.equal(availableOf(finalWorld.player.inventory, 'sanqi'), 0);
    assert.equal(availableOf(finalWorld.player.inventory, 'jinchuang-gao'), 1);
    // 苏晚照：收到三七，付出金疮药
    const su = getNpc(finalWorld, 'su-wanzhao');
    assert.ok(su);
    assert.equal(availableOf(su.inventory, 'sanqi'), 3);
    assert.equal(totalOf(su.inventory, 'jinchuang-gao'), 1);
    assert.equal(su.inventory.holds.length, 0);
    // 守恒：道具只是换了口袋
    assert.equal(worldTotalOf(finalWorld, 'sanqi'), sanqiBefore);
    assert.equal(worldTotalOf(finalWorld, 'jinchuang-gao'), gaoBefore);
    assert.deepEqual(auditWorld(finalWorld), []);
    assert.deepEqual(auditWorld(world), []);

    const types = new Set<string>(finalWorld.events.map((event) => event.type));
    for (const expected of [
      'quest_proposed',
      'reward_held',
      'quest_accepted',
      'items_delivered',
      'reward_granted',
      'quest_settled',
    ]) {
      assert.ok(types.has(expected), `事件流水缺少 ${expected}`);
    }
  });

  it('没接取就不能提交；结算完不能再提交一次', () => {
    const world = createWorld();
    const proposed = proposeQuest(world, propose());
    assert.equal(proposed.ok, true);
    if (!proposed.ok) return;
    const questId = proposed.quest!.id;

    const early = submitQuest(proposed.world, {
      requestId: 'req-2',
      questId,
      deliver: { itemId: 'sanqi', count: 1 },
    });
    assert.equal(early.ok, false);
    if (!early.ok) assert.equal(early.code, 'quest_not_accepted');

    const accepted = acceptQuest(proposed.world, { requestId: 'req-3', questId });
    assert.equal(accepted.ok, true);
    if (!accepted.ok) return;
    const settled = submitQuest(accepted.world, {
      requestId: 'req-4',
      questId,
      deliver: { itemId: 'sanqi', count: 1 },
    });
    assert.equal(settled.ok, true);
    if (!settled.ok) return;

    const twice = submitQuest(settled.world, {
      requestId: 'req-5',
      questId,
      deliver: { itemId: 'sanqi', count: 1 },
    });
    assert.equal(twice.ok, false);
    if (!twice.ok) assert.equal(twice.code, 'quest_not_submittable');
  });

  it('提交的不是任务所要的那件道具时被拒', () => {
    const world = createWorld();
    const proposed = proposeQuest(world, propose());
    assert.equal(proposed.ok, true);
    if (!proposed.ok) return;
    const accepted = acceptQuest(proposed.world, { requestId: 'req-2', questId: proposed.quest!.id });
    assert.equal(accepted.ok, true);
    if (!accepted.ok) return;

    const wrong = submitQuest(accepted.world, {
      requestId: 'req-3',
      questId: proposed.quest!.id,
      deliver: { itemId: 'gancao', count: 1 },
    });
    assert.equal(wrong.ok, false);
    if (!wrong.ok) assert.equal(wrong.code, 'deliver_mismatch');

    const tooFew = submitQuest(accepted.world, {
      requestId: 'req-4',
      questId: proposed.quest!.id,
      deliver: { itemId: 'sanqi', count: 0 },
    });
    assert.equal(tooFew.ok, false);
    if (!tooFew.ok) assert.equal(tooFew.code, 'deliver_count_too_low');
  });
});

describe('非交付型目标', () => {
  it('持有型目标满足即可结算，且不消耗道具、不许夹带道具', () => {
    const world = createWorld();
    const proposed = proposeQuest(
      world,
      propose({
        tier: 1,
        objective: { kind: 'has_item', itemId: 'gancao', count: 2 },
        reward: { kind: 'affinity', amount: 2 },
      }),
    );
    assert.equal(proposed.ok, true);
    if (!proposed.ok) return;
    const questId = proposed.quest!.id;
    const accepted = acceptQuest(proposed.world, { requestId: 'req-2', questId });
    assert.equal(accepted.ok, true);
    if (!accepted.ok) return;

    const withItem = submitQuest(accepted.world, {
      requestId: 'req-3',
      questId,
      deliver: { itemId: 'gancao', count: 2 },
    });
    assert.equal(withItem.ok, false);
    if (!withItem.ok) assert.equal(withItem.code, 'deliver_forbidden');

    const settled = submitQuest(accepted.world, { requestId: 'req-4', questId });
    assert.equal(settled.ok, true);
    if (!settled.ok) return;
    assert.equal(settled.quest?.status, 'settled');
    assert.equal(settled.world.player.affinity['su-wanzhao'], 2);
    assert.equal(availableOf(settled.world.player.inventory, 'gancao'), 2); // 没被扣
  });

  it('对话轮数型目标未达成时不能结算；达成后可结算并解锁功能', () => {
    const world = createWorld();
    const proposed = proposeQuest(
      world,
      propose({
        tier: 3,
        objective: { kind: 'talk_count', rounds: 3 },
        reward: { kind: 'ability', abilityId: 'jieyuan' },
      }),
    );
    assert.equal(proposed.ok, true);
    if (!proposed.ok) return;
    const questId = proposed.quest!.id;
    assert.equal(proposed.quest?.rewardReservation, null); // 功能奖励不需要预留锁

    const accepted = acceptQuest(proposed.world, { requestId: 'req-2', questId });
    assert.equal(accepted.ok, true);
    if (!accepted.ok) return;

    const notYet = submitQuest(accepted.world, { requestId: 'req-3', questId });
    assert.equal(notYet.ok, false);
    if (!notYet.ok) assert.equal(notYet.code, 'objective_not_met');

    accepted.world.player.talks['su-wanzhao'] = 3;
    const settled = submitQuest(accepted.world, { requestId: 'req-4', questId });
    assert.equal(settled.ok, true);
    if (!settled.ok) return;
    assert.deepEqual(settled.world.player.abilities, ['jieyuan']);
  });
});

describe('串行任务链与收尾', () => {
  it('同一 NPC 一次只挂一个未完结委托', () => {
    const world = createWorld();
    const first = proposeQuest(world, propose());
    assert.equal(first.ok, true);
    if (!first.ok) return;

    const second = proposeQuest(first.world, propose({ requestId: 'req-2', title: '再来一件事' }));
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.code, 'npc_has_open_quest');
  });

  it('婉拒之后预留释放，串行链腾出来给下一条', () => {
    const world = createWorld();
    const first = proposeQuest(world, propose());
    assert.equal(first.ok, true);
    if (!first.ok) return;

    const declined = declineQuest(first.world, { requestId: 'req-2', questId: first.quest!.id });
    assert.equal(declined.ok, true);
    if (!declined.ok) return;
    assert.equal(declined.quest?.status, 'declined');
    assert.equal(declined.quest?.closeReason, 'declined_by_player');
    assert.equal(declined.quest?.rewardReservation, null);

    const su = getNpc(declined.world, 'su-wanzhao');
    assert.ok(su);
    assert.equal(availableOf(su.inventory, 'jinchuang-gao'), 2);
    assert.equal(su.inventory.holds.length, 0);
    assert.equal(openQuestOfNpc(declined.world, 'su-wanzhao'), null);

    const again = proposeQuest(declined.world, propose({ requestId: 'req-3' }));
    assert.equal(again.ok, true);
  });

  it('撤销同样释放预留', () => {
    const world = createWorld();
    const proposed = proposeQuest(world, propose());
    assert.equal(proposed.ok, true);
    if (!proposed.ok) return;

    const cancelled = cancelQuest(proposed.world, {
      requestId: 'req-2',
      questId: proposed.quest!.id,
      reason: 'NPC 改主意了',
    });
    assert.equal(cancelled.ok, true);
    if (!cancelled.ok) return;
    assert.equal(cancelled.quest?.status, 'cancelled');
    const su = getNpc(cancelled.world, 'su-wanzhao');
    assert.ok(su);
    assert.equal(availableOf(su.inventory, 'jinchuang-gao'), 2);
    assert.deepEqual(auditWorld(cancelled.world), []);
  });
});

describe('涌现式内容与只读真相', () => {
  it('同一世界可以先后冒出内容完全不同的委托，各自带溯源', () => {
    const world = createWorld();
    const first = proposeQuest(world, propose());
    assert.equal(first.ok, true);
    if (!first.ok) return;

    const second = proposeQuest(
      first.world,
      propose({
        requestId: 'req-2',
        npcId: 'lu-xingzhou',
        title: '验一支竹哨',
        want: '想请人替我看看这支哨子还响不响',
        objective: { kind: 'has_item', itemId: 'fire-starter', count: 1 },
        reward: { kind: 'item', itemId: 'rations', count: 2 },
        draftedBy: 'cli',
      }),
    );
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.quest?.provenance.draftedBy, 'cli');
    assert.equal(second.quest?.provenance.npcId, 'lu-xingzhou');
    assert.equal(Object.keys(second.world.quests).length, 2);
    assert.equal(world.quests[second.quest!.id], undefined); // 入参世界干净
  });

  it('只读快照让模型看得见背包与在手任务，不必猜', () => {
    const world = createWorld();
    const proposed = proposeQuest(world, propose());
    assert.equal(proposed.ok, true);
    if (!proposed.ok) return;

    const npcView = inspectNpc(proposed.world, 'su-wanzhao');
    assert.ok(npcView);
    assert.equal(npcView.openQuestId, proposed.quest!.id);
    assert.ok(npcView.held.some((hold) => hold.itemId === 'jinchuang-gao'));
    assert.ok(npcView.available.some((stack) => stack.itemId === 'sanqi'));

    const playerView = inspectPlayer(proposed.world);
    assert.ok(playerView.available.some((stack) => stack.itemId === 'sanqi'));
    assert.deepEqual(playerView.abilities, []);
  });
});
