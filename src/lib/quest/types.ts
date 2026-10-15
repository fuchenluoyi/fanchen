/**
 * NPC 委托（Quest）领域模型 —— 类型定义。
 *
 * 语义要点（交接文档 §2.2 / §3.1）：
 *   **任务内容里的「所求者」是 NPC，不是玩家** —— NPC 想要什么，玩家去满足它。
 *   NPC 是发布方兼奖励出借方，玩家是接取方兼交付方。
 *
 * 三层分离：
 *   叙事层（title / want 自由文本，代码不校验、不干涉）
 *   门控层（tier / offerLevel / 库存 / 串行链，全部由代码判定）
 *   经济层（道具只做转移，绝不凭空生成 —— 资源守恒）
 *
 * 本层是纯领域层：不触网、不碰 DOM、不读写 localStorage（NFR-009）。
 */

/* ============================== 珍贵等级 ============================== */

/** 珍贵等级：凡品 → 良品 → 上品 → 珍品 → 绝品 */
export type ItemTier = 'common' | 'fine' | 'rare' | 'epic' | 'legendary';

/* ================================ 道具 ================================ */

export type ItemKind = 'material' | 'medicine' | 'tool' | 'token' | 'treasure';

/** 道具定义（全局注册表里的一条） */
export interface ItemDef {
  id: string;
  name: string;
  tier: ItemTier;
  /** 单位参考价值，必须落在本等级的区间内（见 constants.TIER_VALUE_RANGE） */
  value: number;
  kind: ItemKind;
  /** 是否可堆叠；不可堆叠的贵重品一次只持有一件 */
  stackable: boolean;
  description: string;
  /** 检索标签，供模型消歧与目标原语匹配 */
  tags: readonly string[];
  /**
   * 用途标签（比 tags 细一档）：疗伤 / 补血 / 调和 / 滋补 / 提神 / 吃食 /
   * 器具 / 凭据 / 兵器 / 材料 / 信物 / 传信。NPC 的 `wantsUses` 靠它匹配，
   * 推出「她舍不得给 / 她多余的」—— 那只进叙事与展示。
   */
  uses: readonly string[];
}

export interface ItemStack {
  itemId: string;
  count: number;
}

/* ============================== 背包与预留 ============================== */

/**
 * 预留锁（§3.3 硬约束 3）：发布任务时把奖励从「可用」挪进「已预留」，
 * 防止同一个 NPC 背包里的同一瓶药被两个任务同时承诺出去。
 */
export interface Hold {
  id: string;
  questId: string;
  itemId: string;
  count: number;
  createdAt: number;
}

/**
 * 背包。不变式：totalOf(item) = 可用 + 已预留 —— 预留只是挪位置，不是消失。
 * NPC 与玩家共用同一套结构（NFR-009 纯函数）。
 */
export interface Inventory {
  ownerId: string;
  /** 可用（未被任何任务预留） */
  stacks: ItemStack[];
  /** 已预留（仍属于本背包，但不可他用） */
  holds: Hold[];
}

/* ============================= NPC 与玩家 ============================= */

/** NPC 配置（策划/种子数据侧）：背包是奖励的唯一来源 */
export interface NpcDef {
  id: string;
  name: string;
  title: string;
  /**
   * 慷慨度 0..1 —— 用来裁决奖励档位（好感度上限、能力是否可在这一档出现）。
   * honesty / openness 留给后续（狡诈 NPC 与阶段门控）。
   */
  generosity: number;
  /** 她在意的用途标签：命中则主观估值 ×3（舍不得给） */
  wantsUses: readonly string[];
  /** 她明确觉得多余的道具 id：命中则 ×0.5（拿出去换正好）；优先于 wantsUses */
  spares: readonly string[];
  /** 自然语言喜好，直接写进提示词 */
  likes: readonly string[];
  /** 自然语言忌讳，直接写进提示词 */
  dislikes: readonly string[];
  inventory: readonly ItemStack[];
}

export interface NpcState {
  id: string;
  name: string;
  title: string;
  generosity: number;
  wantsUses: string[];
  spares: string[];
  likes: string[];
  dislikes: string[];
  inventory: Inventory;
}

