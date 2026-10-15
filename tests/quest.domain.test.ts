/**
 * 领域层基础：道具表与珍贵等级、背包与预留锁、目标原语、奖励档位。
 * 全部是纯函数，不需要网络与浏览器。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ITEM_USES, TIER_LIST, TIER_VALUE_RANGE } from '../src/lib/quest/constants.ts';
import {
  ITEM_LIST,
  auditItemTable,
  getItem,
  isKnownItem,
  itemValue,
  itemsByTag,
  itemsByTier,
  itemsByUse,
  searchItems,
  stacksValue,
  tierLabel,
  tierOrder,
} from '../src/lib/quest/items.ts';
import {
  auditInventory,
  availableOf,
  consumeHold,
  createInventory,
  hasAvailable,
  heldOf,
  holdItem,
  inventoryValue,
  releaseHold,
  releaseHoldsForQuest,
  totalOf,
} from '../src/lib/quest/inventory.ts';
import {
  PRIMITIVE_SUPPORT,
  assertObjectiveSupported,
  describeObjective,
  objectiveItemRef,
  objectiveSatisfied,
  validateObjective,
} from '../src/lib/quest/objectives.ts';
import {
  describeReward,
  isAbilityId,
  maxOfferLevel,
  rewardCandidates,
  rewardItemValue,
  validateReward,
} from '../src/lib/quest/rewards.ts';
import {
  DEFAULT_PLAYER_ID,
  cherishedItems,
  createWorld,
  getNpc,
  itemBiasFor,
  spareItems,
  subjectiveValueOf,
} from '../src/lib/quest/world.ts';
import { QuestError } from '../src/lib/quest/types.ts';
import type { ObjectivePrimitive, Quest } from '../src/lib/quest/types.ts';

function expectCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (err: unknown) => err instanceof QuestError && err.code === code);
}

/* ============================== 道具与等级 ============================== */

describe('道具表与珍贵等级', () => {
  it('等级与价值自洽：每件道具的价值都落在自己那一档的区间里', () => {
    assert.deepEqual(auditItemTable(), []);
  });

  it('五个珍贵等级都有道具', () => {
    for (const tier of TIER_LIST) {
      assert.ok(itemsByTier(tier).length > 0, `${tier} 一档没有道具`);
    }
  });

  it('价值区间逐档抬高且不重叠', () => {
    let previousMax = 0;
    for (const tier of TIER_LIST) {
      const [min, max] = TIER_VALUE_RANGE[tier];
      assert.ok(min > previousMax, `${tier} 的下限没有抬高`);
      assert.ok(max > min);
      previousMax = max;
    }
    assert.ok(tierOrder('legendary') > tierOrder('common'));
    assert.equal(tierLabel('rare'), '上品');
  });

  it('未登记的道具不会被猜出来（白名单原则）', () => {
    assert.equal(getItem('three-seven'), null);
    assert.equal(isKnownItem('three-seven'), false);
    assert.equal(itemValue('three-seven'), 0);
  });

  it('可按名称与标签检索，供模型消歧', () => {
    assert.equal(searchItems('三七')[0]?.id, 'sanqi');
    assert.ok(searchItems('药').length >= 3);
    assert.ok(itemsByTag('药').every((item) => item.tags.includes('药')));
  });

  it('整组道具按参考价累加', () => {
    assert.equal(stacksValue([{ itemId: 'sanqi', count: 2 }, { itemId: 'rations', count: 3 }]), 96);
  });
});

/* ============================== 背包与预留锁 ============================== */

