/**
 * 裁决层（§2.3「AI 提意图，系统做裁决」）。
 *
 * 这里是唯一能改变世界的地方，四条纪律：
 *   1. **幂等**：每个操作都要 requestId；同一个 requestId 重放只返回首次结果，世界不再变。
 *   2. **原子**：全部改动发生在克隆出来的草案世界上；任何校验失败就丢掉草案，
 *      返回与入参**完全一致**的原世界 —— 绝不留下「道具扣了但奖励没发」这种半成品。
 *   3. **预留锁**：发布任务时把奖励从 NPC 背包的「可用」挪进「已预留」，
 *      防止同一件道具被两个任务同时承诺出去；婉拒/撤销/过期时释放。
 *   4. **守恒**：道具只做转移（玩家 ↔ NPC），绝不凭空生成或销毁。
 *
 * 拒绝一律返回 { ok: false, code, message }，code 见 constants.ERROR_MESSAGE ——
 * 那张表就是给模型和界面看的「校验规则表」。
 */
import {
  ABILITY_LABEL,
  ERROR_MESSAGE,
  FORGO_AFFINITY_BONUS,
  IMPRESSION_COOLDOWN_ROUNDS,
  IMPRESSION_DELTA,
  IMPRESSION_KINDS,
  IMPRESSION_LABEL,
  ONE_OPEN_QUEST_PER_NPC,
} from './constants.ts';
import { QuestError } from './types.ts';
import type {
  Adjudication,
  Applied,
  Hold,
  ImpressionKind,
  ItemStack,
  OfferLevel,
  PlayerState,
  Quest,
  QuestTier,
  RewardDef,
  World,
  ObjectivePrimitive,
} from './types.ts';
import { addItems, availableOf, consumeHold, holdItem, releaseHoldsForQuest, removeAvailable } from './inventory.ts';
import { ITEM_LIST, isKnownItem, itemName } from './items.ts';
import {
  assertObjectiveSupported,
  describeObjective,
  objectiveItemRef,
  objectiveSatisfied,
  validateObjective,
} from './objectives.ts';
import { nextStagePeak } from './relationship.ts';
import { describeReward, maxOfferLevel, rewardItemRef, validateReward } from './rewards.ts';
import { cloneWorld, draftPushEvent, getNpc, getQuest, nextId, openQuestOfNpc } from './world.ts';

/* ============================== 输入类型 ============================== */

export interface ProposeQuestInput {
  /** 幂等键：同一次提议无论重试多少次，世界只会变一次 */
  requestId: string;
  npcId: string;
  title: string;
  /** NPC 想要什么的自然叙述（叙事层自由，不校验内容） */
  want: string;
  tier: QuestTier;
  objective: ObjectivePrimitive;
  reward: RewardDef;
  /**
   * 档位**由代码算**：`maxOfferLevel({ questTier, generosity })`。
   * 模型不再自报档位（自报那次正是翻车的源头），所以这里没有 offer_level 入参。
   * 算出来的档位只用于两件事：好感度奖励的上限、能力奖励是否允许出现在这一档。
   */
  sourceDialogueId?: string | null;
  draftedBy?: 'dialogue' | 'cli' | 'authored';
  now?: number;
}

export interface QuestRefInput {
  requestId: string;
  questId: string;
  now?: number;
}

export interface CloseQuestInput extends QuestRefInput {
  reason?: string;
}

export interface SubmitQuestInput extends QuestRefInput {
  /** 交付型目标要带上的道具；非交付型不得携带 */
  deliver?: ItemStack;
}

/* ============================== 内部工具 ============================== */

function requireRequestId(requestId: string): void {
  if (typeof requestId !== 'string' || !requestId.trim()) {
    throw new QuestError('invalid_field', 'requestId 不能为空：幂等键是裁决层的硬要求');
  }
}

/**
 * 只在草案世界上调用：把「历史最高关系阶段」抬到当前好感度对应的位置。
 * **单向不回落** —— 好感度掉下去也不降阶（玩家会记得"我们曾经是知己"）。
 */