export interface PlayerState {
  id: string;
  name: string;
  inventory: Inventory;
  /** 每个 NPC 一条好感度 */
  affinity: Record<string, number>;
  /**
   * 历史最高关系阶段索引（单向不回落）：好感度掉了也不降阶。
   * 见 relationship.ts 的 stageIndexOf。
   */
  stagePeak: Record<string, number>;
  /** 上一次因印象拿到好感度时的对话轮数（冷却用），见 IMPRESSION_COOLDOWN_ROUNDS */
  impressionGainAt: Record<string, number>;
  /** 已解锁的功能（布尔锁，不会耗尽） */
  abilities: AbilityId[];
  /** 已获得的情报 */
  knowledge: string[];
  /** 每个 NPC 的累计对话轮数（talk_count 原语与阶段门控用） */
  talks: Record<string, number>;
}

/** 印象：模型对「这一轮说到心坎里 / 冒犯了她」的判断（好感度的涨法） */
export type ImpressionKind = 'pleased' | 'neutral' | 'offended';

/* =============================== 奖励 =============================== */

/** 能力白名单：布尔锁，无限、无膨胀风险，正好承载最高价值的奖励（§3.2） */
export type AbilityId = 'jieyuan' | 'qiecuo' | 'michuan';

/** 奖励档位：薄礼 / 中酬 / 重谢。数值由代码查表，模型只能在档位内让步（§3.3） */
export type OfferLevel = 1 | 2 | 3;

/** 任务重要性：小事 / 正事 / 大事（§3.2 表格） */
export type QuestTier = 1 | 2 | 3;

export type RewardDef =
  | { kind: 'item'; itemId: string; count: number }
  | { kind: 'affinity'; amount: number }
  | { kind: 'ability'; abilityId: AbilityId }
  | { kind: 'info'; topic: string }
  /** 玩家放弃奖励，固定换一点好感度（§3.3） */
  | { kind: 'none' };

/* ============================= 目标原语 ============================= */

/**
 * 目标必须是可判定原语 —— 模型不能发明「让我开心就行」这种无法验证的目标（§3.6）。
 */
export type ObjectivePrimitive =
  /** 把道具交给该 NPC（提交时扣除并转移，用户描述的核心场景） */
  | { kind: 'deliver_item'; itemId: string; count: number }
  /** 只需持有（证明有，不扣除） */
  | { kind: 'has_item'; itemId: string; count: number }
  /** 与该 NPC 累计对话达到 N 轮 */
  | { kind: 'talk_count'; rounds: number }
  /** 好感度达标 */
  | { kind: 'affinity_at_least'; value: number }
  /** 击败目标 —— 战斗系统尚不存在，登记为待依赖原语（§3.4 隐藏依赖） */
  | { kind: 'defeat'; targetId: string };

/** 原语的可用状态：supported = 可裁决；pending_dependency = 依赖尚不存在的系统 */
export type PrimitiveSupport = 'supported' | 'pending_dependency';

/* =============================== 任务 =============================== */

export type QuestStatus =
  | 'offered' // 已发布，奖励已预留，等玩家接取
  | 'accepted' // 玩家已接取
  | 'settled' // 已交付并结算完毕
  | 'declined' // 玩家婉拒
  | 'cancelled' // NPC／系统撤销
  | 'expired'; // 条件失效

export type QuestCloseReason = 'declined_by_player' | 'cancelled_by_npc' | 'expired' | 'replaced';

export interface QuestHistoryEntry {
  at: number;
  from: QuestStatus | null;
  to: QuestStatus;
  note?: string;
}

/**
 * 溯源（§2.4「没有模板 ID ≠ 没有记录」）：
 * 涌现式任务没有策划模板，但一旦说出口就必须落库，否则刷新即消失、NPC 不认账、无法审计。
 */
export interface QuestProvenance {
  npcId: string;
  /** 来源对话 id；命令行/脚本发起时为 null */
  sourceDialogueId: string | null;
  /** 谁起草的：模型在对话里提出 / 脚本发起 / 策划写死 */
  draftedBy: 'dialogue' | 'cli' | 'authored';
  createdAt: number;
}

