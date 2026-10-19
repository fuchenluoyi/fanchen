/**
 * 世界状态：玩家、NPC、任务、事件流水、幂等记录。
 *
 * 世界是一份**可序列化的纯数据**（不持有函数、不定时器），因此：
 *   - 可以直接 JSON 落库（后续接 localStorage / 服务端都不用改结构）；
 *   - 可以整体克隆做事务草案（裁决层的原子性就靠它）。
 *
 * 查询函数（inspect* / openQuestOfNpc / ...）是纯读；
 * 带 `draft` 字样的辅助函数只允许裁决层在草案世界上调用。
 */
import { ITEM_LIST, getItem } from './items.ts';
import { availableOf, createInventory, listAvailable, listHolds, totalOf } from './inventory.ts';
import type {
  ItemDef,
  ItemStack,
  NpcDef,
  NpcState,
  PlayerState,
  Quest,
  QuestEvent,
  QuestEventType,
  QuestStatus,
  World,
} from './types.ts';

export const DEFAULT_PLAYER_ID = 'player';

/**
 * NPC 种子数据：背包就是奖励池，也是「发不出奖励就不触发任务」的天然闸门。
 *
 * 每位 NPC 都写了「她在意的用途」与「她多余的」：
 *   wantsUses —— 命中则主观估值 ×3（舍不得给，写进提示词让它肉疼）
 *   spares    —— 命中则 ×0.5（拿出去换正好），优先于 wantsUses
 * 每个背包都**故意混着**这两类，别把人配成"什么都不在乎"。
 */
export const NPC_SEEDS: readonly NpcDef[] = [
  {
    id: 'su-wanzhao',
    name: '苏晚照',
    title: '药庐女医',
    generosity: 0.6,
    wantsUses: ['疗伤', '补血', '调和'],
    // 灵芝她留着没用 —— 正是「多余的」，拿出去换人情正好
    spares: ['century-lingzhi'],
    likes: ['能救人的药材', '肯为素不相识的人跑一趟'],
    dislikes: ['拿人命讨价还价', '见伤不救还振振有词'],
    inventory: [
      { itemId: 'sanqi', count: 2 },
      { itemId: 'danggui', count: 1 },
      { itemId: 'gancao', count: 3 },
      { itemId: 'jinchuang-gao', count: 2 },
      { itemId: 'mugwort', count: 2 },
      { itemId: 'huoxue-san', count: 1 },
      { itemId: 'century-lingzhi', count: 1 },
      { itemId: 'rations', count: 3 },
    ],
  },
  {
    id: 'lu-xingzhou',
    name: '陆行舟',
    title: '走商',
    generosity: 0.75,
    wantsUses: ['凭据', '信物', '器具'],
    // 干粮清水他多得是，给出去不心疼
    spares: ['rations', 'water'],
    likes: ['爽快人', '懂行情的买家'],
    dislikes: ['赊账不还', '拿假货糊弄他'],
    inventory: [
      { itemId: 'rations', count: 5 },
      { itemId: 'water', count: 4 },
      { itemId: 'gancao', count: 2 },
      { itemId: 'fire-starter', count: 2 },
      { itemId: 'bamboo-whistle', count: 1 },
      { itemId: 'coldiron-needle', count: 2 },
      { itemId: 'jade-beads', count: 1 },
      { itemId: 'bamboo-tally', count: 2 },
      { itemId: 'coin-string', count: 3 },
    ],
  },
  {
    id: 'a-lai',
    name: '阿癞',
    title: '落魄游侠',
    generosity: 0.2,
    wantsUses: ['吃食', '疗伤'],
    spares: [],
    likes: ['给他一口热乎的', '不提他的旧事'],
    dislikes: ['施舍的语气', '拿他的落魄开玩笑'],
    // 空背包：身无长物 → 发不出奖励 → 不该触发任务（§3.2）。
    // 他是「背包枯竭就不触发任务」这道闸门的样板，故意留空、不给他配东西。
    inventory: [],
  },
];