function bumpStagePeak(player: PlayerState, npcId: string): void {
  player.stagePeak[npcId] = nextStagePeak(player.affinity[npcId] ?? 0, player.stagePeak[npcId]);
}

/**
 * 幂等闸门：命中已处理的 requestId 就返回重放结果；否则开一份草案世界。
 * 换了参数复用同一个 key 属于客户端 bug，直接拒绝。
 */
function begin(
  world: World,
  requestId: string,
  op: string,
  args: unknown,
): { replay: Applied | null; draft: World } {
  const record = world.processed[requestId];
  if (record) {
    const fingerprint = JSON.stringify(args);
    if (record.op !== op || record.args !== fingerprint) {
      throw new QuestError(
        'idempotency_key_reused',
        `requestId「${requestId}」已经用于「${record.op}」，不能换个参数复用`,
      );
    }
    const quest = record.questId ? world.quests[record.questId] ?? null : null;
    return { replay: { ok: true, world, quest, replay: true, applied: [] }, draft: world };
  }
  return { replay: null, draft: cloneWorld(world) };
}

function commit(
  draft: World,
  requestId: string,
  op: string,
  args: unknown,
  questId: string | null,
): void {
  draft.processed[requestId] = { op, args: JSON.stringify(args), questId };
}

function mustGetQuest(world: World, questId: string): Quest {
  const quest = getQuest(world, questId);
  if (!quest) throw new QuestError('quest_not_found', `没有这个任务：${questId}`);
  return quest;
}

function toRejection(world: World, err: unknown, quest: Quest | null): Adjudication {
  if (err instanceof QuestError) {
    return { ok: false, world, code: err.code, message: err.message, quest };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, world, code: 'invalid_field', message, quest };
}

function closeQuest(
  draft: World,
  quest: Quest,
  input: { status: Quest['status']; reason: string; closeReason: Quest['closeReason']; at: number; eventType: 'quest_declined' | 'quest_cancelled' },
): string[] {
  const applied: string[] = [];
  const npc = getNpc(draft, quest.requesterId);
  if (npc && quest.rewardReservation) {
    npc.inventory = releaseHoldsForQuest(npc.inventory, quest.id);
    applied.push(`释放预留：${describeReward(quest.reward)}`);
    draftPushEvent(draft, {
      type: 'reward_released',
      questId: quest.id,
      npcId: npc.id,
      detail: `释放预留 ${describeReward(quest.reward)}`,
      at: input.at,
    });
  }
  const from = quest.status;
  quest.rewardReservation = null;
  quest.status = input.status;
  quest.closedAt = input.at;
  quest.closeReason = input.closeReason;
  quest.history.push({ at: input.at, from, to: input.status, note: input.reason });
  draftPushEvent(draft, {
    type: input.eventType,
    questId: quest.id,
    npcId: quest.requesterId,
    detail: input.reason,
    at: input.at,
  });
  applied.push(`委托 ${quest.id} → ${input.status}（${input.reason}）`);
  return applied;
}

/* ============================== 发布委托 ============================== */

/**
 * 发布一条**涌现式**委托：没有策划模板，内容由这次对话（或脚本）现场给出；
 * 但目标、奖励、档位、库存、串行链全部要过代码这一关。
 */
