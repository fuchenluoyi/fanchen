/**
 * 世界状态的持久化容错（与 localStorage 的读写只在状态层发生，这里只负责"把脏数据变干净"）。
 *
 * 策略：先造一个**干净的** fresh 世界（NPC 种子 + 玩家默认背包），
 * 再把存档里"能证明自己合法"的部分逐项覆盖上去；任何一项不合法就保留 fresh 的那份。
 * 最坏情况是回到开局，绝不会因为半截脏数据白屏（对齐 AC-10.2 的精神）。
 *
 * 这里**不重跑规则裁决**（档位上限、奖励归属等在创建时就已判定过），
 * 只做形状、白名单与不变式校验 —— 重建预留时复用领域层的 holdItem，
 * 因此"预留不得超过拥有量"这条不变式由领域层保证。
 */
import { createInventory, holdItem } from './inventory.ts';
import { isAbilityId } from './rewards.ts';
import { isKnownItem } from './items.ts';
import { validateObjective } from './objectives.ts';
import { STAGE_IDS } from './relationship.ts';
import { DEFAULT_PLAYER_ID, NPC_SEEDS, createWorld } from './world.ts';
import type {
  AbilityId,
  Hold,
  Inventory,
  ItemStack,
  ObjectivePrimitive,
  Quest,
  QuestCloseReason,
  QuestEvent,
  QuestHistoryEntry,
  QuestStatus,
  RewardDef,
  World,
} from './types.ts';

const QUEST_STATUSES: readonly QuestStatus[] = [
  'offered',
  'accepted',
  'settled',
  'declined',
  'cancelled',
  'expired',
];

const CLOSE_REASONS: readonly QuestCloseReason[] = [
  'declined_by_player',
  'cancelled_by_npc',
  'expired',
  'replaced',
];

const EVENT_TYPES = [
  'quest_proposed',
  'reward_held',
  'quest_accepted',
  'quest_declined',
  'quest_cancelled',
  'items_delivered',
  'reward_granted',
  'reward_released',
  'quest_settled',
  'impression_noted',
] as const;

