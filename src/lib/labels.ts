import type { ChatMode, Origin, TaskCategory, TaskPriority, TaskStatus } from '../types.ts';
import type { QuestRulingAction } from './quest/bridge.ts';
import type { QuestStatus } from './quest/types.ts';

export const STATUS_LABEL: Record<TaskStatus, string> = {
  pending: '待办',
  active: '进行中',
  done: '完成',
  dropped: '废弃',
};

/** NPC 委托的状态（给界面与提示词共用，避免两处各写一份） */
export const QUEST_STATUS_LABEL: Record<QuestStatus, string> = {
  offered: '已发布',
  accepted: '已接取',
  settled: '已完成',
  declined: '已婉拒',
  cancelled: '已撤销',
  expired: '已过期',
};

export const CHAT_MODE_LABEL: Record<ChatMode, string> = {
  npc: 'NPC 委托',
  desk: '需求台',
};

/** 裁决动作（审计与提示词共用一份文案） */
export const QUEST_ACTION_LABEL: Record<QuestRulingAction, string> = {
  propose_quest: '发布委托',
  submit_quest: '交付结算',
  decline_quest: '婉拒委托',
  accept_quest: '接取委托',
  note_impression: '记印象',
  gift_item: '赠送',
  restock_player: '补齐行囊',
};

export const CATEGORY_LABEL: Record<TaskCategory, string> = {
  feature: '功能',
  bug: '缺陷',
  content: '内容',
  question: '疑问',
  other: '其他',
};

export const PRIORITY_LABEL: Record<TaskPriority, string> = {
  P0: 'P0',
  P1: 'P1',
  P2: 'P2',
};

export const ORIGIN_LABEL: Record<Origin, string> = {
  llm: '模型',
  rule: '规则',
};

export const CHANNEL_LABEL: Record<string, string> = {
  tool: '工具调用',
  llm: '模型抽取',
  rule: '规则引擎',
  none: '未触发',
};

/** 玩家侧的失败抬头：拒绝码 → 一句人话（详细原因由裁决层给出，信息不丢） */
const PLAYER_REJECTION_HEADLINE: Record<string, string> = {
  player_item_insufficient: '你身上没有这件东西（或不够）',
  deliver_mismatch: '要交的不是这件东西',
  deliver_count_too_low: '数量不够',
  deliver_required: '这条委托要交东西才能了结',
  deliver_forbidden: '这条委托不用交东西',
  objective_not_met: '条件还没达成',
  quest_not_accepted: '这条委托不在进行中',
  quest_not_submittable: '这条委托已经了结了',
  quest_not_found: '找不到这条委托',
  unknown_item: '没有这件东西',
  invalid_gift_count: '数量得是正整数',
};

/**
 * 把裁决层的拒绝拼成给**玩家**看的一句话。
 * 玩家在界面上点按钮被拒时用它 —— 拒绝绝不静默，且要说清是哪一条、为什么。
 */
export function playerQuestRejectionText(code: string | null, detail: string): string {
  const headline = PLAYER_REJECTION_HEADLINE[code ?? ''] ?? '没能完成';
  return `${headline}：${detail}`;
}

export function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
