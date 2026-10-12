/**
 * 奖励系统：白名单、档位、价值上限、可用候选。
 *
 * 三条硬约束（§3.3）：
 *   1. 奖励只能从白名单枚举里选（道具 / 好感度 / 能力 / 情报 / 放弃），不能凭空生成；
 *   2. 数值由代码按档位查表裁决，模型只能在档位内让步，不能自己加档；
 *   3. 发布任务时预留锁定奖励（在裁决层用背包的 hold 完成）。
 *
 * 奖励的**来源**也受硬约束：道具奖励必须出自该 NPC 自己的背包 —— 奖励不是凭空印的，
 * 是从 NPC 转移到玩家（§3.2 奖励守恒）；背包空了就发不出任务。
 */
import { QuestError } from './types.ts';
import type { AbilityId, ItemDef, NpcState, OfferLevel, QuestTier, RewardDef } from './types.ts';
import {
  ABILITY_LABEL,
  ABILITY_LIST,
  ABILITY_REQUIRES_TIER,
  FORGO_AFFINITY_BONUS,
  OFFER_LEVEL_AFFINITY_CAP,
  OFFER_LEVEL_LABEL,
  OFFER_LEVEL_VALUE_CAP,
} from './constants.ts';
import { getItem, isKnownItem, itemName, itemValue } from './items.ts';
import { listAvailable, totalOf } from './inventory.ts';

export function isAbilityId(value: unknown): value is AbilityId {
  return typeof value === 'string' && ABILITY_LIST.includes(value as AbilityId);
}

/** 奖励里的道具引用（非道具奖励返回 null） */
export function rewardItemRef(reward: RewardDef): { itemId: string; count: number } | null {
  return reward.kind === 'item' ? { itemId: reward.itemId, count: reward.count } : null;
}

/** 道具奖励的参考价值；非道具奖励返回 0（它们走各自的上限表） */
export function rewardItemValue(reward: RewardDef): number {
  return reward.kind === 'item' ? itemValue(reward.itemId) * reward.count : 0;
}

function clampLevel(value: number): OfferLevel {
  if (value <= 1) return 1;
  if (value >= 3) return 3;
  return value as OfferLevel;
}

/**
 * 档位上限：任务越重要、NPC 越慷慨，能给的档位越高。
 * 本轮只用 generosity 一个性格参数（honesty / openness 留给狡诈 NPC 与阶段门控）。
 */
export function maxOfferLevel(input: { questTier: QuestTier; generosity: number }): OfferLevel {
  const base = Math.min(3, Math.max(1, Math.round(input.questTier)));
  let level = base;
  if (input.generosity >= 0.7) level += 1;
  if (input.generosity < 0.3) level -= 1;
  return clampLevel(level);
}

/**
 * 校验一条奖励是否合法。形状、白名单、NPC 持有情况、档位上限全部在这里判。
 * 通过则返回 reward 本身，失败抛 QuestError。
 */
export function validateReward(
  npc: NpcState,
  reward: RewardDef,
  offerLevel: OfferLevel,
  questTier: QuestTier,
): RewardDef {
  if (!reward || typeof reward !== 'object') {
    throw new QuestError('invalid_reward', '奖励必须是对象');
  }
  switch (reward.kind) {
    case 'item': {
      if (!isKnownItem(reward.itemId)) {
        throw new QuestError('unknown_item', `奖励引用了未登记的道具：${reward.itemId}`);
      }
      if (!Number.isInteger(reward.count) || reward.count < 1) {
        throw new QuestError('invalid_reward', '奖励道具数量必须是 ≥ 1 的整数');
      }
      if (totalOf(npc.inventory, reward.itemId) < reward.count) {
        throw new QuestError(
          'reward_not_owned',
          `${npc.name} 背包里没有「${itemName(reward.itemId)}」，拿不出的东西不能当奖励`,
        );
      }
      const cap = OFFER_LEVEL_VALUE_CAP[offerLevel];
      const value = rewardItemValue(reward);
      if (value > cap) {
        throw new QuestError(
          'reward_over_cap',
          `奖励价值 ${value} 超过「${OFFER_LEVEL_LABEL[offerLevel]}」的上限 ${cap}`,
        );
      }
      return reward;
    }
    case 'affinity': {
      if (!Number.isInteger(reward.amount) || reward.amount < 1) {
        throw new QuestError('invalid_reward', '好感度奖励必须是 ≥ 1 的整数');
      }
      const cap = OFFER_LEVEL_AFFINITY_CAP[offerLevel];
      if (reward.amount > cap) {
        throw new QuestError(
          'reward_over_cap',
          `好感度 +${reward.amount} 超过「${OFFER_LEVEL_LABEL[offerLevel]}」的上限 +${cap}`,
        );
      }
      return reward;
    }
    case 'ability': {
      if (!isAbilityId(reward.abilityId)) {
        throw new QuestError('unknown_ability', `未登记的能力：${String(reward.abilityId)}`);
      }
      if (questTier < ABILITY_REQUIRES_TIER) {
        throw new QuestError(
          'reward_over_cap',
          `功能解锁只允许出现在「大事」上（当前是第 ${questTier} 档）`,
        );
      }
      return reward;
    }
    case 'info': {
      if (typeof reward.topic !== 'string' || !reward.topic.trim() || reward.topic.length > 60) {
        throw new QuestError('invalid_reward', '情报奖励需要一个 1-60 字的主题');
      }
      return reward;
    }
    case 'none':
      return reward;
    default:
      throw new QuestError('invalid_reward', `未知奖励类型：${String((reward as { kind?: unknown }).kind)}`);
  }
}

/** 面向人的奖励描述 */
export function describeReward(reward: RewardDef): string {
  switch (reward.kind) {
    case 'item': {
      const def = getItem(reward.itemId);
      const tier = def ? `，${def.tier}` : '';
      return `「${itemName(reward.itemId)}」×${reward.count}（值 ${rewardItemValue(reward)}${tier}）`;
    }
    case 'affinity':
      return `好感度 +${reward.amount}`;
    case 'ability':
      return `解锁功能：${ABILITY_LABEL[reward.abilityId]}`;
    case 'info':
      return `情报：${reward.topic}`;
    case 'none':
      return `不要奖励（好感度 +${FORGO_AFFINITY_BONUS}）`;
    default:
      return '未知奖励';
  }
}

/**
 * 该 NPC 在当前档位下**拿得出来**的奖励候选。
 * 这是给模型的「只读真相」：有了它，模型不必猜背包里有什么（§2.3）。
 */
export function rewardCandidates(
  npc: NpcState,
  offerLevel: OfferLevel,
): Array<{ item: ItemDef; count: number; value: number }> {
  const cap = OFFER_LEVEL_VALUE_CAP[offerLevel];
  const out: Array<{ item: ItemDef; count: number; value: number }> = [];
  for (const stack of listAvailable(npc.inventory)) {
    const def = getItem(stack.itemId);
    if (!def) continue;
    for (let count = 1; count <= stack.count; count += 1) {
      const value = def.value * count;
      if (value > cap) break;
      out.push({ item: def, count, value });
    }
  }
  return out.sort((a, b) => b.value - a.value);
}