describe('背包与预留锁', () => {
  it('查询可用与拥有量', () => {
    const inventory = createInventory('npc-a', [{ itemId: 'sanqi', count: 2 }]);
    assert.equal(availableOf(inventory, 'sanqi'), 2);
    assert.equal(hasAvailable(inventory, 'sanqi', 2), true);
    assert.equal(hasAvailable(inventory, 'sanqi', 3), false);
  });

  it('预留只是挪位置：可用减少，拥有总量不变（守恒）', () => {
    const inventory = createInventory('npc-a', [{ itemId: 'sanqi', count: 2 }]);
    const { inventory: next, hold } = holdItem(inventory, {
      questId: 'quest-1',
      itemId: 'sanqi',
      count: 1,
      holdId: 'hold-1',
      at: 10,
    });
    assert.equal(availableOf(next, 'sanqi'), 1);
    assert.equal(heldOf(next, 'sanqi'), 1);
    assert.equal(totalOf(next, 'sanqi'), 2);
    assert.equal(hold.questId, 'quest-1');
    // 入参不被修改
    assert.equal(availableOf(inventory, 'sanqi'), 2);
    assert.equal(inventory.holds.length, 0);
  });

  it('可用不足时预留失败，且入参不受影响', () => {
    const inventory = createInventory('npc-a', [{ itemId: 'sanqi', count: 1 }]);
    expectCode(
      () => holdItem(inventory, { questId: 'q', itemId: 'sanqi', count: 2, holdId: 'h', at: 1 }),
      'insufficient_items',
    );
    assert.equal(availableOf(inventory, 'sanqi'), 1);
    assert.deepEqual(auditInventory(inventory), []);
  });

  it('释放预留后回到可用', () => {
    const inventory = createInventory('npc-a', [{ itemId: 'sanqi', count: 2 }]);
    const { inventory: held } = holdItem(inventory, {
      questId: 'quest-1',
      itemId: 'sanqi',
      count: 1,
      holdId: 'hold-1',
      at: 10,
    });
    const released = releaseHold(held, 'hold-1');
    assert.equal(availableOf(released, 'sanqi'), 2);
    assert.equal(heldOf(released, 'sanqi'), 0);
  });

  it('核销预留（奖励真的发出去）之后总量才减少', () => {
    const inventory = createInventory('npc-a', [{ itemId: 'sanqi', count: 2 }]);
    const { inventory: held } = holdItem(inventory, {
      questId: 'quest-1',
      itemId: 'sanqi',
      count: 1,
      holdId: 'hold-1',
      at: 10,
    });
    const consumed = consumeHold(held, 'hold-1');
    assert.equal(availableOf(consumed, 'sanqi'), 1);
    assert.equal(totalOf(consumed, 'sanqi'), 1);
  });

  it('只释放指定任务留下的预留', () => {
    let inventory = createInventory('npc-a', [
      { itemId: 'sanqi', count: 2 },
      { itemId: 'danggui', count: 1 },
    ]);
    inventory = holdItem(inventory, { questId: 'quest-1', itemId: 'sanqi', count: 1, holdId: 'hold-1', at: 1 }).inventory;
    inventory = holdItem(inventory, { questId: 'quest-2', itemId: 'danggui', count: 1, holdId: 'hold-2', at: 2 }).inventory;
    const released = releaseHoldsForQuest(inventory, 'quest-1');
    assert.equal(availableOf(released, 'sanqi'), 2);
    assert.equal(availableOf(released, 'danggui'), 0);
    assert.equal(heldOf(released, 'danggui'), 1);
  });

  it('背包总值把已预留的部分也算进去', () => {
    const inventory = createInventory('npc-a', [{ itemId: 'sanqi', count: 2 }]);
    const { inventory: held } = holdItem(inventory, {
      questId: 'q',
      itemId: 'sanqi',
      count: 1,
      holdId: 'h',
      at: 1,
    });
    assert.equal(inventoryValue(inventory), 90);
    assert.equal(inventoryValue(held), 90);
  });
});

/* ============================== 目标原语 ============================== */

function fakeQuest(objective: ObjectivePrimitive, requesterId = 'su-wanzhao'): Quest {
  return {
    id: 'quest-x',
    requesterId,
    takerId: DEFAULT_PLAYER_ID,
    title: '测试委托',
    want: '测试',
    tier: 1,
    objective,
    reward: { kind: 'none' },
    offerLevel: 1,
    rewardReservation: null,
    status: 'accepted',
    provenance: { npcId: requesterId, sourceDialogueId: null, draftedBy: 'cli', createdAt: 0 },
    createdAt: 0,
    acceptedAt: 0,
    settledAt: null,
    closedAt: null,
    closeReason: null,
    delivered: [],
    history: [],
  };
}

