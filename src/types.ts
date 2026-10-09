/**
 * 全项目共享类型（ADR-005：状态层是唯一可变更数据的地方）。
 */

export type Role = 'system' | 'user' | 'assistant';

export type MessageStatus = 'streaming' | 'done' | 'aborted' | 'error';

export interface ChatMessage {
  id: string;
  role: Role;
  content: string;
  /** 思维链增量（部分模型返回 reasoning_content），折叠展示 */
  reasoning?: string;
  createdAt: number;
  status?: MessageStatus;
  errorText?: string;
  /** 本轮回复产出的候选/任务 id，用于「查看原话」反查（AC-14.2） */
  producedTaskIds?: string[];
}

export type TaskCategory = 'feature' | 'bug' | 'content' | 'question' | 'other';
export type TaskPriority = 'P0' | 'P1' | 'P2';
export type TaskStatus = 'pending' | 'active' | 'done' | 'dropped';
/** llm = 模型抽取/工具调用；rule = 本地规则引擎 */
export type Origin = 'llm' | 'rule';

/** 从模型或规则引擎拿到的原始任务数据 */
export interface RawTaskPayload {
  title: string;
  detail: string;
  category: TaskCategory;
  priority: TaskPriority;
  acceptance: string[];
  confidence: number;
}

/** 尚未被用户采纳的任务候选 */
export interface TaskCandidate extends RawTaskPayload {
  id: string;
  origin: Origin;
  /** 原话片段，用于「查看原话」 */
  evidence: string;
  sourceMessageId: string | null;
  /** 规则引擎命中的理由，或 LLM 通道标识 */
  triggerReasons: string[];
  createdAt: number;
}

export interface Task extends RawTaskPayload {
  id: string;
  status: TaskStatus;
  origin: Origin;
  evidence: string;
  sourceMessageId: string | null;
  triggerReasons: string[];
  createdAt: number;
  updatedAt: number;
}

export type ExtractMode = 'auto' | 'llm' | 'rule' | 'off';

export interface Settings {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  systemPrompt: string;
  stream: boolean;
  enableTools: boolean;
  extractMode: ExtractMode;
  autoAccept: boolean;
  historyLimit: number;
  dedupeThreshold: number;
  showReasoning: boolean;
}

export interface HealthInfo {
  ok: boolean;
  name: string;
  version: string;
  defaults: {
    baseUrl: string;
    model: string;
    hasKey: boolean;
  };
}

/** 一次抽取/工具调用的审计记录（FR-014） */
export interface AuditEntry {
  id: string;
  at: number;
  messageId: string | null;
  /** 规则引擎是否命中 */
  triggered: boolean;
  reasons: string[];
  /** 最终走通的通道 */
  channel: 'tool' | 'llm' | 'rule' | 'none';
  produced: number;
  dropped: number;
  durationMs: number;
  note?: string;
}

/** 服务端 SSE 事件（契约 §2.1） */
export type ServerEvent =
  | { type: 'delta'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; index: number; id?: string; task: RawTaskPayload }
  | { type: 'notice'; code: string; message: string }
  | { type: 'usage'; usage: Record<string, unknown> }
  | { type: 'done' }
  | { type: 'error'; code: string; message: string };