/* ----------------------- 主观估值（只进叙事与展示） ----------------------- */

/** 命中「她在意的用途」时的倍数：舍不得给 */
export const CHERISHED_MULTIPLIER = 3;
/** 命中「她多余的」时的倍数：拿出去换正好 */
export const SPARE_MULTIPLIER = 0.5;

export type NpcItemBias = 'cherished' | 'spare' | 'neutral';

/**
 * 这位 NPC 怎么看这件道具：
 *   spares 命中 → 'spare'（**优先**，用来覆盖用途推不出来的特例）
 *   wantsUses 与道具的 uses 相交 → 'cherished'
 *   其余 → 'neutral'
 *
 * ⚠️ 主观估值**只准进提示词与展示**：任何裁决都不得据它驳回提案
 * （用户拍板：只做叙事引导）。
 */
export function itemBiasFor(npc: NpcState, itemId: string): NpcItemBias {
  if (npc.spares.includes(itemId)) return 'spare';
  const item = getItem(itemId);
  if (!item) return 'neutral';
  return item.uses.some((use) => npc.wantsUses.includes(use)) ? 'cherished' : 'neutral';
}

/** 主观估值 = 参考价值 × 主观倍数（四舍五入） */
export function subjectiveValueOf(npc: NpcState, itemId: string): number {
  const base = getItem(itemId)?.value ?? 0;
  const bias = itemBiasFor(npc, itemId);
  if (bias === 'cherished') return Math.round(base * CHERISHED_MULTIPLIER);
  if (bias === 'spare') return Math.round(base * SPARE_MULTIPLIER);
  return base;
}

function biasItems(npc: NpcState, bias: NpcItemBias): ItemDef[] {
  const out: ItemDef[] = [];
  for (const stack of listAvailable(npc.inventory)) {
    const item = getItem(stack.itemId);
    if (item && itemBiasFor(npc, stack.itemId) === bias) out.push(item);
  }
  return out.sort((a, b) => b.value - a.value);
}

/** 背包里让她「舍不得给」的东西（按参考价值降序） */
export function cherishedItems(npc: NpcState): ItemDef[] {
  return biasItems(npc, 'cherished');
}

/** 背包里她觉得「多余」的东西 */
export function spareItems(npc: NpcState): ItemDef[] {
  return biasItems(npc, 'spare');
}

/**
 * 玩家开局背包的**显式**条目：这几件多给一点，其余的按下表补齐到 1 件。
 * 寻药这类委托需要玩家先有可交之物 —— 所以这里给的是 2 件，别的只给 1 件当"见过面"。
 */
export const DEFAULT_PLAYER_INVENTORY: readonly ItemStack[] = [
  { itemId: 'sanqi', count: 1 },
  { itemId: 'gancao', count: 2 },
  { itemId: 'rations', count: 2 },
];

/**
 * 把显式条目补齐成「道具表里每一件都至少 ×1」：已列出的保持原量，缺的补 1 件。
 * 只改内容、不重复加 —— 同一件道具在结果里只会出现一次。
 */
export function completePlayerInventory(base: readonly ItemStack[] = []): ItemStack[] {
  const countOf = new Map<string, number>();
  for (const stack of base) {
    countOf.set(stack.itemId, (countOf.get(stack.itemId) ?? 0) + stack.count);
  }
  for (const def of ITEM_LIST) {
    if (!countOf.has(def.id)) countOf.set(def.id, 1);
  }
  return [...countOf.entries()].map(([itemId, count]) => ({ itemId, count }));
}

/**
 * 玩家**开局**背包 = 全部 32 件道具各至少 1 件（FR-027）。
 *
 * 只影响新世界（新存档）。老存档保持原样 —— 补领由玩家自己决定，不做隐式迁移。
 */
export const STARTING_PLAYER_INVENTORY: readonly ItemStack[] = completePlayerInventory(DEFAULT_PLAYER_INVENTORY);

export interface CreateWorldOptions {
  playerName?: string;
  playerInventory?: readonly ItemStack[];
  /** 只放一部分 NPC 进去（测试用） */
  npcIds?: readonly string[];
}