describe('目标原语白名单', () => {
  it('合法原语通过校验', () => {
    assert.doesNotThrow(() => validateObjective({ kind: 'deliver_item', itemId: 'sanqi', count: 1 }));
    assert.doesNotThrow(() => validateObjective({ kind: 'talk_count', rounds: 3 }));
    assert.doesNotThrow(() => validateObjective({ kind: 'affinity_at_least', value: 20 }));
  });

  it('引用未登记的道具被拒', () => {
    expectCode(() => validateObjective({ kind: 'deliver_item', itemId: 'nope', count: 1 }), 'unknown_item');
  });

  it('数量必须是不小于 1 的整数', () => {
    expectCode(() => validateObjective({ kind: 'deliver_item', itemId: 'sanqi', count: 0 }), 'invalid_objective');
    expectCode(() => validateObjective({ kind: 'talk_count', rounds: 0 }), 'invalid_objective');
  });

  it('依赖尚不存在系统的原语被拒绝登记（defeat 依赖战斗系统）', () => {
    assert.equal(PRIMITIVE_SUPPORT.defeat, 'pending_dependency');
    assert.doesNotThrow(() => validateObjective({ kind: 'defeat', targetId: 'wolf' }));
    expectCode(() => assertObjectiveSupported({ kind: 'defeat', targetId: 'wolf' }), 'unsupported_objective');
  });

  it('只有道具型目标带得出道具引用', () => {
    assert.deepEqual(objectiveItemRef({ kind: 'has_item', itemId: 'sanqi', count: 2 }), {
      itemId: 'sanqi',
      count: 2,
    });
    assert.equal(objectiveItemRef({ kind: 'talk_count', rounds: 2 }), null);
  });

  it('has_item 按玩家背包判定；deliver_item 不能靠看一眼背包就算了事', () => {
    const world = createWorld();
    assert.equal(objectiveSatisfied(world, fakeQuest({ kind: 'has_item', itemId: 'gancao', count: 2 })), true);
    assert.equal(objectiveSatisfied(world, fakeQuest({ kind: 'has_item', itemId: 'sanqi', count: 2 })), false);
    assert.equal(objectiveSatisfied(world, fakeQuest({ kind: 'deliver_item', itemId: 'gancao', count: 2 })), false);
  });

  it('目标可以翻译成人话', () => {
    assert.equal(describeObjective({ kind: 'deliver_item', itemId: 'sanqi', count: 2 }), '交付「三七」×2');
    assert.match(describeObjective({ kind: 'defeat', targetId: 'wolf' }), /战斗系统/);
  });
});

/* ============================== 奖励 ============================== */