export function proposeQuest(world: World, input: ProposeQuestInput): Adjudication {
  try {
    requireRequestId(input.requestId);
    const draftedBy = input.draftedBy ?? 'dialogue';
    const fingerprint = {
      npcId: input.npcId,
      title: input.title,
      want: input.want,
      tier: input.tier,
      objective: input.objective,
      reward: input.reward,
      sourceDialogueId: input.sourceDialogueId ?? null,
      draftedBy,
    };
    const { replay, draft } = begin(world, input.requestId, 'propose_quest', fingerprint);
    if (replay) return replay;
    const now = input.now ?? Date.now();

    const npc = getNpc(draft, input.npcId);
    if (!npc) throw new QuestError('unknown_npc', `没有这个 NPC：${input.npcId}`);
    if (typeof input.title !== 'string' || !input.title.trim()) {
      throw new QuestError('invalid_field', '任务标题不能为空');
    }
    if (typeof input.want !== 'string' || !input.want.trim()) {
      throw new QuestError('invalid_field', '必须写清 NPC 想要什么（want）');
    }
    if (input.tier !== 1 && input.tier !== 2 && input.tier !== 3) {
      throw new QuestError('invalid_tier', ERROR_MESSAGE.invalid_tier);
    }

    validateObjective(input.objective);
    assertObjectiveSupported(input.objective);

    // 档位由代码算，模型自报无效（自报档位正是上次翻车的源头）
    const offerLevel: OfferLevel = maxOfferLevel({ questTier: input.tier, generosity: npc.generosity });

    validateReward(npc, input.reward, offerLevel, input.tier);

    // 套利校验：所要之物与所给之物是同一件，等于空手刷奖励
    const objectiveRef = objectiveItemRef(input.objective);
    const rewardRef = rewardItemRef(input.reward);
    if (objectiveRef && rewardRef && objectiveRef.itemId === rewardRef.itemId) {
      throw new QuestError(
        'self_loop_objective_reward',
        `任务要的「${itemName(objectiveRef.itemId)}」和奖励是同一件，构成自循环`,
      );
    }

    // 串行任务链：一次性只出现一个任务（§3.2）
    if (ONE_OPEN_QUEST_PER_NPC) {
      const open = openQuestOfNpc(draft, npc.id);
      if (open) {
        throw new QuestError(
          'npc_has_open_quest',
          `${npc.name} 手上还有一个未完结的委托「${open.title}」，先了结它`,
        );
      }
    }

    const questId = nextId(draft, 'quest');
    let reservation: Hold | null = null;
    if (rewardRef) {
      if (availableOf(npc.inventory, rewardRef.itemId) < rewardRef.count) {
        throw new QuestError(
          'npc_reward_unavailable',
          `「${itemName(rewardRef.itemId)}」已被其他任务预留，${npc.name} 手头可用不足`,
        );
      }
      const held = holdItem(npc.inventory, {
        questId,
        itemId: rewardRef.itemId,
        count: rewardRef.count,
        holdId: nextId(draft, 'hold'),
        at: now,
      });
      npc.inventory = held.inventory;
      reservation = held.hold;
    }

    const quest: Quest = {
      id: questId,
      // 所求者是 NPC —— 任务内容里想要东西的一方
      requesterId: npc.id,
      takerId: draft.player.id,
      title: input.title.trim(),
      want: input.want.trim(),
      tier: input.tier,
      objective: input.objective,
      reward: input.reward,
      offerLevel,
      rewardReservation: reservation,
      status: 'offered',
      provenance: {
        npcId: npc.id,
        sourceDialogueId: input.sourceDialogueId ?? null,
        draftedBy,
        createdAt: now,
      },
      createdAt: now,
      acceptedAt: null,
      settledAt: null,
      closedAt: null,
      closeReason: null,
      delivered: [],
      history: [
        {
          at: now,
          from: null,
          to: 'offered',
          note: '涌现式任务：现场起草、当场落库，没有策划模板',
        },
      ],
    };
    draft.quests[questId] = quest;
    draft.questOrder.push(questId);

    const applied: string[] = [
      `${npc.name} 发布委托 ${questId}「${quest.title}」：想要 —— ${quest.want}`,
      `目标：${describeObjective(quest.objective)}；奖励：${describeReward(quest.reward)}`,
    ];
    draftPushEvent(draft, {
      type: 'quest_proposed',
      questId,
      npcId: npc.id,
      detail: `${npc.name} 想要「${quest.want}」`,
      at: now,
    });
    if (reservation) {
      applied.push(`预留奖励（锁定）：「${itemName(reservation.itemId)}」×${reservation.count}`);
      draftPushEvent(draft, {
        type: 'reward_held',
        questId,
        npcId: npc.id,
        detail: `预留 ${describeReward(quest.reward)}`,
        at: now,
      });
    }

    commit(draft, input.requestId, 'propose_quest', fingerprint, questId);
    return { ok: true, world: draft, quest, replay: false, applied };
  } catch (err) {
    return toRejection(world, err, null);
  }
}