const MAX_EVENTS = 200;
const MAX_HISTORY = 30;
const MAX_COUNT = 9999;
const MAX_QUESTS = 40;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asInt(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/** 只保留白名单内的道具、正数量、去重合并 */
function normalizeStacks(raw: unknown): ItemStack[] {
  if (!Array.isArray(raw)) return [];
  const out: ItemStack[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const itemId = typeof entry.itemId === 'string' ? entry.itemId : '';
    if (!isKnownItem(itemId)) continue;
    const count = asInt(entry.count, 0);
    if (count <= 0) continue;
    out.push({ itemId, count: Math.min(count, MAX_COUNT) });
  }
  return out;
}

/**
 * 重建背包。
 *
 * 存档里 `stacks` 记的是**可用**部分、`holds` 记的是**已预留**部分，所以恢复时
 * 先把两者合并回"拥有总量"，再用领域层的预留操作重新锁定 —— 这样
 * 「可用 = 总量 − 预留」这条不变式由领域层保证，而不是这里手写一遍。
 * 结构上有问题的预留（未登记道具、数量非正、缺 questId、id 重复）直接丢弃。
 *
 * 存档里有内容却一条都解析不出来 → 视为损坏，回到种子。
 * @param fallback 该主人的开局道具
 */
function normalizeInventory(raw: unknown, ownerId: string, fallback: readonly ItemStack[]): Inventory {
  if (!isRecord(raw)) return createInventory(ownerId, [...fallback]);
  const stacksRaw = Array.isArray(raw.stacks) ? raw.stacks : [];
  const stacks = normalizeStacks(stacksRaw);
  if (stacksRaw.length > 0 && stacks.length === 0) return createInventory(ownerId, [...fallback]);

  const holdsRaw = Array.isArray(raw.holds) ? raw.holds : [];
  const holds: Hold[] = [];
  const seen = new Set<string>();
  for (const entry of holdsRaw) {
    if (!isRecord(entry)) continue;
    const id = asText(entry.id);
    const questId = asText(entry.questId);
    const itemId = typeof entry.itemId === 'string' ? entry.itemId : '';
    const count = asInt(entry.count, 0);
    if (!id || !questId || !isKnownItem(itemId) || count <= 0 || seen.has(id)) continue;
    seen.add(id);
    holds.push({
      id,
      questId,
      itemId,
      count: Math.min(count, MAX_COUNT),
      createdAt: asInt(entry.createdAt, Date.now()),
    });
  }

  const total: ItemStack[] = [
    ...stacks,
    ...holds.map((hold) => ({ itemId: hold.itemId, count: hold.count })),
  ];
  let inventory = createInventory(ownerId, total);
  for (const hold of holds) {
    try {
      inventory = holdItem(inventory, {
        questId: hold.questId,
        itemId: hold.itemId,
        count: hold.count,
        holdId: hold.id,
        at: hold.createdAt,
      }).inventory;
    } catch {
      /* 账对不上的脏预留：丢掉它，但不拖垮整份存档 */
    }
  }
  return inventory;
}

function normalizeRewardShape(raw: unknown): RewardDef | null {
  if (!isRecord(raw)) return null;
  switch (raw.kind) {
    case 'item': {
      const itemId = typeof raw.itemId === 'string' ? raw.itemId : '';
      const count = asInt(raw.count, 0);
      if (!isKnownItem(itemId) || count <= 0) return null;
      return { kind: 'item', itemId, count: Math.min(count, MAX_COUNT) };
    }
    case 'affinity': {
      const amount = asInt(raw.amount, 0);
      if (amount <= 0) return null;
      return { kind: 'affinity', amount };
    }
    case 'ability': {
      if (!isAbilityId(raw.abilityId)) return null;
      return { kind: 'ability', abilityId: raw.abilityId };
    }
    case 'info': {
      const topic = asText(raw.topic);
      if (!topic) return null;
      return { kind: 'info', topic: topic.slice(0, 200) };
    }
    case 'none':
      return { kind: 'none' };
    default:
      return null;
  }
}

function normalizeHistory(raw: unknown): QuestHistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: QuestHistoryEntry[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const to = entry.to;
    if (typeof to !== 'string' || !QUEST_STATUSES.includes(to as QuestStatus)) continue;
    const from = entry.from;
    const note = asText(entry.note);
    out.push({
      at: asInt(entry.at, 0),
      from: typeof from === 'string' && QUEST_STATUSES.includes(from as QuestStatus) ? (from as QuestStatus) : null,
      to: to as QuestStatus,
      ...(note ? { note } : {}),
    });
    if (out.length >= MAX_HISTORY) break;
  }
  return out;
}