describe('奖励白名单与档位', () => {
  it('档位上限由任务重要性与慷慨度共同决定', () => {
    assert.equal(maxOfferLevel({ questTier: 1, generosity: 0.6 }), 1);
    assert.equal(maxOfferLevel({ questTier: 2, generosity: 0.6 }), 2);
    assert.equal(maxOfferLevel({ questTier: 3, generosity: 0.6 }), 3);
    assert.equal(maxOfferLevel({ questTier: 1, generosity: 0.75 }), 2);
    assert.equal(maxOfferLevel({ questTier: 3, generosity: 0.2 }), 2);
  });

  it('拿不出来的东西不能当奖励（空背包 NPC）', () => {
    const world = createWorld();
    const alai = getNpc(world, 'a-lai');
    assert.ok(alai);
    expectCode(
      () => validateReward(alai, { kind: 'item', itemId: 'rations', count: 1 }, 1, 1),
      'reward_not_owned',
    );
  });

  it('道具奖励不再按价值驳回（有守恒：背包即上限），拿不出来的仍然驳回', () => {
    const world = createWorld();
    const su = getNpc(world, 'su-wanzhao');
    assert.ok(su);
    // 百年灵芝 180 文，放在「小事」（1 档）也允许 —— 道具不再有档位价值上限
    assert.doesNotThrow(() => validateReward(su, { kind: 'item', itemId: 'century-lingzhi', count: 1 }, 1, 1));
    // 背包里没有的东西才是真上限
    assert.equal(totalOf(su.inventory, 'jiuzhuan-dan'), 0);
    expectCode(
      () => validateReward(su, { kind: 'item', itemId: 'jiuzhuan-dan', count: 1 }, 3, 3),
      'reward_not_owned',
    );
  });

  it('功能解锁只允许出现在「大事」上', () => {
    const world = createWorld();
    const su = getNpc(world, 'su-wanzhao');
    assert.ok(su);
    expectCode(() => validateReward(su, { kind: 'ability', abilityId: 'jieyuan' }, 2, 2), 'reward_over_cap');
    assert.doesNotThrow(() => validateReward(su, { kind: 'ability', abilityId: 'jieyuan' }, 3, 3));
    assert.equal(isAbilityId('jieyuan'), true);
    assert.equal(isAbilityId('feixian'), false);
  });

  it('未登记的能力与未登记的道具都被拒', () => {
    const world = createWorld();
    const su = getNpc(world, 'su-wanzhao');
    assert.ok(su);
    expectCode(
      () => validateReward(su, { kind: 'ability', abilityId: 'feixian' as 'jieyuan' }, 3, 3),
      'unknown_ability',
    );
    expectCode(() => validateReward(su, { kind: 'item', itemId: 'nope', count: 1 }, 3, 3), 'unknown_item');
  });

  it('好感度奖励有自己的上限', () => {
    const world = createWorld();
    const su = getNpc(world, 'su-wanzhao');
    assert.ok(su);
    expectCode(() => validateReward(su, { kind: 'affinity', amount: 9 }, 2, 2), 'reward_over_cap');
    assert.doesNotThrow(() => validateReward(su, { kind: 'affinity', amount: 3 }, 2, 2));
  });

  it('候选奖励列出背包里所有拿得出来的道具（不再按档位过滤）', () => {
    const world = createWorld();
    const su = getNpc(world, 'su-wanzhao');
    assert.ok(su);
    const candidates = rewardCandidates(su);
    assert.ok(candidates.length > 0);
    // 灵芝是她的贵货：旧版会被档位价值上限滤掉，现在必须如实列出
    assert.ok(candidates.some((entry) => entry.item.id === 'century-lingzhi'));
    assert.ok(candidates.every((entry) => entry.value <= 180));
  });

  it('奖励能翻译成人话，道具价值可累加', () => {
    assert.match(describeReward({ kind: 'item', itemId: 'sanqi', count: 1 }), /三七/);
    assert.match(describeReward({ kind: 'none' }), /好感度/);
    assert.equal(rewardItemValue({ kind: 'item', itemId: 'sanqi', count: 2 }), 90);
    assert.equal(rewardItemValue({ kind: 'affinity', amount: 5 }), 0);
    assert.equal(ITEM_LIST.length, new Set(ITEM_LIST.map((item) => item.id)).size);
  });
});

/* ============================== 道具表扩充 ============================== */

describe('道具表扩充（30 件、五档每档 ≥5）', () => {
  it('总数 30 件左右，五档每档至少 5 件', () => {
    assert.ok(ITEM_LIST.length >= 30, `道具表只有 ${ITEM_LIST.length} 件，不足 30`);
    assert.equal(new Set(ITEM_LIST.map((item) => item.id)).size, ITEM_LIST.length);
    for (const tier of TIER_LIST) {
      const items = itemsByTier(tier);
      assert.ok(items.length >= 5, `${tier} 只有 ${items.length} 件，不足 5`);
    }
  });

  it('老 item id 一个都没丢，定价也没被动过（存档里有引用）', () => {
    const oldIds = [
      'rations',
      'water',
      'cloth',
      'bamboo-tally',
      'jinchuang-gao',
      'fire-starter',
      'bamboo-whistle',
      'gancao',
      'sanqi',
      'danggui',
      'xingshen-tea',
      'coldiron-needle',
      'century-lingzhi',
      'coldiron-dagger',
      'snow-silkworm',
      'jiuzhuan-dan',
      'xuanyu-token',
    ];
    for (const id of oldIds) assert.ok(isKnownItem(id), `老道具丢了：${id}`);
    assert.equal(itemValue('sanqi'), 45);
    assert.equal(itemValue('century-lingzhi'), 180);
    assert.equal(itemValue('xuanyu-token'), 620);
  });

  it('每件道具都有用途标签，且标签都在词表内', () => {
    assert.deepEqual(auditItemTable(), []);
    for (const item of ITEM_LIST) {
      assert.ok(item.uses.length > 0, `${item.name} 没有用途标签`);
      for (const use of item.uses) {
        assert.ok(ITEM_USES.includes(use), `${item.name} 的用途「${use}」不在词表内`);
      }
    }
  });

  it('用途词表里每一条都有道具认领（不留空词）', () => {
    for (const use of ITEM_USES) {
      assert.ok(itemsByUse(use).length > 0, `用途「${use}」没有任何道具`);
    }
  });
});