/* ============================== 接取委托 ============================== */

export function acceptQuest(world: World, input: QuestRefInput): Adjudication {
  try {
    requireRequestId(input.requestId);
    const fingerprint = { questId: input.questId };
    const { replay, draft } = begin(world, input.requestId, 'accept_quest', fingerprint);
    if (replay) return replay;
    const now = input.now ?? Date.now();

    const quest = mustGetQuest(draft, input.questId);
    if (quest.status !== 'offered') {
      throw new QuestError('quest_not_offered', `任务当前是「${quest.status}」，不能接取`);
    }
    const npc = getNpc(draft, quest.requesterId);
    const from = quest.status;
    quest.status = 'accepted';
    quest.acceptedAt = now;
    quest.history.push({ at: now, from, to: 'accepted', note: '玩家接取' });
    draftPushEvent(draft, {
      type: 'quest_accepted',
      questId: quest.id,
      npcId: quest.requesterId,
      detail: `接取委托：${describeObjective(quest.objective)}`,
      at: now,
    });
    commit(draft, input.requestId, 'accept_quest', fingerprint, quest.id);
    return {
      ok: true,
      world: draft,
      quest,
      replay: false,
      applied: [`接取委托 ${quest.id}：${npc?.name ?? quest.requesterId} 的「${quest.title}」`],
    };
  } catch (err) {
    return toRejection(world, err, getQuest(world, input.questId));
  }
}

/* ============================== 婉拒 / 撤销 / 过期 ============================== */

export function declineQuest(world: World, input: CloseQuestInput): Adjudication {
  try {
    requireRequestId(input.requestId);
    const fingerprint = { questId: input.questId, reason: input.reason ?? null };
    const { replay, draft } = begin(world, input.requestId, 'decline_quest', fingerprint);
    if (replay) return replay;
    const now = input.now ?? Date.now();

    const quest = mustGetQuest(draft, input.questId);
    if (quest.status !== 'offered') {
      throw new QuestError('quest_not_offered', `只有「已发布」的委托能婉拒，当前是「${quest.status}」`);
    }
    const applied = closeQuest(draft, quest, {
      status: 'declined',
      reason: input.reason?.trim() || '玩家婉拒',
      closeReason: 'declined_by_player',
      at: now,
      eventType: 'quest_declined',
    });
    commit(draft, input.requestId, 'decline_quest', fingerprint, quest.id);
    return { ok: true, world: draft, quest, replay: false, applied };
  } catch (err) {
    return toRejection(world, err, getQuest(world, input.questId));
  }
}

export function cancelQuest(world: World, input: CloseQuestInput): Adjudication {
  try {
    requireRequestId(input.requestId);
    const fingerprint = { questId: input.questId, reason: input.reason ?? null };
    const { replay, draft } = begin(world, input.requestId, 'cancel_quest', fingerprint);
    if (replay) return replay;
    const now = input.now ?? Date.now();

    const quest = mustGetQuest(draft, input.questId);
    if (quest.status !== 'offered' && quest.status !== 'accepted') {
      throw new QuestError('quest_not_submittable', `任务已经结束（${quest.status}），无法撤销`);
    }
    const applied = closeQuest(draft, quest, {
      status: 'cancelled',
      reason: input.reason?.trim() || 'NPC 撤销了委托',
      closeReason: 'cancelled_by_npc',
      at: now,
      eventType: 'quest_cancelled',
    });
    commit(draft, input.requestId, 'cancel_quest', fingerprint, quest.id);
    return { ok: true, world: draft, quest, replay: false, applied };
  } catch (err) {
    return toRejection(world, err, getQuest(world, input.questId));
  }
}

