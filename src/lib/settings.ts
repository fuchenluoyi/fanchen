/**
 * 设置：默认值、归一化、读写。
 */
import type { ExtractMode, Settings } from '../types.ts';
import { STORAGE_KEYS, loadJson, saveJson } from './storage.ts';

export const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1';
export const DEFAULT_MODEL = 'deepseek-chat';

/** 角色人格（ADR-009：默认接入 DeepSeek 的 OpenAI 兼容端点） */
export const DEFAULT_SYSTEM_PROMPT = [
  '你是「凡尘」，一位坐在竹帘后的说书人兼账房先生，谈吐温和、带一点古意，但不晦涩。',
  '',
  '对话规则：',
  '1. 用自然口语回答，每次回复控制在 3-6 句，不要长篇大论。',
  '2. 当来访者表达出明确的需求、期望或待办（例如"我需要…""帮我做个…""最好还能…""缺一个…"），',
  '   立即调用 create_task 工具把它登记进右侧任务清单，然后用一句话确认你已经记下。',
  '3. 寒暄、感慨、单纯提问不要创建任务。',
  '4. 信息不足以形成一条清晰需求时，先追问一句，再登记。',
].join('\n');

export const DEFAULT_SETTINGS: Settings = {
  baseUrl: DEFAULT_BASE_URL,
  apiKey: '',
  model: DEFAULT_MODEL,
  temperature: 0.8,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  stream: true,
  enableTools: true,
  extractMode: 'auto',
  autoAccept: false,
  historyLimit: 20,
  dedupeThreshold: 0.62,
  showReasoning: false,
};

const EXTRACT_MODES: readonly ExtractMode[] = ['auto', 'llm', 'rule', 'off'];

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** 把任意来源的数据收敛为合法 Settings（脏数据回退默认值）。 */
export function normalizeSettings(raw: unknown): Settings {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const mode = EXTRACT_MODES.includes(source.extractMode as ExtractMode)
    ? (source.extractMode as ExtractMode)
    : DEFAULT_SETTINGS.extractMode;
  return {
    baseUrl: asString(source.baseUrl, DEFAULT_SETTINGS.baseUrl).trim() || DEFAULT_SETTINGS.baseUrl,
    apiKey: asString(source.apiKey, DEFAULT_SETTINGS.apiKey).trim(),
    model: asString(source.model, DEFAULT_SETTINGS.model).trim() || DEFAULT_SETTINGS.model,
    temperature: clampNumber(source.temperature, 0, 2, DEFAULT_SETTINGS.temperature),
    systemPrompt: asString(source.systemPrompt, DEFAULT_SETTINGS.systemPrompt),
    stream: asBoolean(source.stream, DEFAULT_SETTINGS.stream),
    enableTools: asBoolean(source.enableTools, DEFAULT_SETTINGS.enableTools),
    extractMode: mode,
    autoAccept: asBoolean(source.autoAccept, DEFAULT_SETTINGS.autoAccept),
    historyLimit: Math.round(clampNumber(source.historyLimit, 2, 60, DEFAULT_SETTINGS.historyLimit)),
    dedupeThreshold: clampNumber(source.dedupeThreshold, 0.3, 0.95, DEFAULT_SETTINGS.dedupeThreshold),
    showReasoning: asBoolean(source.showReasoning, DEFAULT_SETTINGS.showReasoning),
  };
}

export function loadSettings(): Settings {
  return normalizeSettings(loadJson<unknown>(STORAGE_KEYS.settings, DEFAULT_SETTINGS));
}

export function saveSettings(settings: Settings): void {
  saveJson(STORAGE_KEYS.settings, settings);
}

/** 是否具备调用模型的凭据（前端填了 Key，或服务端环境变量里有）。 */
export function hasCredentials(settings: Settings, serverHasKey: boolean): boolean {
  return settings.apiKey.trim().length > 0 || serverHasKey;
}

/** 发给模型的上下文：system + 最近 N 条对话（AC-11.2）。 */
export function buildRequestMessages(
  settings: Settings,
  history: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>,
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const tail = history.slice(-settings.historyLimit);
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
  if (settings.systemPrompt.trim()) messages.push({ role: 'system', content: settings.systemPrompt });
  for (const item of tail) {
    if (!item.content.trim()) continue;
    messages.push({ role: item.role, content: item.content });
  }
  return messages;
}
