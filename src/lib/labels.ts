import type { Origin, TaskCategory, TaskPriority, TaskStatus } from '../types.ts';

export const STATUS_LABEL: Record<TaskStatus, string> = {
  pending: '待办',
  active: '进行中',
  done: '完成',
  dropped: '废弃',
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