/* ======================= NPC 的主观估值（只进叙事） ======================= */

describe('NPC 的主观估值：她在意的 / 她多余的', () => {
  it('命中 wantsUses → ×3，命中 spares → ×0.5，其余 ×1', () => {
    const su = getNpc(createWorld(), 'su-wanzhao');
    assert.ok(su);
    assert.equal(itemBiasFor(su, 'sanqi'), 'cherished'); // 三七：疗伤
    assert.equal(subjectiveValueOf(su, 'sanqi'), 135); // 45 × 3
    assert.equal(itemBiasFor(su, 'century-lingzhi'), 'spare'); // 明写「多余的」
    assert.equal(subjectiveValueOf(su, 'century-lingzhi'), 90); // 180 × 0.5
    assert.equal(itemBiasFor(su, 'rations'), 'neutral'); // 干粮与药无关
    assert.equal(subjectiveValueOf(su, 'rations'), 2);
  });

  it('spares 优先于 wantsUses（用来覆盖用途推不出来的特例）', () => {
    const lu = getNpc(createWorld(), 'lu-xingzhou');
    assert.ok(lu);
    assert.equal(itemBiasFor(lu, 'rations'), 'spare'); // 明写多余
    assert.equal(itemBiasFor(lu, 'coin-string'), 'cherished'); // 铜钱串：凭据
    assert.equal(subjectiveValueOf(lu, 'rations'), 1); // 2 × 0.5
  });

  it('两张清单直接从背包推出来', () => {
    const su = getNpc(createWorld(), 'su-wanzhao');
    assert.ok(su);
    const cherished = cherishedItems(su).map((item) => item.id);
    assert.ok(cherished.includes('sanqi'));
    assert.ok(cherished.includes('danggui'));
    assert.ok(!cherished.includes('century-lingzhi'));
    assert.deepEqual(
      spareItems(su).map((item) => item.id),
      ['century-lingzhi'],
    );
  });

  it('三位 NPC 都配了偏好；两位 6-10 件、阿癞保持几乎空', () => {
    const world = createWorld();
    for (const id of ['su-wanzhao', 'lu-xingzhou', 'a-lai']) {
      const npc = getNpc(world, id);
      assert.ok(npc, `没有 ${id}`);
      assert.ok(npc.wantsUses.length > 0, `${id} 没有 wantsUses`);
      assert.ok(npc.likes.length > 0, `${id} 没有 likes`);
      assert.ok(npc.dislikes.length > 0, `${id} 没有 dislikes`);
    }
    const sizes: Array<[string, number]> = [
      ['su-wanzhao', getNpc(world, 'su-wanzhao')?.inventory.stacks.length ?? 0],
      ['lu-xingzhou', getNpc(world, 'lu-xingzhou')?.inventory.stacks.length ?? 0],
    ];
    for (const [id, size] of sizes) {
      assert.ok(size >= 6 && size <= 10, `${id} 的背包是 ${size} 件，应在 6-10 之间`);
    }
    // 阿癞是「背包枯竭就不触发任务」的样板，不该被配满
    assert.ok((getNpc(world, 'a-lai')?.inventory.stacks.length ?? 0) <= 1, '阿癞不该被配满');
    // 苏晚照的背包里必须同时有「舍不得的」和「多余的」
    const su = getNpc(world, 'su-wanzhao');
    assert.ok(su);
    assert.ok(cherishedItems(su).length > 0);
    assert.ok(spareItems(su).length > 0);
  });

  it('主观估值不参与裁决：她"舍不得"的东西照样能当谢礼', () => {
    const su = getNpc(createWorld(), 'su-wanzhao');
    assert.ok(su);
    assert.doesNotThrow(() => validateReward(su, { kind: 'item', itemId: 'sanqi', count: 1 }, 1, 1));
  });
});
