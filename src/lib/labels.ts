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

export function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
