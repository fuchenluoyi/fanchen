/**
 * 全局状态容器（ADR-005）：Context + useReducer。
 * 架构约束：只有这里可以触网 / 读写 localStorage，组件层保持纯展示。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react';

import type {
  AuditEntry,
  ChatMessage,
  HealthInfo,
  RawTaskPayload,
  ServerEvent,
  Settings,
  Task,
  TaskCandidate,
  TaskStatus,
} from '../types.ts';
import type { QuestChannelEvent, QuestRuling } from '../lib/quest/bridge.ts';
import {
  applyPlayerAccept,
  applyPlayerDecline,
  applyPlayerGift,
  applyPlayerRestock,
  applyPlayerSubmit,
  applyQuestEvent,
  applyQuestImpression,
} from '../lib/quest/bridge.ts';
import { normalizeStoredWorld } from '../lib/quest/persist.ts';
import { buildNpcSystemPrompt } from '../lib/quest/prompt.ts';
import { questLetter } from '../lib/quest/letter.ts';
import { getNpc, getQuest } from '../lib/quest/world.ts';
import type { ItemStack, World } from '../lib/quest/types.ts';
import { QUEST_ACTION_LABEL, playerQuestRejectionText } from '../lib/labels.ts';
import { messagesOfThread, normalizeThreadId, threadIdFor } from '../lib/threads.ts';
import { buildRequestMessages, hasCredentials, loadSettings, normalizeSettings, npcPersonaFor, saveSettings } from '../lib/settings.ts';
import { STORAGE_KEYS, isArrayOfObjects, loadJson, removeKeys, saveJson } from '../lib/storage.ts';
import { createId } from '../lib/id.ts';
import { ApiError, fetchHealth, fetchModels, streamChat } from '../lib/api.ts';
import { candidateFromToolPayload, runExtraction, taskFromCandidate } from '../lib/extract.ts';
import { dedupeCandidates } from '../lib/dedupe.ts';

/* ------------------------------------------------------------------ *
 * 状态与行为
 * ------------------------------------------------------------------ */

interface State {
  settings: Settings;
  messages: ChatMessage[];
  tasks: Task[];
  candidates: TaskCandidate[];
  audits: AuditEntry[];
  /** NPC 委托世界：NPC 背包 / 委托 / 事件流水（npc 模式） */
  world: World;
  /** 上一轮系统裁决：作为**事实**回注给模型（AC-21.5），只活在内存里 */
  lastRuling: QuestRuling | null;
  health: HealthInfo | null;
  healthError: string | null;
  busy: boolean;
  streamingMessageId: string | null;
  highlightMessageId: string | null;
  toast: string | null;
}

type Action =
  | { type: 'settings/set'; payload: Settings }
  | { type: 'health/set'; payload: { health: HealthInfo | null; error: string | null } }
  | { type: 'message/add'; payload: ChatMessage }
  | { type: 'message/append'; payload: { id: string; kind: 'content' | 'reasoning'; text: string } }
  | { type: 'message/finish'; payload: { id: string; status: ChatMessage['status']; errorText?: string } }
  | { type: 'message/clearThread'; payload: string }
  | { type: 'message/highlight'; payload: string | null }
  | { type: 'tasks/addMany'; payload: Task[] }
  | { type: 'tasks/status'; payload: { id: string; status: TaskStatus } }
  | { type: 'tasks/remove'; payload: string }
  | { type: 'tasks/clear' }
  | { type: 'candidates/push'; payload: TaskCandidate[] }
  | { type: 'candidates/remove'; payload: string }
  | { type: 'candidates/clear' }
  | { type: 'audit/push'; payload: AuditEntry }
  | { type: 'world/set'; payload: World }
  | { type: 'ruling/set'; payload: QuestRuling | null }
  | { type: 'busy/set'; payload: boolean }
  | { type: 'streaming/set'; payload: string | null }
  | { type: 'toast/set'; payload: string | null }
  | { type: 'data/reset'; payload: Settings };

const MAX_AUDITS = 40;