/** 校验一条委托；不合法返回 null（调用方丢弃它，不拖垮其它存档） */
function normalizeQuest(raw: unknown, expectedId: string, ownerHolds: readonly Hold[]): Quest | null {
  if (!isRecord(raw)) return null;
  const id = asText(raw.id) ?? expectedId;
  if (!id) return null;
  const requesterId = asText(raw.requesterId);
  if (!requesterId) return null;
  const title = asText(raw.title);
  if (!title) return null;

  const tier = asInt(raw.tier, 0);
  if (tier !== 1 && tier !== 2 && tier !== 3) return null;

  const objectiveRaw = raw.objective;
  if (!isRecord(objectiveRaw)) return null;
  try {
    validateObjective(objectiveRaw as unknown as ObjectivePrimitive);
  } catch {
    return null;
  }

  const reward = normalizeRewardShape(raw.reward);
  if (!reward) return null;

  const offerLevel = asInt(raw.offerLevel, 0);
  if (offerLevel !== 1 && offerLevel !== 2 && offerLevel !== 3) return null;

  const status = raw.status;
  if (typeof status !== 'string' || !QUEST_STATUSES.includes(status as QuestStatus)) return null;

  // 道具奖励必须对得上那条预留锁；对不上说明存档已经不自洽，这条委托无法完成，直接丢弃
  let reservation: Hold | null = null;
  if (reward.kind === 'item') {
    const reservationId = isRecord(raw.rewardReservation) ? asText(raw.rewardReservation.id) : null;
    const found = reservationId ? ownerHolds.find((hold) => hold.id === reservationId) ?? null : null;
    if (!found) return null;
    reservation = { ...found };
  }

  const createdAt = asInt(raw.createdAt, Date.now());
  const provenanceRaw = isRecord(raw.provenance) ? raw.provenance : {};
  const draftedBy = provenanceRaw.draftedBy;

  return {
    id,
    requesterId,
    takerId: asText(raw.takerId) ?? DEFAULT_PLAYER_ID,
    title,
    want: asText(raw.want) ?? title,
    tier,
    objective: objectiveRaw as unknown as ObjectivePrimitive,
    reward,
    offerLevel,
    rewardReservation: reservation,
    status: status as QuestStatus,
    provenance: {
      npcId: asText(provenanceRaw.npcId) ?? requesterId,
      sourceDialogueId: asText(provenanceRaw.sourceDialogueId),
      draftedBy: draftedBy === 'cli' || draftedBy === 'authored' ? draftedBy : 'dialogue',
      createdAt: asInt(provenanceRaw.createdAt, createdAt),
    },
    createdAt,
    acceptedAt: Number.isFinite(raw.acceptedAt) ? asInt(raw.acceptedAt, 0) : null,
    settledAt: Number.isFinite(raw.settledAt) ? asInt(raw.settledAt, 0) : null,
    closedAt: Number.isFinite(raw.closedAt) ? asInt(raw.closedAt, 0) : null,
    closeReason:
      typeof raw.closeReason === 'string' && CLOSE_REASONS.includes(raw.closeReason as QuestCloseReason)
        ? (raw.closeReason as QuestCloseReason)
        : null,
    delivered: normalizeStacks(raw.delivered),
    history: normalizeHistory(raw.history),
  };
}

function normalizeEvents(raw: unknown): QuestEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: QuestEvent[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const type = entry.type;
    if (typeof type !== 'string' || !(EVENT_TYPES as readonly string[]).includes(type)) continue;
    const id = asText(entry.id);
    const npcId = asText(entry.npcId);
    if (!id || !npcId) continue;
    out.push({
      id,
      at: asInt(entry.at, 0),
      type: type as QuestEvent['type'],
      // 印象类事件不属于任何委托，questId 允许为 null
      questId: asText(entry.questId),
      npcId,
      detail: typeof entry.detail === 'string' ? entry.detail.slice(0, 300) : '',
    });
  }
  return out.slice(-MAX_EVENTS);
}