export function expireQuest(world: World, input: CloseQuestInput): Adjudication {
  try {
    requireRequestId(input.requestId);
    const fingerprint = { questId: input.questId, reason: input.reason ?? null };
    const { replay, draft } = begin(world, input.requestId, 'expire_quest', fingerprint);
    if (replay) return replay;
    const now = input.now ?? Date.now();

    const quest = mustGetQuest(draft, input.questId);
    if (quest.status !== 'offered' && quest.status !== 'accepted') {
      throw new QuestError('quest_not_submittable', `任务已经结束（${quest.status}），无法置为过期`);
    }
    const applied = closeQuest(draft, quest, {
      status: 'expired',
      reason: input.reason?.trim() || '时机已过',
      closeReason: 'expired',
      at: now,
      eventType: 'quest_cancelled',
    });
    commit(draft, input.requestId, 'expire_quest', fingerprint, quest.id);
    return { ok: true, world: draft, quest, replay: false, applied };
  } catch (err) {
    return toRejection(world, err, getQuest(world, input.questId));
  }
}

/* ============================== 提交与结算 ============================== */

/**
 * 提交委托：交付型目标在这里扣道具，然后结算奖励。
 * 顺序刻意固定为「先落库扣道具 → 再发奖励」，这样即使后续引入赖账（unbound 承诺），
 * 也有据可查（§3.4 硬要求）。
 */
