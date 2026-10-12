/**
 * 领域常量：珍贵等级、奖励档位、能力白名单、拒绝文案、门控开关。
 * 纯数据，无副作用。
 */
import type { AbilityId, ItemTier, OfferLevel, QuestErrorCode } from './types.ts';

/* ------------------------------ 珍贵等级 ------------------------------ */

export const TIER_LIST: readonly ItemTier[] = ['common', 'fine', 'rare', 'epic', 'legendary'];

export const TIER_ORDER: Record<ItemTier, number> = {
  common: 1,
  fine: 2,
  rare: 3,
  epic: 4,
  legendary: 5,
};

export const TIER_LABEL: Record<ItemTier, string> = {
  common: '凡品',
  fine: '良品',
  rare: '上品',
  epic: '珍品',
  legendary: '绝品',
};

/**
 * 每一档的参考价值区间。道具定价必须落在自己那一档里 ——
 * 否则「绝品标 1 文」，等级就成了纯装饰（数据自检会拦住它）。
 */
export const TIER_VALUE_RANGE: Record<ItemTier, readonly [number, number]> = {
  common: [1, 5],
  fine: [6, 20],
  rare: [21, 80],
  epic: [81, 300],
  legendary: [301, 1000],
};

/* ------------------------------ 奖励档位 ------------------------------ */

export const OFFER_LEVEL_LIST: readonly OfferLevel[] = [1, 2, 3];

export const OFFER_LEVEL_LABEL: Record<OfferLevel, string> = {
  1: '薄礼',
  2: '中酬',
  3: '重谢',
};

/** 道具奖励的价值上限：模型只能在档位里让步，不能自己加档（§3.3） */
export const OFFER_LEVEL_VALUE_CAP: Record<OfferLevel, number> = {
  1: 20,
  2: 80,
  3: 300,
};

/** 好感度奖励的单次上限：比道具更保守，因为好感度发放后难以回收 */
export const OFFER_LEVEL_AFFINITY_CAP: Record<OfferLevel, number> = {
  1: 3,
  2: 6,
  3: 10,
};

/**
 * 玩家放弃奖励时固定换取的好感度。
 * 故意取固定小值：如果「不要奖励」收益过高，玩家会永远不要奖励，道具经济就失去意义（§3.3 平衡陷阱）。
 */
export const FORGO_AFFINITY_BONUS = 3;

/** 任务重要性标签 */
export const QUEST_TIER_LABEL: Record<1 | 2 | 3, string> = {
  1: '小事',
  2: '正事',
  3: '大事',
};

/* ------------------------------ 能力白名单 ------------------------------ */

export const ABILITY_LIST: readonly AbilityId[] = ['jieyuan', 'qiecuo', 'michuan'];

export const ABILITY_LABEL: Record<AbilityId, string> = {
  jieyuan: '结缘',
  qiecuo: '切磋',
  michuan: '秘传',
};

/** 能力解锁属于最高价值的奖励，只允许出现在「大事」上（§3.2） */
export const ABILITY_REQUIRES_TIER = 3;

/* ------------------------------ 门控开关 ------------------------------ */

/** 同一 NPC 一次性只出现一个任务，完成才触发下一个（§3.2 串行任务链） */
export const ONE_OPEN_QUEST_PER_NPC = true;

/** 未完结（占用串行链）的状态 */
export const OPEN_QUEST_STATUSES = ['offered', 'accepted'] as const;

/* ------------------------------ 拒绝文案 ------------------------------ */

/** 拒绝码 → 面向人的说明。这张表同时就是「校验规则表」的文案部分。 */
export const ERROR_MESSAGE: Record<QuestErrorCode, string> = {
  invalid_field: '字段不合法',
  unknown_npc: '这个 NPC 不存在',
  unknown_item: '这件道具不在道具白名单里',
  unknown_ability: '这个能力不在能力白名单里',
  invalid_tier: '任务重要性只能是 1（小事）/ 2（正事）/ 3（大事）',
  invalid_offer_level: '奖励档位只能是 1 / 2 / 3',
  idempotency_key_reused: '同一个 requestId 被换了参数重复使用',
  invalid_objective: '目标不符合原语规范',
  unsupported_objective: '这个目标原语依赖尚不存在的系统，暂时无法裁决',
  invalid_reward: '奖励不符合白名单规范',
  reward_not_owned: 'NPC 背包里没有这件奖励道具',
  reward_over_cap: '奖励超过该档位的价值上限',
  npc_reward_unavailable: '这件奖励已被其他任务预留，当前不可用',
  npc_has_open_quest: '该 NPC 已有一个未完结的任务（串行任务链）',
  self_loop_objective_reward: '任务所要之物与奖励是同一件道具，构成自循环套利',
  quest_not_found: '任务不存在',
  quest_not_offered: '任务不处于「已发布」状态',
  quest_not_accepted: '任务不处于「已接取」状态',
  quest_not_submittable: '任务已经结束，无法再次提交',
  deliver_required: '这个任务需要提交道具，但请求里没有带',
  deliver_forbidden: '这个任务不需要提交道具，请求里不该带',
  deliver_mismatch: '提交的道具不是任务所要的那一种',
  deliver_count_too_low: '提交的数量少于任务要求的数量',
  player_item_insufficient: '玩家背包里的这件道具不够',
  objective_not_met: '任务目标尚未达成',
  insufficient_items: '库存不足',
};
