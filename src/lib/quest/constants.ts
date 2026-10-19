/**
 * 领域常量：珍贵等级、奖励档位、能力白名单、拒绝文案、门控开关。
 * 纯数据，无副作用。
 */
import type { AbilityId, ImpressionKind, ItemTier, OfferLevel, QuestErrorCode } from './types.ts';

/* ------------------------------ 道具用途 ------------------------------ */

/**
 * 用途词表（比 tags 细一档）：NPC 的 `wantsUses` 与道具的 `uses` 都只能从这里取，
 * `auditItemTable()` 会拦住词表外的写法。
 */
export const ITEM_USES: readonly string[] = [
  '疗伤',
  '补血',
  '调和',
  '滋补',
  '提神',
  '吃食',
  '器具',
  '凭据',
  '兵器',
  '材料',
  '信物',
  '传信',
];

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

/**
 * 好感度奖励的单次上限：比道具更保守，因为好感度发放后难以回收。
 * **只有没有守恒的东西才设数值上限** —— 道具奖励有背包守恒，所以不再设价值上限。
 */
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

/* ------------------------------ 印象与好感度 ------------------------------ */

export const IMPRESSION_KINDS: readonly ImpressionKind[] = ['pleased', 'neutral', 'offended'];

/** 印象计分：说到心坎里 +2 / 不咸不淡 0 / 冒犯 -1（温和） */
export const IMPRESSION_DELTA: Record<ImpressionKind, number> = {
  pleased: 2,
  neutral: 0,
  offended: -1,
};

/**
 * 印象冷却（按对话轮数）：同一 NPC 每 2 轮最多因印象涨一次 ——
 * 防「同一套恭维反复刷」。offended **不受冷却限制**：说错话立刻有代价。
 */
export const IMPRESSION_COOLDOWN_ROUNDS = 2;

export const IMPRESSION_LABEL: Record<ImpressionKind, string> = {
  pleased: '说到心坎里',
  neutral: '不咸不淡',
  offended: '冒犯了',
};

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
  invalid_impression: '印象只能记成 pleased / neutral / offended 三种之一',
  impression_cooldown: '同一套恭维短期内重复太多次，这次不再加分',
  invalid_gift_count: '赠送件数必须是正整数',
};