export function submitQuest(world: World, input: SubmitQuestInput): Adjudication {
  try {
    requireRequestId(input.requestId);
    const fingerprint = { questId: input.questId, deliver: input.deliver ?? null };
    const { replay, draft } = begin(world, input.requestId, 'submit_quest', fingerprint);
    if (replay) return replay;
    const now = input.now ?? Date.now();

    const quest = mustGetQuest(draft, input.questId);
    if (quest.status === 'settled') {
      throw new QuestError('quest_not_submittable', '这个委托已经结算过了');
    }
    if (quest.status !== 'accepted') {
      throw new QuestError(
        'quest_not_accepted',
        `只有已接取的委托能提交，当前是「${quest.status}」`,
      );
    }
    const npc = getNpc(draft, quest.requesterId);
    if (!npc) throw new QuestError('unknown_npc', `委托所指的 NPC 不存在：${quest.requesterId}`);

    const applied: string[] = [];
    const objective = quest.objective;

    if (objective.kind === 'deliver_item') {
      if (!input.deliver) {
        throw new QuestError('deliver_required', '这个委托需要提交道具，请求里没有带');
      }
      if (input.deliver.itemId !== objective.itemId) {
        throw new QuestError(
          'deliver_mismatch',
          `委托要的是「${itemName(objective.itemId)}」，提交的却是「${itemName(input.deliver.itemId)}」`,
        );
      }
      if (!Number.isInteger(input.deliver.count) || input.deliver.count < objective.count) {
        throw new QuestError(
          'deliver_count_too_low',
          `委托要 ${objective.count} 份，只提交了 ${input.deliver.count} 份`,
        );
      }
      const need = objective.count;
      const have = availableOf(draft.player.inventory, objective.itemId);
      if (have < need) {
        throw new QuestError(
          'player_item_insufficient',
          `玩家只有 ${have} 份「${itemName(objective.itemId)}」，需要 ${need} 份`,
        );
      }
      // 先落库：这一步道具真的被扣掉了
      draft.player.inventory = removeAvailable(draft.player.inventory, objective.itemId, need);
      npc.inventory = addItems(npc.inventory, [{ itemId: objective.itemId, count: need }]);
      quest.delivered.push({ itemId: objective.itemId, count: need });
      applied.push(`交付：「${itemName(objective.itemId)}」×${need} 由玩家转移给 ${npc.name}`);
      draftPushEvent(draft, {
        type: 'items_delivered',
        questId: quest.id,
        npcId: npc.id,
        detail: `收到「${itemName(objective.itemId)}」×${need}`,
        at: now,
      });
    } else {
      if (input.deliver) {
        throw new QuestError('deliver_forbidden', '这个委托不需要提交道具，请求里不该带');
      }
      if (!objectiveSatisfied(draft, quest)) {
        throw new QuestError('objective_not_met', `目标尚未达成：${describeObjective(objective)}`);
      }
      applied.push(`校验目标：${describeObjective(objective)} —— 已达成`);
    }

    /* -------- 发放奖励（在这里，代码说了算） -------- */
    switch (quest.reward.kind) {
      case 'item': {
        const reservation = quest.rewardReservation;
        if (!reservation) {
          throw new QuestError('invalid_reward', '道具奖励缺少预留锁，拒绝发放');
        }
        npc.inventory = consumeHold(npc.inventory, reservation.id);
        draft.player.inventory = addItems(draft.player.inventory, [
          { itemId: reservation.itemId, count: reservation.count },
        ]);
        quest.rewardReservation = null;
        applied.push(`发放奖励：${describeReward(quest.reward)}（预留锁核销）`);
        break;
      }
      case 'affinity': {
        const next = (draft.player.affinity[npc.id] ?? 0) + quest.reward.amount;
        draft.player.affinity[npc.id] = next;
        bumpStagePeak(draft.player, npc.id);
        applied.push(`发放奖励：好感度 +${quest.reward.amount}（${npc.name} 处累计 ${next}）`);
        break;
      }
      case 'ability': {
        if (!draft.player.abilities.includes(quest.reward.abilityId)) {
          draft.player.abilities.push(quest.reward.abilityId);
        }
        applied.push(`发放奖励：解锁功能「${ABILITY_LABEL[quest.reward.abilityId]}」`);
        break;
      }
      case 'info': {
        draft.player.knowledge.push(quest.reward.topic);
        applied.push(`发放奖励：情报「${quest.reward.topic}」`);
        break;
      }
      case 'none': {
        const next = (draft.player.affinity[npc.id] ?? 0) + FORGO_AFFINITY_BONUS;
        draft.player.affinity[npc.id] = next;
        bumpStagePeak(draft.player, npc.id);
        applied.push(`玩家不要奖励，好感度 +${FORGO_AFFINITY_BONUS}（累计 ${next}）`);
        break;
      }
      default:
        break;
    }
    draftPushEvent(draft, {
      type: 'reward_granted',
      questId: quest.id,
      npcId: npc.id,
      detail: describeReward(quest.reward),
      at: now,
    });

    const from = quest.status;
    quest.status = 'settled';
    quest.settledAt = now;
    quest.closedAt = now;
    quest.history.push({ at: now, from, to: 'settled', note: '交付并结算' });
    draftPushEvent(draft, {
      type: 'quest_settled',
      questId: quest.id,
      npcId: npc.id,
      detail: `委托了结：${quest.title}`,
      at: now,
    });
    applied.push(`委托 ${quest.id} 结算完成`);

    commit(draft, input.requestId, 'submit_quest', fingerprint, quest.id);
    return { ok: true, world: draft, quest, replay: false, applied };
  } catch (err) {
    return toRejection(world, err, getQuest(world, input.questId));
  }
}

/* ============================ 印象（好感度的涨法） ============================ */

export interface NoteImpressionInput {
  requestId: string;
  npcId: string;
  impression: ImpressionKind;
  reason?: string;
  now?: number;
}

/**
 * 记一次印象：模型判断「这一轮说到心坎里 / 冒犯了她」。
 *
 * 计分：pleased +2 / neutral 0 / offended -1（温和，见 IMPRESSION_DELTA）。
 * 冷却：同一 NPC 每 {@link IMPRESSION_COOLDOWN_ROUNDS} 轮最多因印象**涨**一次
 *       （用 `player.talks` 的轮数计数）；**offended 不受冷却限制** —— 说错话立刻有代价。
 * 下限：好感度 clamp 到 >= 0，不允许为负。
 *
 * 这是**新增**的操作，不改变已有五个操作的语义。
 */