export interface Quest {
  id: string;
  /** 所求者：任务内容里想要东西的一方 —— 永远是 NPC */
  requesterId: string;
  /** 接取方 */
  takerId: string;
  title: string;
  /** NPC 想要什么的自然叙述（叙事层自由，代码不校验内容） */
  want: string;
  tier: QuestTier;
  objective: ObjectivePrimitive;
  reward: RewardDef;
  offerLevel: OfferLevel;
  /** 发放中的奖励预留锁；非道具奖励为 null */
  rewardReservation: Hold | null;
  status: QuestStatus;
  provenance: QuestProvenance;
  createdAt: number;
  acceptedAt: number | null;
  settledAt: number | null;
  closedAt: number | null;
  closeReason: QuestCloseReason | null;
  /** 提交记录：道具真的被扣掉的那一刻先落库（§3.4 硬要求） */
  delivered: ItemStack[];
  history: QuestHistoryEntry[];
}

/* ============================= 世界与事件 ============================= */

export type QuestEventType =
  | 'quest_proposed'
  | 'reward_held'
  | 'quest_accepted'
  | 'quest_declined'
  | 'quest_cancelled'
  | 'items_delivered'
  | 'reward_granted'
  | 'reward_released'
  | 'quest_settled'
  | 'impression_noted';

export interface QuestEvent {
  id: string;
  at: number;
  type: QuestEventType;
  /** 印象类事件不属于任何委托，此时为 null */
  questId: string | null;
  npcId: string;
  detail: string;
}

/** 幂等记录：只有成功的操作才写入，拒绝不动世界 */
export interface ProcessedRecord {
  op: string;
  /** 入参指纹，用于识别「同一个 requestId 换了参数」这种客户端 bug */
  args: string;
  questId: string | null;
}

export interface World {
  player: PlayerState;
  npcs: Record<string, NpcState>;
  quests: Record<string, Quest>;
  /** 任务创建顺序，便于列表展示 */
  questOrder: string[];
  events: QuestEvent[];
  processed: Record<string, ProcessedRecord>;
  seq: { quest: number; hold: number; event: number };
}

/* ========================== 裁决结果与错误 ========================== */

export type QuestErrorCode =
  | 'invalid_field'
  | 'unknown_npc'
  | 'unknown_item'
  | 'unknown_ability'
  | 'invalid_tier'
  | 'idempotency_key_reused'
  | 'invalid_objective'
  | 'unsupported_objective'
  | 'invalid_reward'
  | 'reward_not_owned'
  | 'reward_over_cap'
  | 'npc_reward_unavailable'
  | 'npc_has_open_quest'
  | 'self_loop_objective_reward'
  | 'quest_not_found'
  | 'quest_not_offered'
  | 'quest_not_accepted'
  | 'quest_not_submittable'
  | 'deliver_required'
  | 'deliver_forbidden'
  | 'deliver_mismatch'
  | 'deliver_count_too_low'
  | 'player_item_insufficient'
  | 'objective_not_met'
  | 'insufficient_items'
  | 'invalid_impression'
  | 'impression_cooldown';

/** 领域错误：只带拒绝码与面向人的说明，不带栈语义 */
export class QuestError extends Error {
  readonly code: QuestErrorCode;
  constructor(code: QuestErrorCode, message: string) {
    super(message);
    this.name = 'QuestError';
    this.code = code;
  }
}

/** 成功：world 是变更后的**新**世界（入参世界不被修改） */
export interface Applied {
  ok: true;
  world: World;
  quest: Quest | null;
  /** true = 幂等重放，未做任何变更 */
  replay: boolean;
  /** 本次实际发生的事务步骤，供审计与命令行演示 */
  applied: string[];
}

/** 拒绝：world 与入参**完全一致**（原子性：不留半成品） */
export interface Rejected {
  ok: false;
  world: World;
  code: QuestErrorCode;
  message: string;
  quest: Quest | null;
}

export type Adjudication = Applied | Rejected;