export function createWorld(options: CreateWorldOptions = {}): World {
  const seeds = options.npcIds
    ? NPC_SEEDS.filter((seed) => options.npcIds?.includes(seed.id))
    : NPC_SEEDS;
  const npcs: Record<string, NpcState> = {};
  for (const seed of seeds) {
    npcs[seed.id] = {
      id: seed.id,
      name: seed.name,
      title: seed.title,
      generosity: seed.generosity,
      wantsUses: [...seed.wantsUses],
      spares: [...seed.spares],
      likes: [...seed.likes],
      dislikes: [...seed.dislikes],
      inventory: createInventory(seed.id, [...seed.inventory]),
    };
  }
  const player: PlayerState = {
    id: DEFAULT_PLAYER_ID,
    name: options.playerName ?? '行客',
    inventory: createInventory(DEFAULT_PLAYER_ID, [...(options.playerInventory ?? STARTING_PLAYER_INVENTORY)]),
    affinity: {},
    stagePeak: {},
    impressionGainAt: {},
    abilities: [],
    knowledge: [],
    talks: {},
  };
  return {
    player,
    npcs,
    quests: {},
    questOrder: [],
    events: [],
    processed: {},
    seq: { quest: 0, hold: 0, event: 0 },
  };
}

/** 事务草案：整体深拷贝，失败就整个丢掉（裁决层的原子性靠这个） */
export function cloneWorld(world: World): World {
  if (typeof structuredClone === 'function') return structuredClone(world);
  return JSON.parse(JSON.stringify(world)) as World;
}

/* ------------------------------ 纯查询 ------------------------------ */

export function getNpc(world: World, npcId: string): NpcState | null {
  return world.npcs[npcId] ?? null;
}

export function getQuest(world: World, questId: string): Quest | null {
  return world.quests[questId] ?? null;
}

export function isOpenStatus(status: QuestStatus): boolean {
  return status === 'offered' || status === 'accepted';
}

/** 该 NPC 当前未完结的任务（串行任务链用） */
export function openQuestOfNpc(world: World, npcId: string): Quest | null {
  for (const questId of world.questOrder) {
    const quest = world.quests[questId];
    if (quest && quest.requesterId === npcId && isOpenStatus(quest.status)) return quest;
  }
  return null;
}

export function questsOfNpc(world: World, npcId: string): Quest[] {
  return world.questOrder
    .map((questId) => world.quests[questId])
    .filter((quest): quest is Quest => Boolean(quest) && quest.requesterId === npcId);
}

export function questsByStatus(world: World, status: QuestStatus): Quest[] {
  return world.questOrder
    .map((questId) => world.quests[questId])
    .filter((quest): quest is Quest => Boolean(quest) && quest.status === status);
}

/* --------------------------- 只读真相快照 --------------------------- */

/**
 * 给模型看的 NPC 快照（对应设计里的 inquire_inventory：只读，不执行）。
 * 幻觉的根治办法是给它事实，不是让它记住。
 */
export interface NpcSnapshot {
  id: string;
  name: string;
  title: string;
  generosity: number;
  /** 她在意的用途 / 她多余的（主观估值只进提示词与展示，不参与裁决） */
  wantsUses: string[];
  spares: string[];
  likes: string[];
  dislikes: string[];
  available: Array<{
    itemId: string;
    name: string;
    tier: string;
    count: number;
    unitValue: number;
    /** 她怎么看这件东西 */
    bias: NpcItemBias;
    /** 她心里的估值（参考价值 × 主观倍数） */
    subjectiveValue: number;
  }>;
  held: Array<{ itemId: string; name: string; count: number; questId: string }>;
  openQuestId: string | null;
}

