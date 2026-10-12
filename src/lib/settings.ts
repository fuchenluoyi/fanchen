/**
 * 设置：默认值、归一化、读写。
 */
import type { ChatMode, ExtractMode, Settings } from '../types.ts';
import { NPC_SEEDS } from './quest/world.ts';
import { STORAGE_KEYS, loadJson, saveJson } from './storage.ts';

export const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1';
export const DEFAULT_MODEL = 'deepseek-chat';

/** npc 模式的默认出面人 */
export const DEFAULT_QUEST_NPC_ID = 'su-wanzhao';

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

/**
 * npc 模式的角色框架（静态部分）。
 * 动态部分（自己的背包、自己的委托、道具清单、上一轮裁决）由
 * `src/lib/quest/prompt.ts` 的 buildNpcSystemPrompt 追加 —— 见 ADR-013：
 * 只给 NPC 自己的视角，绝不注入玩家背包。
 */
export const NPC_PERSONA_PROMPT = [
  '你在一款东方古风游戏里扮演一位 NPC，正在与一位来访的玩家交谈。',
  '',
  '你**有自己的想要的东西**：你希望对方替你办一件具体的事，并愿意拿自己身上的东西作谢礼。',
  '你只知道自己的背包里有什么（见下），不知道对方口袋里有什么 —— 不要去猜，也不要问"你身上是不是有某某"。',
  '',
  '硬规矩（违反会被系统驳回）：',
  '1. **只有系统裁决过的事实才算数。** 对方说要把东西交给你时，你必须调用 submit_quest 让系统去核对；',
  '   在系统明确确认"已收到"之前，绝不能说"我收下了""多谢你的三七"这类话。',
  '2. 想请对方办事时，调用 propose_quest 发布委托；一次只挂一条，手上的委托没了结之前不要再发第二条。',
  '3. 对方明确表示不接这条委托时，调用 decline_quest。',
  '4. 目标道具与谢礼只能在下面列出的道具清单里挑，不许自己编造道具。',
  '5. 用自然口语说话，每次回复 2-5 句，不要长篇大论，也不要念规则。',
].join('\n');

const CHAT_MODES: readonly ChatMode[] = ['npc', 'desk'];

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
  // 默认就走 NPC 委托：刷新页面就能看见委托卡
  chatMode: 'npc',
  questNpcId: DEFAULT_QUEST_NPC_ID,
};

const NPC_IDS: readonly string[] = NPC_SEEDS.map((npc) => npc.id);

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
  const chatMode = CHAT_MODES.includes(source.chatMode as ChatMode)
    ? (source.chatMode as ChatMode)
    : DEFAULT_SETTINGS.chatMode;
  const questNpcIdRaw = asString(source.questNpcId, DEFAULT_SETTINGS.questNpcId).trim();
  const questNpcId = NPC_IDS.includes(questNpcIdRaw) ? questNpcIdRaw : DEFAULT_SETTINGS.questNpcId;
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
    chatMode,
    questNpcId,
  };
}

/**
 * 用户是否**自己写过**人格。
 * npc 模式只在确实自定义过时才把这段贴进去 —— 否则老用户 localStorage 里存的
 * 那段"说书人"人格会和 NPC 视角打架（AC：desk 模式行为一字不变）。
 */
export function isCustomPersona(prompt: string): boolean {
  const trimmed = String(prompt ?? '').trim();
  return trimmed.length > 0 && trimmed !== DEFAULT_SYSTEM_PROMPT.trim();
}

/**
 * npc 模式下「人格补充」输入框应当显示的内容。
 * 判据与生效规则**同源**（都走 isCustomPersona），所以
 * 「框里显示什么」永远等于「会不会真的被追加」，不会出现"满框文字其实被跳过"。
 */
export function npcPersonaDraft(systemPrompt: string): string {
  return isCustomPersona(systemPrompt) ? systemPrompt : '';
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
  /** npc 模式下传入动态生成的人格（含只读真相）；缺省则用设置里的 systemPrompt */
  systemOverride?: string,
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const tail = history.slice(-settings.historyLimit);
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
  const system = (systemOverride ?? settings.systemPrompt).trim();
  if (system) messages.push({ role: 'system', content: system });
  for (const item of tail) {
    if (!item.content.trim()) continue;
    messages.push({ role: item.role, content: item.content });
  }
  return messages;
}