function normalizeTask(raw: unknown): Task | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  const title = typeof source.title === 'string' ? source.title.trim() : '';
  if (!title) return null;
  const statuses: TaskStatus[] = ['pending', 'active', 'done', 'dropped'];
  const status = statuses.includes(source.status as TaskStatus) ? (source.status as TaskStatus) : 'pending';
  const createdAt = typeof source.createdAt === 'number' ? source.createdAt : Date.now();
  return {
    id: typeof source.id === 'string' && source.id ? source.id : createId('task'),
    title,
    detail: typeof source.detail === 'string' ? source.detail : title,
    category: (['feature', 'bug', 'content', 'question', 'other'] as const).includes(
      source.category as Task['category'],
    )
      ? (source.category as Task['category'])
      : 'feature',
    priority: (['P0', 'P1', 'P2'] as const).includes(source.priority as Task['priority'])
      ? (source.priority as Task['priority'])
      : 'P1',
    acceptance: Array.isArray(source.acceptance)
      ? source.acceptance.filter((x): x is string => typeof x === 'string')
      : [],
    confidence: typeof source.confidence === 'number' ? source.confidence : 0.7,
    origin: source.origin === 'rule' ? 'rule' : 'llm',
    evidence: typeof source.evidence === 'string' ? source.evidence : '',
    sourceMessageId: typeof source.sourceMessageId === 'string' ? source.sourceMessageId : null,
    triggerReasons: Array.isArray(source.triggerReasons)
      ? source.triggerReasons.filter((x): x is string => typeof x === 'string')
      : [],
    status,
    createdAt,
    updatedAt: typeof source.updatedAt === 'number' ? source.updatedAt : createdAt,
  };
}

/** 把一条裁决事实变成审计记录（拒绝绝不静默） */
function buildQuestAudit(ruling: QuestRuling, messageId: string | null, durationMs: number): AuditEntry {
  return {
    id: createId('audit'),
    at: ruling.at,
    messageId,
    triggered: true,
    reasons: [QUEST_ACTION_LABEL[ruling.action]],
    channel: 'tool',
    produced: ruling.ok ? 1 : 0,
    dropped: ruling.ok ? 0 : 1,
    durationMs,
    note: ruling.ok ? `接受：${ruling.message}` : `拒绝（${ruling.code ?? 'unknown'}）：${ruling.message}`,
  };
}

function createInitialState(): State {
  const settings = loadSettings();
  const messages = loadJson<ChatMessage[]>(STORAGE_KEYS.messages, [], isArrayOfObjects)
    .filter((m) => m && typeof m.content === 'string' && (m.role === 'user' || m.role === 'assistant'))
    .map<ChatMessage>((m) => ({
      ...m,
      // 旧存档没有线索字段 → 一律归需求台（老原型就是需求台）
      npcId: normalizeThreadId(m.npcId),
      // 上次没写完就关页面的消息，标记为已中断
      status: m.status === 'streaming' ? 'aborted' : m.status,
    }));
  const tasks = loadJson<unknown[]>(STORAGE_KEYS.tasks, [], isArrayOfObjects)
    .map(normalizeTask)
    .filter((t): t is Task => t !== null);
  // 世界存档同样走容错归一化：最坏情况回到开局，绝不让脏数据白屏
  const world = normalizeStoredWorld(loadJson<unknown>(STORAGE_KEYS.quest, null));

  return {
    settings,
    messages,
    tasks,
    candidates: [],
    audits: [],
    world,
    lastRuling: null,
    health: null,
    healthError: null,
    busy: false,
    streamingMessageId: null,
    highlightMessageId: null,
    toast: null,
  };
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'settings/set':
      return { ...state, settings: action.payload };
    case 'health/set':
      return { ...state, health: action.payload.health, healthError: action.payload.error };
    case 'message/add':
      return { ...state, messages: [...state.messages, action.payload] };
    case 'message/append':
      return {
        ...state,
        messages: state.messages.map((message) => {
          if (message.id !== action.payload.id) return message;
          if (action.payload.kind === 'reasoning') {
            return { ...message, reasoning: (message.reasoning ?? '') + action.payload.text };
          }
          return { ...message, content: message.content + action.payload.text };
        }),
      };
    case 'message/finish':
      return {
        ...state,
        messages: state.messages.map((message) =>
          message.id === action.payload.id
            ? {
                ...message,
                status: action.payload.status,
                ...(action.payload.errorText ? { errorText: action.payload.errorText } : {}),
              }
            : message,
        ),
      };
    case 'message/clearThread':
      // 只清当前线索：别的 NPC（或需求台）的对话还在
      return {
        ...state,
        messages: state.messages.filter((message) => normalizeThreadId(message.npcId) !== action.payload),
        highlightMessageId: null,
      };
    case 'message/highlight':
      return { ...state, highlightMessageId: action.payload };
    case 'tasks/addMany':
      return { ...state, tasks: [...action.payload, ...state.tasks] };
    case 'tasks/status':
      return {
        ...state,
        tasks: state.tasks.map((task) =>
          task.id === action.payload.id ? { ...task, status: action.payload.status, updatedAt: Date.now() } : task,
        ),
      };
    case 'tasks/remove':
      return { ...state, tasks: state.tasks.filter((task) => task.id !== action.payload) };
    case 'tasks/clear':
      return { ...state, tasks: [], candidates: [] };
    case 'candidates/push':
      return { ...state, candidates: [...state.candidates, ...action.payload] };
    case 'candidates/remove':
      return { ...state, candidates: state.candidates.filter((candidate) => candidate.id !== action.payload) };
    case 'candidates/clear':
      return { ...state, candidates: [] };
    case 'audit/push':
      return { ...state, audits: [action.payload, ...state.audits].slice(0, MAX_AUDITS) };
    case 'world/set':
      return { ...state, world: action.payload };
    case 'ruling/set':
      return { ...state, lastRuling: action.payload };
    case 'busy/set':
      return { ...state, busy: action.payload };
    case 'streaming/set':
      return { ...state, streamingMessageId: action.payload };
    case 'toast/set':
      return { ...state, toast: action.payload };
    case 'data/reset':
      return { ...createInitialState(), settings: action.payload };
    default:
      return state;
  }
}