export function inspectNpc(world: World, npcId: string): NpcSnapshot | null {
  const npc = getNpc(world, npcId);
  if (!npc) return null;
  const open = openQuestOfNpc(world, npcId);
  return {
    id: npc.id,
    name: npc.name,
    title: npc.title,
    generosity: npc.generosity,
    wantsUses: [...npc.wantsUses],
    spares: [...npc.spares],
    likes: [...npc.likes],
    dislikes: [...npc.dislikes],
    available: listAvailable(npc.inventory).map((stack) => ({
      itemId: stack.itemId,
      name: getItem(stack.itemId)?.name ?? stack.itemId,
      tier: getItem(stack.itemId)?.tier ?? 'common',
      count: stack.count,
      unitValue: getItem(stack.itemId)?.value ?? 0,
      bias: itemBiasFor(npc, stack.itemId),
      subjectiveValue: subjectiveValueOf(npc, stack.itemId),
    })),
    held: listHolds(npc.inventory).map((hold) => ({
      itemId: hold.itemId,
      name: getItem(hold.itemId)?.name ?? hold.itemId,
      count: hold.count,
      questId: hold.questId,
    })),
    openQuestId: open?.id ?? null,
  };
}

export interface PlayerSnapshot {
  id: string;
  name: string;
  available: Array<{ itemId: string; name: string; tier: string; count: number; unitValue: number }>;
  affinity: Record<string, number>;
  abilities: string[];
  knowledge: string[];
  talks: Record<string, number>;
}

export function inspectPlayer(world: World): PlayerSnapshot {
  return {
    id: world.player.id,
    name: world.player.name,
    available: listAvailable(world.player.inventory).map((stack) => ({
      itemId: stack.itemId,
      name: getItem(stack.itemId)?.name ?? stack.itemId,
      tier: getItem(stack.itemId)?.tier ?? 'common',
      count: stack.count,
      unitValue: getItem(stack.itemId)?.value ?? 0,
    })),
    affinity: { ...world.player.affinity },
    abilities: [...world.player.abilities],
    knowledge: [...world.player.knowledge],
    talks: { ...world.player.talks },
  };
}

/* ------------------------- 草案世界上的写入辅助 ------------------------- */

/** 只在草案世界上调用：取下一个自增 id */
export function nextId(draft: World, kind: keyof World['seq']): string {
  draft.seq[kind] += 1;
  return `${kind}-${draft.seq[kind]}`;
}

/** 只在草案世界上调用：追加事件流水 */
export function draftPushEvent(
  draft: World,
  input: { type: QuestEventType; questId: string | null; npcId: string; detail: string; at: number },
): QuestEvent {
  const event: QuestEvent = {
    id: nextId(draft, 'event'),
    at: input.at,
    type: input.type,
    questId: input.questId,
    npcId: input.npcId,
    detail: input.detail,
  };
  draft.events.push(event);
  return event;
}

/** 世界自检：预留不得超过拥有量、任务所指 NPC 必须存在、道具都必须在白名单里 */
export function auditWorld(world: World): string[] {
  const problems: string[] = [];
  for (const npc of Object.values(world.npcs)) {
    for (const hold of npc.inventory.holds) {
      if (totalOf(npc.inventory, hold.itemId) < hold.count) {
        problems.push(`${npc.name} 的预留 ${hold.id} 超过了拥有量`);
      }
    }
  }
  for (const questId of world.questOrder) {
    const quest = world.quests[questId];
    if (!quest) {
      problems.push(`任务顺序里引用了不存在的任务：${questId}`);
      continue;
    }
    if (!world.npcs[quest.requesterId]) problems.push(`任务 ${questId} 的所求者不存在`);
    if (quest.reward.kind === 'item' && getItem(quest.reward.itemId) === null) {
      problems.push(`任务 ${questId} 的奖励道具未登记`);
    }
  }
  if (world.player.inventory.holds.length > 0) problems.push('玩家背包不应存在预留');
  return problems;
}

/** 供展示：某件道具在玩家与全部 NPC 处的总量（资源守恒断言用） */
export function worldTotalOf(world: World, itemId: string): number {
  let sum = availableOf(world.player.inventory, itemId);
  for (const npc of Object.values(world.npcs)) sum += totalOf(npc.inventory, itemId);
  return sum;
}
