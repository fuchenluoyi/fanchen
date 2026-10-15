/**
 * 「事件 → 裁决」的接线（纯函数，可单测，不需要 DOM）。
 *
 * 服务端只把模型的话收敛成**提案**；这里把提案喂给领域层裁决层，
 * 再把结果整理成一条**裁决事实**（QuestRuling）：
 *   - 成功的裁决 → 新世界（UI 立刻可见）
 *   - 失败的裁决 → 拒绝码 + 原因，作为事实回注给模型（AC-21.5），
 *     否则 NPC 会继续演"我已经收到了"
 *
 * 本模块不碰网络、不碰 localStorage、不碰 React。
 */
import { acceptQuest, declineQuest, noteImpression, proposeQuest, submitQuest } from './adjudicate.ts';
import type { ProposeQuestInput } from './adjudicate.ts';
import type { Adjudication, ImpressionKind, ItemStack, World } from './types.ts';

/**
 * 模型提案的载荷：形状与领域层入参一致，但**不含 npcId** ——
 * 「这次由谁出面」必须由客户端（界面设置）决定，不听模型的
 * （否则模型可以替别的 NPC 发委托）。幂等键 / 时间 / 溯源同样由调用方补。
 */
export type QuestProposalDraft = Omit<
  ProposeQuestInput,
  'requestId' | 'now' | 'draftedBy' | 'sourceDialogueId' | 'npcId'
>;

/** 服务端委托事件在领域侧的对应物（契约 §2.3） */
export type QuestChannelEvent =
  | { type: 'quest_proposal'; proposal: QuestProposalDraft }
  | { type: 'quest_submit'; submission: { questId: string; deliver?: ItemStack } }
  | { type: 'quest_decline'; decline: { questId: string; reason?: string } };

export type QuestRulingAction =
  | 'propose_quest'
  | 'submit_quest'
  | 'decline_quest'
  | 'accept_quest'
  | 'note_impression';

/** 一条裁决事实：界面展示它，提示词回注它 */
export interface QuestRuling {
  ok: boolean;
  action: QuestRulingAction;
  questId: string | null;
  /** 拒绝码（成功为 null），见 constants.ERROR_MESSAGE */
  code: string | null;
  /** 面向人的说明：成功时是摘要，失败时是拒绝原因 */
  message: string;
  /** 成功时实际发生的事务步骤（可直接显示） */
  applied: string[];
  at: number;
}

export interface QuestTurnContext {
  /** 幂等键：每次裁决都要一个新的（用 createId('req') 生成） */
  requestId: string;
  now: number;
}

/** 处理模型提案时的上下文：多一个"谁在出面" */
export interface QuestEventContext extends QuestTurnContext {
  /** 由客户端（设置里的 questNpcId）注入，模型无法指定 */
  npcId: string;
  /** 来源对话（消息 id），会写进 Quest.provenance */
  dialogueId: string | null;
}

export interface QuestTurnOutcome {
  world: World;
  ruling: QuestRuling;
}

function toRuling(
  action: QuestRulingAction,
  result: Adjudication,
  at: number,
  fallbackQuestId: string | null,
): QuestRuling {
  if (result.ok) {
    return {
      ok: true,
      action,
      questId: result.quest?.id ?? fallbackQuestId,
      code: null,
      message: result.applied[0] ?? '裁决通过',
      applied: [...result.applied],
      at,
    };
  }
  return {
    ok: false,
    action,
    questId: result.quest?.id ?? fallbackQuestId,
    code: result.code,
    message: result.message,
    applied: [],
    at,
  };
}

/** 把一个服务端委托事件接到裁决层上 */
export function applyQuestEvent(
  world: World,
  event: QuestChannelEvent,
  ctx: QuestEventContext,
): QuestTurnOutcome {
  switch (event.type) {
    case 'quest_proposal': {
      const result = proposeQuest(world, {
        ...event.proposal,
        npcId: ctx.npcId,
        requestId: ctx.requestId,
        sourceDialogueId: ctx.dialogueId,
        draftedBy: 'dialogue',
        now: ctx.now,
      });
      return { world: result.world, ruling: toRuling('propose_quest', result, ctx.now, null) };
    }
    case 'quest_submit': {
      const result = submitQuest(world, {
        requestId: ctx.requestId,
        questId: event.submission.questId,
        ...(event.submission.deliver ? { deliver: event.submission.deliver } : {}),
        now: ctx.now,
      });
      return {
        world: result.world,
        ruling: toRuling('submit_quest', result, ctx.now, event.submission.questId),
      };
    }
    case 'quest_decline': {
      const result = declineQuest(world, {
        requestId: ctx.requestId,
        questId: event.decline.questId,
        ...(event.decline.reason ? { reason: event.decline.reason } : {}),
        now: ctx.now,
      });
      return { world: result.world, ruling: toRuling('decline_quest', result, ctx.now, event.decline.questId) };
    }
    default:
      throw new Error('未知的委托事件');
  }
}

/** 玩家在界面上点【接取】：同样走裁决层，返回新世界与裁决事实 */
export function applyPlayerAccept(
  world: World,
  ctx: QuestTurnContext & { questId: string },
): QuestTurnOutcome {
  const result = acceptQuest(world, { requestId: ctx.requestId, questId: ctx.questId, now: ctx.now });
  return { world: result.world, ruling: toRuling('accept_quest', result, ctx.now, ctx.questId) };
}

/** 玩家在界面上点【婉拒】 */
export function applyPlayerDecline(
  world: World,
  ctx: QuestTurnContext & { questId: string; reason?: string },
): QuestTurnOutcome {
  const result = declineQuest(world, {
    requestId: ctx.requestId,
    questId: ctx.questId,
    ...(ctx.reason ? { reason: ctx.reason } : {}),
    now: ctx.now,
  });
  return { world: result.world, ruling: toRuling('decline_quest', result, ctx.now, ctx.questId) };
}

/**
 * 玩家在界面上点【交付 / 请对方验看】：同样走裁决层提交。
 * 交付型目标要带 deliver；非交付型（has_item / talk_count / affinity_at_least）不要带 ——
 * 带了会被裁决层以 deliver_forbidden 拒绝。
 *
 * 界面**不替裁决层做判断**：玩家手上不够也允许点，拒绝就走裁决并作为事实回注。
 */
export function applyPlayerSubmit(
  world: World,
  ctx: QuestTurnContext & { questId: string; deliver?: ItemStack },
): QuestTurnOutcome {
  const result = submitQuest(world, {
    requestId: ctx.requestId,
    questId: ctx.questId,
    ...(ctx.deliver ? { deliver: ctx.deliver } : {}),
    now: ctx.now,
  });
  return { world: result.world, ruling: toRuling('submit_quest', result, ctx.now, ctx.questId) };
}

/**
 * 记一次印象（好感度的涨法）：模型判断「这一轮说到心坎里 / 冒犯了她」。
 * 计分、冷却、下限都在裁决层；这里只做接线。
 */
export function applyQuestImpression(
  world: World,
  ctx: QuestTurnContext & { npcId: string; impression: ImpressionKind; reason?: string },
): QuestTurnOutcome {
  const result = noteImpression(world, {
    requestId: ctx.requestId,
    npcId: ctx.npcId,
    impression: ctx.impression,
    ...(ctx.reason ? { reason: ctx.reason } : {}),
    now: ctx.now,
  });
  return { world: result.world, ruling: toRuling('note_impression', result, ctx.now, null) };
}