/** 保证自增序号不会与已有 id 撞车（否则恢复后可能生成重复的任务 id） */
function maxSeq(ids: Iterable<string>, fallback: number): number {
  let max = fallback;
  for (const id of ids) {
    const match = /-(\d+)$/.exec(id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max;
}

function normalizeChannel(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/** 把任意来源的存档收敛成一个合法世界；无法确定的部分用开局值 */
export function normalizeStoredWorld(raw: unknown): World {
  const fresh = createWorld();
  if (!isRecord(raw)) return fresh;

  /* ---------------- 玩家 ---------------- */
  const playerRaw = isRecord(raw.player) ? raw.player : null;
  if (playerRaw) {
    fresh.player.name = asText(playerRaw.name)?.slice(0, 20) ?? fresh.player.name;
    fresh.player.inventory = normalizeInventory(
      playerRaw.inventory,
      DEFAULT_PLAYER_ID,
      fresh.player.inventory.stacks,
    );
    const affinityRaw = isRecord(playerRaw.affinity) ? playerRaw.affinity : {};
    for (const [npcId, value] of Object.entries(affinityRaw)) {
      const amount = asInt(value, 0);
      if (amount !== 0) fresh.player.affinity[npcId] = amount;
    }
    if (Array.isArray(playerRaw.abilities)) {
      const abilities: AbilityId[] = [];
      for (const entry of playerRaw.abilities) {
        if (isAbilityId(entry) && !abilities.includes(entry)) abilities.push(entry);
      }
      fresh.player.abilities = abilities;
    }
    if (Array.isArray(playerRaw.knowledge)) {
      fresh.player.knowledge = playerRaw.knowledge
        .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
        .slice(0, 50);
    }
    const talksRaw = isRecord(playerRaw.talks) ? playerRaw.talks : {};
    for (const [npcId, value] of Object.entries(talksRaw)) {
      const rounds = asInt(value, 0);
      if (rounds > 0) fresh.player.talks[npcId] = rounds;
    }
    // 历史最高关系阶段（0..4，单向不回落）
    const peakRaw = isRecord(playerRaw.stagePeak) ? playerRaw.stagePeak : {};
    for (const [npcId, value] of Object.entries(peakRaw)) {
      const peak = asInt(value, 0);
      if (peak > 0) fresh.player.stagePeak[npcId] = Math.min(STAGE_IDS.length - 1, peak);
    }
    // 印象冷却用的轮数记录：只认真正的非负数字，
    // 字符串脏值若退化成 0，会凭空让下一次印象白冷却 2 轮
    const gainRaw = isRecord(playerRaw.impressionGainAt) ? playerRaw.impressionGainAt : {};
    for (const [npcId, value] of Object.entries(gainRaw)) {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        fresh.player.impressionGainAt[npcId] = Math.trunc(value);
      }
    }
  }

  /* ---------------- NPC（只认种子里的那几位） ---------------- */
  const npcsRaw = isRecord(raw.npcs) ? raw.npcs : {};
  for (const seed of NPC_SEEDS) {
    const npcRaw = isRecord(npcsRaw[seed.id]) ? (npcsRaw[seed.id] as Record<string, unknown>) : null;
    if (!npcRaw) continue;
    fresh.npcs[seed.id].inventory = normalizeInventory(npcRaw.inventory, seed.id, seed.inventory);
    fresh.npcs[seed.id].name = asText(npcRaw.name)?.slice(0, 20) ?? fresh.npcs[seed.id].name;
  }

  /* ---------------- 委托 ---------------- */
  const questsRaw = isRecord(raw.quests) ? raw.quests : {};
  const orderRaw = Array.isArray(raw.questOrder) ? raw.questOrder : [];
  const order: string[] = [];
  for (const entry of orderRaw) {
    if (typeof entry === 'string' && !order.includes(entry)) order.push(entry);
  }
  for (const key of Object.keys(questsRaw)) {
    if (!order.includes(key)) order.push(key);
  }
  for (const id of order) {
    if (fresh.questOrder.length >= MAX_QUESTS) break;
    const rawQuest = questsRaw[id];
    const requesterId = isRecord(rawQuest) ? asText(rawQuest.requesterId) : null;
    const ownerNpc = requesterId ? fresh.npcs[requesterId] : undefined;
    if (!ownerNpc) continue;
    const quest = normalizeQuest(rawQuest, id, ownerNpc.inventory.holds);
    if (!quest) continue;
    fresh.quests[quest.id] = quest;
    fresh.questOrder.push(quest.id);
  }

  /* ---------------- 事件 / 幂等 / 序号 ---------------- */
  fresh.events = normalizeEvents(raw.events);

  const processedRaw = isRecord(raw.processed) ? raw.processed : {};
  for (const [requestId, entry] of Object.entries(processedRaw)) {
    if (!isRecord(entry)) continue;
    const op = normalizeChannel(entry.op);
    if (!op) continue;
    fresh.processed[requestId] = {
      op,
      args: typeof entry.args === 'string' ? entry.args : '',
      questId: asText(entry.questId),
    };
  }

  const seqRaw = isRecord(raw.seq) ? raw.seq : {};
  fresh.seq.quest = maxSeq(Object.keys(fresh.quests), asInt(seqRaw.quest, 0));
  fresh.seq.hold = maxSeq(
    Object.values(fresh.npcs).flatMap((npc) => npc.inventory.holds.map((hold) => hold.id)),
    asInt(seqRaw.hold, 0),
  );
  fresh.seq.event = maxSeq(
    fresh.events.map((event) => event.id),
    asInt(seqRaw.event, 0),
  );

  return fresh;
}