export function noteImpression(world: World, input: NoteImpressionInput): Adjudication {
  try {
    requireRequestId(input.requestId);
    const fingerprint = {
      npcId: input.npcId,
      impression: input.impression,
      reason: input.reason ?? null,
    };
    const { replay, draft } = begin(world, input.requestId, 'note_impression', fingerprint);
    if (replay) return replay;
    const now = input.now ?? Date.now();

    const npc = getNpc(draft, input.npcId);
    if (!npc) throw new QuestError('unknown_npc', `没有这个 NPC：${input.npcId}`);
    if (!IMPRESSION_KINDS.includes(input.impression)) {
      throw new QuestError('invalid_impression', ERROR_MESSAGE.invalid_impression);
    }

    const delta = IMPRESSION_DELTA[input.impression];
    const rounds = draft.player.talks[npc.id] ?? 0;
    const lastGainAt = draft.player.impressionGainAt[npc.id];

    // 只有"涨"才受冷却约束；冒犯随时生效
    if (delta > 0) {
      if (typeof lastGainAt === 'number' && rounds - lastGainAt < IMPRESSION_COOLDOWN_ROUNDS) {
        throw new QuestError(
          'impression_cooldown',
          `同一套恭维说太密了（上次第 ${lastGainAt} 轮、现在第 ${rounds} 轮），这次不再加分`,
        );
      }
      draft.player.impressionGainAt[npc.id] = rounds;
    }

    const before = draft.player.affinity[npc.id] ?? 0;
    const after = Math.max(0, before + delta);
    draft.player.affinity[npc.id] = after;
    bumpStagePeak(draft.player, npc.id);

    const reasonText = input.reason?.trim();
    const applied = [
      `${npc.name} 的印象：${IMPRESSION_LABEL[input.impression]}（好感度 ${before} → ${after}）`,
      ...(reasonText ? [`缘由：${reasonText}`] : []),
    ];
    draftPushEvent(draft, {
      type: 'impression_noted',
      questId: null, // 印象不属于任何委托
      npcId: npc.id,
      detail: `${IMPRESSION_LABEL[input.impression]}${reasonText ? `：${reasonText}` : ''}（好感度 ${before} → ${after}）`,
      at: now,
    });
    commit(draft, input.requestId, 'note_impression', fingerprint, null);
    return { ok: true, world: draft, quest: null, replay: false, applied };
  } catch (err) {
    return toRejection(world, err, null);
  }
}

/* ============================ 赠送（不从属于任何委托） ============================ */

export interface GiftItemInput {
  requestId: string;
  /** 收礼的 NPC */
  npcId: string;
  itemId: string;
  count: number;
  now?: number;
}

/**
 * 赠送：玩家把道具**白送**给 NPC，与委托无关（FR-028）。
 *
 * 语义上它只是「一次转移」，所以只有两类硬判定：
 *   1. **守恒**：道具从玩家背包挪到 NPC 背包，总量不变（`worldTotalOf` 前后相等）；
 *   2. **够不够**：玩家可用量不足就拒绝。
 *
 * **NPC 不得以「不喜欢 / 用不上」为由拒收** —— 收礼不破坏任何守恒，
 * 主观估值按 ADR-016 / NFR-013 只进叙事，绝不做驳回依据。
 * 这也是它跟 `submitQuest` 的根本差别：赠送**不产生委托**、**不改委托状态**。
 */