/* ------------------------------------------------------------------ *
 * Context
 * ------------------------------------------------------------------ */

export interface StoreValue {
  state: State;
  send: (text: string) => Promise<void>;
  stop: () => void;
  updateSettings: (patch: Partial<Settings>) => void;
  acceptCandidate: (id: string) => void;
  dropCandidate: (id: string) => void;
  acceptAllCandidates: () => void;
  /** 玩家点【接取】当前 NPC 的委托（走裁决层，不直接改状态） */
  acceptQuest: (questId: string) => void;
  /** 玩家点【婉拒】：释放该委托预留的谢礼 */
  declineQuest: (questId: string, reason?: string) => void;
  /** 玩家点【交付 / 请对方验看】：走裁决层提交（交付型带 deliver，非交付型不带） */
  deliverQuest: (questId: string, deliver?: ItemStack) => void;
  /** 玩家点【送给他】：白送一件道具给 NPC（与委托无关，同样走裁决层） */
  giftQuest: (npcId: string, itemId: string, count: number) => void;
  /** 玩家点【补齐行囊】：每件道具补到 64（世界补给，非守恒） */
  restockInventory: () => void;
  /** 只重置对话 / 任务 / 委托进度，**保留设置与 API Key** */
  resetConversation: () => void;
  setTaskStatus: (id: string, status: TaskStatus) => void;
  removeTask: (id: string) => void;
  clearMessages: () => void;
  clearTasks: () => void;
  resetAll: () => void;
  refreshHealth: () => Promise<void>;
  testConnection: () => Promise<{ ok: boolean; message: string }>;
  listModels: (draft: { baseUrl: string; apiKey: string }) => Promise<string[]>;
  setToast: (message: string | null) => void;
  highlightMessage: (id: string | null) => void;
  configured: boolean;
}

