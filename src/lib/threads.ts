/**
 * 对话线索（thread）：一条线索 = 一段独立的人设与历史。
 *
 *   'desk'      → 需求台（原型里那位说书人）
 *   '<npcId>'   → 与这位 NPC 的对话
 *
 * 为什么必须切线索：`questNpcId` 只影响提示词、裁决上下文与记轮数，而历史是**全量**的。
 * 切到陆行舟后，模型会同时收到「系统说你是陆行舟」+「苏晚照说我旧疾复发需一味三七」——
 * 它会继续演上一个，或者两个人格糊在一起。
 *
 * 纯函数，放在 React 胶水之外，可被 `node --test` 直接加载。
 */
import type { Settings } from '../types.ts';

/** 需求台线索的固定 id：旧存档里没有 npcId 的消息一律归它（避免第一轮串戏） */
export const DESK_THREAD_ID = 'desk';

/** 当前设置对应的线索 id */
export function threadIdFor(settings: Pick<Settings, 'chatMode' | 'questNpcId'>): string {
  return settings.chatMode === 'npc' ? settings.questNpcId : DESK_THREAD_ID;
}

/** 把任意来源的线索值收敛成合法值：非空字符串即用，否则归需求台 */
export function normalizeThreadId(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : DESK_THREAD_ID;
}

/** 只取某条线索的消息（保持原顺序） */
export function messagesOfThread<T extends { npcId?: unknown }>(
  messages: readonly T[],
  threadId: string,
): T[] {
  return messages.filter((message) => normalizeThreadId(message.npcId) === threadId);
}

/** 各线索的消息条数（切换器与提示文案可用） */
export function threadMessageCounts(messages: readonly { npcId?: unknown }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const message of messages) {
    const key = normalizeThreadId(message.npcId);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