export function giftItem(world: World, input: GiftItemInput): Adjudication {
  try {
    requireRequestId(input.requestId);
    if (!Number.isInteger(input.count) || input.count < 1) {
      throw new QuestError('invalid_gift_count', ERROR_MESSAGE.invalid_gift_count);
    }
    const itemId = typeof input.itemId === 'string' ? input.itemId.trim() : '';
    if (!itemId) throw new QuestError('invalid_field', 'itemId 不能为空');
    if (!isKnownItem(itemId)) throw new QuestError('unknown_item', ERROR_MESSAGE.unknown_item);

    const fingerprint = { npcId: input.npcId, itemId, count: input.count };
    const { replay, draft } = begin(world, input.requestId, 'gift_item', fingerprint);
    if (replay) return replay;
    const now = input.now ?? Date.now();

    const npc = getNpc(draft, input.npcId);
    if (!npc) throw new QuestError('unknown_npc', `没有这个 NPC：${input.npcId}`);

    const have = availableOf(draft.player.inventory, itemId);
    if (have < input.count) {
      throw new QuestError(
        'player_item_insufficient',
        `你身上只有 ${have} 份「${itemName(itemId)}」，送不出 ${input.count} 份`,
      );
    }

    const name = itemName(itemId);
    draft.player.inventory = removeAvailable(draft.player.inventory, itemId, input.count);
    npc.inventory = addItems(npc.inventory, [{ itemId, count: input.count }]);

    const applied = [`赠礼：「${name}」×${input.count} 由玩家转交给 ${npc.name}`];
    draftPushEvent(draft, {
      type: 'item_gifted',
      questId: null, // 赠送不属于任何委托
      npcId: npc.id,
      detail: `收下「${name}」×${input.count}`,
      at: now,
    });
    commit(draft, input.requestId, 'gift_item', fingerprint, null);
    return { ok: true, world: draft, quest: null, replay: false, applied };
  } catch (err) {
    return toRejection(world, err, null);
  }
}

/* ============================ 行囊补齐（初始化便利，非守恒） ============================ */

/** 补齐的目标数量：每件道具补到这个数（不够才补，已超过的不动） */
export const RESTOCK_TARGET = 64;

export interface RestockInput {
  requestId: string;
  /** 每件补到多少，默认 {@link RESTOCK_TARGET} */
  target?: number;
  now?: number;
}

/**
 * 行囊补齐：把玩家背包里**每一种**道具补到目标数量（默认每件 64）。
 *
 * 注意它的性质：这是**世界初始化/补给**，不是「玩家 ↔ NPC 之间转移」，
 * 所以它**故意违反守恒**（`addItems` 凭空生成）。因此：
 *   - 单独成一个显式操作，不混进交付/赠送那条守恒路径；
 *   - 幂等照旧（同一个 `requestId` 只补一次）；已经够数就什么也不做（重复点击无副作用）；
 *   - 只在玩家背包上生效，不动 NPC 背包。
 */
export function restockPlayerInventory(world: World, input: RestockInput): Adjudication {
  try {
    requireRequestId(input.requestId);
    const target = input.target ?? RESTOCK_TARGET;
    if (!Number.isInteger(target) || target < 1) {
      throw new QuestError('invalid_field', '补齐目标数量必须是 ≥ 1 的整数');
    }
    const fingerprint = { target };
    const { replay, draft } = begin(world, input.requestId, 'restock_player', fingerprint);
    if (replay) return replay;
    const now = input.now ?? Date.now();

    const additions: ItemStack[] = [];
    for (const def of ITEM_LIST) {
      const have = availableOf(draft.player.inventory, def.id);
      if (have >= target) continue;
      additions.push({ itemId: def.id, count: target - have });
    }
    if (additions.length === 0) {
      return {
        ok: true,
        world,
        quest: null,
        replay: false,
        applied: [`无需补齐：每件道具都已经不少于 ${target} 件`],
      };
    }

    draft.player.inventory = addItems(draft.player.inventory, additions);
    const detail = `行囊补齐：${additions.length} 种道具补到每件 ${target} 件`;
    const applied = [detail];
    draftPushEvent(draft, {
      type: 'items_restocked',
      questId: null, // 不是委托
      npcId: draft.player.id,
      detail,
      at: now,
    });
    commit(draft, input.requestId, 'restock_player', fingerprint, null);
    return { ok: true, world: draft, quest: null, replay: false, applied };
  } catch (err) {
    return toRejection(world, err, null);
  }
}