const StoreContext = createContext<StoreValue | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, createInitialState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const abortRef = useRef<AbortController | null>(null);
  const toastTimer = useRef<number | null>(null);

  /* -------------------- 持久化（防抖，避免流式期间频繁写入） -------------------- */
  useEffect(() => {
    const timer = setTimeout(() => saveJson(STORAGE_KEYS.messages, state.messages), 500);
    return () => clearTimeout(timer);
  }, [state.messages]);

  useEffect(() => {
    saveJson(STORAGE_KEYS.tasks, state.tasks);
  }, [state.tasks]);

  useEffect(() => {
    saveJson(STORAGE_KEYS.quest, state.world);
  }, [state.world]);

  useEffect(() => {
    saveSettings(state.settings);
  }, [state.settings]);

  useEffect(() => {
    if (!state.toast) return;
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => dispatch({ type: 'toast/set', payload: null }), 3200);
    return () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    };
  }, [state.toast]);

  /* -------------------- 健康检查 -------------------- */
  const refreshHealth = useCallback(async () => {
    try {
      const health = await fetchHealth();
      dispatch({ type: 'health/set', payload: { health, error: null } });
    } catch (err) {
      dispatch({
        type: 'health/set',
        payload: { health: null, error: err instanceof ApiError ? err.message : '后端服务不可用' },
      });
    }
  }, []);

  useEffect(() => {
    void refreshHealth();
  }, [refreshHealth]);

  /* -------------------- NPC 留言（结算后她留一句话） -------------------- */

  /**
   * 委托了结后，把这位 NPC 的**留言**追加到她的对话线索里。
   * 文案由 `questLetter` 确定性生成（不额外调模型）；重放（applied 为空）不追加，免得重复。
   */
  const appendQuestLetter = useCallback((world: World, questId: string | null, applied: readonly string[]) => {
    if (!questId || applied.length === 0) return;
    const quest = getQuest(world, questId);
    if (!quest || quest.status !== 'settled') return;
    const npc = getNpc(world, quest.requesterId);
    if (!npc) return;
    const text = questLetter(quest, npc);
    if (!text) return;
    const message: ChatMessage = {
      id: createId('msg'),
      role: 'assistant',
      content: text,
      npcId: quest.requesterId,
      createdAt: Date.now(),
      status: 'done',
    };
    dispatch({ type: 'message/add', payload: message });
  }, []);

  /* -------------------- 发送一轮对话 -------------------- */
  const send = useCallback(async (raw: string) => {
    const text = raw.trim();
    const current = stateRef.current;
    if (!text || current.busy) return;

    const settings = current.settings;
    // 这一轮属于哪条线索：'desk' 或当前 NPC 的 id
    const threadId = threadIdFor(settings);
    const userMessage: ChatMessage = {
      id: createId('msg'),
      role: 'user',
      content: text,
      npcId: threadId,
      createdAt: Date.now(),
      status: 'done',
    };
    const assistantMessage: ChatMessage = {
      id: createId('msg'),
      role: 'assistant',
      content: '',
      npcId: threadId,
      createdAt: Date.now(),
      status: 'streaming',
    };

    // 只把**当前线索**的历史发给模型：否则切到陆行舟后还会收到苏晚照的旧话，
    // 两个人格就糊在一起了
    const history = [...messagesOfThread(current.messages, threadId), userMessage]
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim())
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    dispatch({ type: 'message/add', payload: userMessage });
    dispatch({ type: 'message/add', payload: assistantMessage });
    dispatch({ type: 'busy/set', payload: true });
    dispatch({ type: 'streaming/set', payload: assistantMessage.id });

    const controller = new AbortController();
    abortRef.current = controller;

    let assistantText = '';
    const toolCandidates: TaskCandidate[] = [];
    const notices: string[] = [];
    let streamError: string | null = null;
    const startedAt = Date.now();

    /* -------------------- npc 模式：世界副本 + 裁决事实 -------------------- */
    const npcMode = settings.chatMode === 'npc';
    let worldDraft = current.world;
    /** 本轮发生的裁决，按时间顺序 */
    const rulings: QuestRuling[] = [];
    /** 印象每轮只认第一条：模型一口气记好几次，多半是在刷好感度 */
    let impressionHandled = false;
    /** 被忽略的重复印象调用，收尾时记进审计（拒绝/忽略都不静默） */
    const extraImpressions: string[] = [];
    // 只读真相随之进 prompt：只有 NPC 自己的视角（ADR-013）
    const systemContent = npcMode
      ? buildNpcSystemPrompt(
          worldDraft,
          settings.questNpcId,
          current.lastRuling,
          npcPersonaFor(settings, settings.questNpcId),
        )
      : undefined;

    try {
      await streamChat({
        settings,
        messages: buildRequestMessages(settings, history, systemContent),
        signal: controller.signal,
        onEvent: (event: ServerEvent) => {
          switch (event.type) {
            case 'delta':
              assistantText += event.text;
              dispatch({ type: 'message/append', payload: { id: assistantMessage.id, kind: 'content', text: event.text } });
              break;
            case 'reasoning':
              dispatch({
                type: 'message/append',
                payload: { id: assistantMessage.id, kind: 'reasoning', text: event.text },
              });
              break;
            case 'tool_call': {
              const candidate = candidateFromToolPayload(
                event.task as RawTaskPayload,
                assistantText || event.task.detail,
                assistantMessage.id,
              );
              toolCandidates.push(candidate);
              break;
            }
            case 'quest_proposal':
            case 'quest_submit':
            case 'quest_decline': {
              // desk 模式不会收到这些事件；真收到也不该动世界
              if (!npcMode) break;
              const channel: QuestChannelEvent =
                event.type === 'quest_proposal'
                  ? { type: 'quest_proposal', proposal: event.proposal }
                  : event.type === 'quest_submit'
                    ? { type: 'quest_submit', submission: event.submission }
                    : { type: 'quest_decline', decline: event.decline };
              // 模型只提提案，裁决在这里发生；每次一个新幂等键
              const outcome = applyQuestEvent(worldDraft, channel, {
                npcId: settings.questNpcId,
                requestId: createId('req'),
                dialogueId: assistantMessage.id,
                now: Date.now(),
              });
              worldDraft = outcome.world;
              rulings.push(outcome.ruling);
              break;
            }
            case 'quest_impression': {
              if (!npcMode) break;
              // 每轮只认第一条：多调无效，但要留痕
              if (impressionHandled) {
                extraImpressions.push('本轮重复调用 note_impression，已忽略（每轮只认第一条）');
                break;
              }
              impressionHandled = true;
              const outcome = applyQuestImpression(worldDraft, {
                npcId: settings.questNpcId,
                impression: event.impression.kind,
                ...(event.impression.reason ? { reason: event.impression.reason } : {}),
                requestId: createId('req'),
                now: Date.now(),
              });
              worldDraft = outcome.world;
              rulings.push(outcome.ruling);
              break;
            }
            case 'notice':
              notices.push(event.message);
              break;
            case 'error':
              streamError = event.message;
              break;
            default:
              break;
          }
        },
      });
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') {
        // 用户主动停止，不算错误
      } else {
        streamError = err instanceof ApiError ? err.message : ((err as Error)?.message ?? '请求失败');
      }
    } finally {
      abortRef.current = null;
    }

    const aborted = controller.signal.aborted;
    dispatch({
      type: 'message/finish',
      payload: {
        id: assistantMessage.id,
        status: streamError ? 'error' : aborted ? 'aborted' : 'done',
        ...(streamError ? { errorText: streamError } : {}),
      },
    });
    dispatch({ type: 'busy/set', payload: false });
    dispatch({ type: 'streaming/set', payload: null });

    /* -------------------- npc 模式收尾：落世界 + 记裁决 -------------------- */
    if (npcMode) {
      const durationMs = Date.now() - startedAt;
      // 记一轮对话：talk_count 目标（以及后续阶段门控）读的就是这个计数。
      // 这不是裁决规则，只是把"跟这位 NPC 说过几轮话"这个事实记下来。
      const talkedNpcId = settings.questNpcId;
      const talks = { ...worldDraft.player.talks };
      talks[talkedNpcId] = (talks[talkedNpcId] ?? 0) + 1;
      worldDraft = { ...worldDraft, player: { ...worldDraft.player, talks } };

      if (worldDraft !== current.world) dispatch({ type: 'world/set', payload: worldDraft });
      const freshRuling = rulings.length > 0 ? rulings[rulings.length - 1] : null;
      // **成功**的裁决事实不随轮次过期：本轮没有新裁决时，继续回注上一次成功的那条
      // （交付已经发生是世界状态，不是"刚刚发生"的临时消息；否则界面按钮交的货，
      //  NPC 下一轮就忘了，会一直催"东西呢"）。
      // **拒绝**只活一轮 —— 它是即时纠正，留着只会让 NPC 以为"刚刚又被拒了"。
      const carried = current.lastRuling && current.lastRuling.ok ? current.lastRuling : null;
      dispatch({ type: 'ruling/set', payload: freshRuling ?? carried });
      // 每一笔裁决都留痕；拒绝绝不静默
      for (const ruling of rulings) {
        dispatch({ type: 'audit/push', payload: buildQuestAudit(ruling, assistantMessage.id, durationMs) });
        // 对话里交付成功的，也留一句她的留言（跟界面按钮交付同一条路径）
        if (ruling.ok && ruling.action === 'submit_quest') {
          appendQuestLetter(worldDraft, ruling.questId, ruling.applied);
        }
      }
      // 被忽略的重复印象调用也留痕（多调无效，但不能静默）
      for (const note of extraImpressions) {
        dispatch({
          type: 'audit/push',
          payload: {
            id: createId('audit'),
            at: Date.now(),
            messageId: assistantMessage.id,
            triggered: false,
            reasons: ['note_impression'],
            channel: 'tool',
            produced: 0,
            dropped: 1,
            durationMs,
            note,
          },
        });
      }
      const rejected = rulings.find((ruling) => !ruling.ok);
      if (rejected) {
        dispatch({ type: 'toast/set', payload: `系统驳回（${rejected.code ?? 'unknown'}）：${rejected.message}` });
      } else if (freshRuling) {
        dispatch({ type: 'toast/set', payload: freshRuling.message });
      } else if (streamError) {
        dispatch({
          type: 'audit/push',
          payload: {
            id: createId('audit'),
            at: Date.now(),
            messageId: assistantMessage.id,
            triggered: false,
            reasons: [],
            channel: 'none',
            produced: 0,
            dropped: 0,
            durationMs,
            note: `对话失败：${streamError}`,
          },
        });
        dispatch({ type: 'toast/set', payload: streamError });
      } else if (notices.length > 0) {
        dispatch({ type: 'toast/set', payload: notices[0] });
      }
      // npc 模式不走需求抽取通道
      return;
    }

    if (streamError && !assistantText) {
      dispatch({
        type: 'audit/push',
        payload: {
          id: createId('audit'),
          at: Date.now(),
          messageId: assistantMessage.id,
          triggered: false,
          reasons: [],
          channel: 'none',
          produced: 0,
          dropped: 0,
          durationMs: Date.now() - startedAt,
          note: `对话失败：${streamError}`,
        },
      });
      return;
    }

    /* -------------------- 抽取通道 -------------------- */
    const existingTitles = stateRef.current.tasks.map((task) => task.title);
    const toolDedupe = dedupeCandidates(toolCandidates, existingTitles, settings.dedupeThreshold);

    const outcome = await runExtraction({
      text: assistantText,
      context: text,
      settings,
      serverHasKey: stateRef.current.health?.defaults.hasKey ?? false,
      existingTitles: [...existingTitles, ...toolDedupe.kept.map((c) => c.title)],
      sourceMessageId: assistantMessage.id,
    });

    const fresh = [...toolDedupe.kept, ...outcome.candidates];
    const channel: AuditEntry['channel'] =
      toolDedupe.kept.length > 0 ? 'tool' : outcome.channel === 'none' ? 'none' : outcome.channel;

    if (fresh.length > 0) {
      if (settings.autoAccept) {
        const newTasks = fresh.map((candidate) => taskFromCandidate(candidate, 'pending'));
        dispatch({ type: 'tasks/addMany', payload: newTasks });
        dispatch({ type: 'toast/set', payload: `已自动接取 ${newTasks.length} 条任务` });
      } else {
        dispatch({ type: 'candidates/push', payload: fresh });
      }
    }

    dispatch({
      type: 'audit/push',
      payload: {
        id: createId('audit'),
        at: Date.now(),
        messageId: assistantMessage.id,
        triggered: toolDedupe.kept.length > 0 || outcome.triggered,
        reasons: outcome.reasons,
        channel,
        produced: fresh.length,
        dropped: toolDedupe.dropped.length + outcome.dropped.length,
        durationMs: Date.now() - startedAt,
        ...(outcome.note || notices.length > 0
          ? { note: [...notices, outcome.note].filter(Boolean).join('；') }
          : {}),
      },
    });

    if (notices.length > 0) dispatch({ type: 'toast/set', payload: notices[0] });
  }, [appendQuestLetter]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    const next = normalizeSettings({ ...stateRef.current.settings, ...patch });
    dispatch({ type: 'settings/set', payload: next });
  }, []);

  const acceptCandidate = useCallback((id: string) => {
    const candidate = stateRef.current.candidates.find((item) => item.id === id);
    if (!candidate) return;
    dispatch({ type: 'tasks/addMany', payload: [taskFromCandidate(candidate, 'pending')] });
    dispatch({ type: 'candidates/remove', payload: id });
    dispatch({ type: 'toast/set', payload: `已接取任务：${candidate.title}` });
  }, []);

  const acceptAllCandidates = useCallback(() => {
    const list = stateRef.current.candidates;
    if (list.length === 0) return;
    dispatch({ type: 'tasks/addMany', payload: list.map((candidate) => taskFromCandidate(candidate, 'pending')) });
    dispatch({ type: 'candidates/clear' });
    dispatch({ type: 'toast/set', payload: `已接取 ${list.length} 条任务` });
  }, []);

  const dropCandidate = useCallback((id: string) => {
    dispatch({ type: 'candidates/remove', payload: id });
  }, []);

  /* -------------------- NPC 委托：玩家在界面上点头 / 摇头 -------------------- */

  /** 玩家点【接取】：同样走裁决层，不直接改状态 */
  const acceptQuest = useCallback((questId: string) => {
    const current = stateRef.current;
    const outcome = applyPlayerAccept(current.world, {
      questId,
      requestId: createId('req'),
      now: Date.now(),
    });
    dispatch({ type: 'world/set', payload: outcome.world });
    dispatch({ type: 'ruling/set', payload: outcome.ruling });
    dispatch({ type: 'audit/push', payload: buildQuestAudit(outcome.ruling, null, 0) });
    dispatch({
      type: 'toast/set',
      payload: outcome.ruling.ok
        ? outcome.ruling.message
        : `接取失败（${outcome.ruling.code ?? 'unknown'}）：${outcome.ruling.message}`,
    });
  }, []);

  /** 玩家点【婉拒】：释放这条委托预留的谢礼 */
  const declineQuest = useCallback((questId: string, reason?: string) => {
    const current = stateRef.current;
    const outcome = applyPlayerDecline(current.world, {
      questId,
      requestId: createId('req'),
      now: Date.now(),
      ...(reason ? { reason } : {}),
    });
    dispatch({ type: 'world/set', payload: outcome.world });
    dispatch({ type: 'ruling/set', payload: outcome.ruling });
    dispatch({ type: 'audit/push', payload: buildQuestAudit(outcome.ruling, null, 0) });
    dispatch({
      type: 'toast/set',
      payload: outcome.ruling.ok
        ? outcome.ruling.message
        : `婉拒失败（${outcome.ruling.code ?? 'unknown'}）：${outcome.ruling.message}`,
    });
  }, []);

  /** 玩家点【交付 / 请对方验看】：走裁决层提交（界面不替裁决层判断够不够） */
  const deliverQuest = useCallback((questId: string, deliver?: ItemStack) => {
    const current = stateRef.current;
    const outcome = applyPlayerSubmit(current.world, {
      questId,
      requestId: createId('req'),
      now: Date.now(),
      ...(deliver ? { deliver } : {}),
    });
    dispatch({ type: 'world/set', payload: outcome.world });
    dispatch({ type: 'ruling/set', payload: outcome.ruling });
    dispatch({ type: 'audit/push', payload: buildQuestAudit(outcome.ruling, null, 0) });
    dispatch({
      type: 'toast/set',
      payload: outcome.ruling.ok
        ? outcome.ruling.message
        : playerQuestRejectionText(outcome.ruling.code, outcome.ruling.message),
    });
    // 了结后她留一句 —— 只在真的发生结算时追加（幂等重放不重复）
    if (outcome.ruling.ok) appendQuestLetter(outcome.world, questId, outcome.ruling.applied);
  }, [appendQuestLetter]);

  /**
   * 玩家点【送给他】：白送一件道具给当前 NPC。
   * 跟交付一样走裁决层：够不够由代码判定，NPC 不能以「用不上」为由拒收（NFR-013）。
   */
  const giftQuest = useCallback((npcId: string, itemId: string, count: number) => {
    const current = stateRef.current;
    const outcome = applyPlayerGift(current.world, {
      npcId,
      itemId,
      count,
      requestId: createId('req'),
      now: Date.now(),
    });
    dispatch({ type: 'world/set', payload: outcome.world });
    dispatch({ type: 'ruling/set', payload: outcome.ruling });
    dispatch({ type: 'audit/push', payload: buildQuestAudit(outcome.ruling, null, 0) });
    dispatch({
      type: 'toast/set',
      payload: outcome.ruling.ok
        ? outcome.ruling.message
        : playerQuestRejectionText(outcome.ruling.code, outcome.ruling.message),
    });
  }, []);

  /** 玩家点【补齐行囊】：每种道具补到 64（已够的不动） */
  const restockInventory = useCallback(() => {
    const current = stateRef.current;
    const outcome = applyPlayerRestock(current.world, { requestId: createId('req'), now: Date.now() });
    dispatch({ type: 'world/set', payload: outcome.world });
    dispatch({ type: 'ruling/set', payload: outcome.ruling });
    dispatch({ type: 'audit/push', payload: buildQuestAudit(outcome.ruling, null, 0) });
    dispatch({
      type: 'toast/set',
      payload: outcome.ruling.ok
        ? outcome.ruling.message
        : playerQuestRejectionText(outcome.ruling.code, outcome.ruling.message),
    });
  }, []);

  /**
   * 只重置「对话与进度」：清掉对话、任务、委托世界三份数据，
   * **保留设置**（含 API Key、模型、按 NPC 的人格补充）。
   */
  const resetConversation = useCallback(() => {
    const keptSettings = stateRef.current.settings;
    removeKeys([STORAGE_KEYS.messages, STORAGE_KEYS.tasks, STORAGE_KEYS.quest]);
    dispatch({ type: 'data/reset', payload: keptSettings });
    dispatch({ type: 'toast/set', payload: '已重置对话与进度（设置与 API Key 保留）' });
  }, []);

  const setTaskStatus = useCallback((id: string, status: TaskStatus) => {
    dispatch({ type: 'tasks/status', payload: { id, status } });
  }, []);

  const removeTask = useCallback((id: string) => {
    dispatch({ type: 'tasks/remove', payload: id });
  }, []);

  const clearMessages = useCallback(() => {
    // 只清当前线索：切回别的 NPC 时，你们之前的对话还在
    dispatch({ type: 'message/clearThread', payload: threadIdFor(stateRef.current.settings) });
    dispatch({ type: 'candidates/clear' });
  }, []);

  const clearTasks = useCallback(() => {
    dispatch({ type: 'tasks/clear' });
  }, []);

  const resetAll = useCallback(() => {
    removeKeys([STORAGE_KEYS.settings, STORAGE_KEYS.messages, STORAGE_KEYS.tasks, STORAGE_KEYS.quest]);
    dispatch({ type: 'data/reset', payload: normalizeSettings(loadSettings()) });
    dispatch({ type: 'toast/set', payload: '已清空本地数据' });
  }, []);

  const setToast = useCallback((message: string | null) => {
    dispatch({ type: 'toast/set', payload: message });
  }, []);

  /** 拉取上游模型列表（AC-3.2），使用设置面板里尚未保存的草稿值。 */
  const listModels = useCallback(
    async (draft: { baseUrl: string; apiKey: string }): Promise<string[]> =>
      fetchModels({ ...stateRef.current.settings, baseUrl: draft.baseUrl, apiKey: draft.apiKey }),
    [],
  );

  /** 设置面板里的「测试对话」：不污染当前会话（AC-3.3）。 */
  const testConnection = useCallback(async (): Promise<{ ok: boolean; message: string }> => {
    const settings = stateRef.current.settings;
    let received = '';
    let failure: string | null = null;
    try {
      await streamChat({
        settings: { ...settings, enableTools: false },
        messages: [
          { role: 'system', content: '只回答两个字：可以' },
          { role: 'user', content: '连通性测试' },
        ],
        onEvent: (event) => {
          if (event.type === 'delta') received += event.text;
          if (event.type === 'error') failure = event.message;
        },
      });
    } catch (err) {
      failure = err instanceof ApiError ? err.message : ((err as Error)?.message ?? '未知错误');
    }
    if (failure) return { ok: false, message: failure };
    if (!received.trim()) return { ok: false, message: '连接成功但没有收到内容，请检查模型名' };
    return { ok: true, message: `连接正常，模型回复：${received.trim().slice(0, 30)}` };
  }, []);

  const highlightMessage = useCallback((id: string | null) => {
    dispatch({ type: 'message/highlight', payload: id });
  }, []);

  const value = useMemo<StoreValue>(
    () => ({
      state,
      send,
      stop,
      updateSettings,
      acceptCandidate,
      dropCandidate,
      acceptAllCandidates,
      acceptQuest,
      declineQuest,
      deliverQuest,
      giftQuest,
      restockInventory,
      resetConversation,
      setTaskStatus,
      removeTask,
      clearMessages,
      clearTasks,
      resetAll,
      refreshHealth,
      testConnection,
      listModels,
      setToast,
      highlightMessage,
      configured: hasCredentials(state.settings, state.health?.defaults.hasKey ?? false),
    }),
    [
      state,
      send,
      stop,
      updateSettings,
      acceptCandidate,
      dropCandidate,
      acceptAllCandidates,
      acceptQuest,
      declineQuest,
      deliverQuest,
      giftQuest,
      restockInventory,
      resetConversation,
      setTaskStatus,
      removeTask,
      clearMessages,
      clearTasks,
      resetAll,
      refreshHealth,
      testConnection,
      listModels,
      setToast,
      highlightMessage,
    ],
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreValue {
  const context = useContext(StoreContext);
  if (!context) throw new Error('useStore 必须在 StoreProvider 内部使用');
  return context;
}
