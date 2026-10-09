/**
 * 抽取通道编排（ADR-003 / ADR-004）：
 *   规则触发 → 有凭据则 LLM 结构化抽取 → 失败/无凭据回退规则 → 去重 → 产出候选。
 * 该模块只依赖纯函数与 api，便于注入假 fetch 做单测（U-06）。
 */
import type { RawTaskPayload, Settings, Task, TaskCandidate, Origin } from '../types.ts';
import { analyzeForRequirements, ruleCandidates, sentenceUnits } from './rules.ts';
import { dedupeCandidates, similarity } from './dedupe.ts';
import { requestExtraction } from './api.ts';
import { createId } from './id.ts';

export type ExtractChannel = 'llm' | 'rule' | 'none';

export interface ExtractionInput {
  /** 助手回复原文 */
  text: string;
  /** 对话者上一句，作为抽取的补充语境 */
  context?: string;
  settings: Settings;
  /** 服务端是否配置了环境变量 Key */
  serverHasKey: boolean;
  /** 已存在任务的标题，用于去重 */
  existingTitles: readonly string[];
  sourceMessageId: string | null;
  fetchImpl?: typeof fetch;
}

export interface ExtractionOutcome {
  candidates: TaskCandidate[];
  triggered: boolean;
  reasons: string[];
  channel: ExtractChannel;
  dropped: Array<{ title: string; duplicateOf: string; score: number }>;
  note?: string;
}

const EMPTY: ExtractionOutcome = {
  candidates: [],
  triggered: false,
  reasons: [],
  channel: 'none',
  dropped: [],
};

/** 从原文里挑出与标题最贴近的一句，作为「查看原话」的证据。 */
export function pickEvidence(text: string, title: string): string {
  const units = sentenceUnits(text);
  if (units.length === 0) {
    const fallback = text.trim().slice(0, 140);
    return fallback;
  }
  let best = units[0];
  let bestScore = -1;
  for (const unit of units) {
    const score = similarity(unit, title);
    if (score > bestScore) {
      bestScore = score;
      best = unit;
    }
  }
  return best.length > 140 ? `${best.slice(0, 140)}…` : best;
}

function buildCandidate(
  payload: RawTaskPayload,
  origin: Origin,
  options: { text: string; sourceMessageId: string | null; reasons: string[] },
): TaskCandidate {
  return {
    id: createId('cand'),
    title: payload.title,
    detail: payload.detail,
    category: payload.category,
    priority: payload.priority,
    acceptance: payload.acceptance,
    confidence: payload.confidence,
    origin,
    evidence: pickEvidence(options.text, payload.title),
    sourceMessageId: options.sourceMessageId,
    triggerReasons: options.reasons,
    createdAt: Date.now(),
  };
}

/**
 * 工具通道产出的候选（模型主动调用 create_task，FR-004）。
 */
export function candidateFromToolPayload(
  payload: RawTaskPayload,
  text: string,
  sourceMessageId: string | null,
): TaskCandidate {
  return buildCandidate(payload, 'llm', {
    text,
    sourceMessageId,
    reasons: ['模型主动调用 create_task'],
  });
}

/**
 * 运行抽取通道。
 */
export async function runExtraction(input: ExtractionInput): Promise<ExtractionOutcome> {
  const { settings } = input;
  const text = String(input.text ?? '').trim();
  if (!text) return { ...EMPTY, note: '回复为空，跳过抽取' };
  if (settings.extractMode === 'off') return { ...EMPTY, note: '抽取通道已关闭' };

  const analysis = analyzeForRequirements(text);
  if (!analysis.hit && settings.extractMode === 'auto') {
    return { ...EMPTY, note: '规则未命中，未调用模型（省一次调用）' };
  }

  const hasCreds = settings.apiKey.trim().length > 0 || input.serverHasKey;
  let payloads: RawTaskPayload[] = [];
  let channel: ExtractChannel = 'none';
  let note: string | undefined;

  if (settings.extractMode !== 'rule' && hasCreds) {
    try {
      const llmTasks = await requestExtraction({
        settings,
        text,
        context: input.context ?? '',
        fetchImpl: input.fetchImpl,
      });
      if (llmTasks.length > 0) {
        payloads = llmTasks;
        channel = 'llm';
      } else {
        note = '模型认为这段话里没有可登记的需求';
      }
    } catch (err) {
      note = `模型抽取失败，已回退规则：${(err as Error)?.message ?? '未知错误'}`;
    }
  } else if (!hasCreds) {
    note = '未配置凭据，规则引擎降级接管';
  }

  if (payloads.length === 0) {
    payloads = ruleCandidates(text);
    if (payloads.length > 0) channel = 'rule';
  }

  if (payloads.length === 0) {
    return {
      candidates: [],
      triggered: analysis.hit,
      reasons: analysis.reasons,
      channel: 'none',
      dropped: [],
      note: note ?? '未发现需求',
    };
  }

  const reasons =
    channel === 'llm'
      ? ['模型结构化抽取', ...analysis.reasons].slice(0, 6)
      : analysis.reasons.length > 0
        ? analysis.reasons
        : ['规则引擎命中'];

  const origin: Origin = channel === 'llm' ? 'llm' : 'rule';
  const { kept, dropped } = dedupeCandidates(
    payloads.map((payload) => ({ ...payload, origin })),
    input.existingTitles,
    settings.dedupeThreshold,
  );

  const candidates = kept.map((payload) =>
    buildCandidate(payload, origin, { text, sourceMessageId: input.sourceMessageId, reasons }),
  );

  return {
    candidates,
    triggered: true,
    reasons,
    channel,
    dropped: dropped.map((entry) => ({
      title: entry.item.title,
      duplicateOf: entry.duplicateOf,
      score: entry.score,
    })),
    ...(note ? { note } : {}),
  };
}

/** 候选 → 正式任务（FR-007 采纳时调用）。 */
export function taskFromCandidate(candidate: TaskCandidate, status: Task['status'] = 'pending'): Task {
  const now = Date.now();
  return {
    id: createId('task'),
    title: candidate.title,
    detail: candidate.detail,
    category: candidate.category,
    priority: candidate.priority,
    acceptance: [...candidate.acceptance],
    confidence: candidate.confidence,
    origin: candidate.origin,
    evidence: candidate.evidence,
    sourceMessageId: candidate.sourceMessageId,
    triggerReasons: [...candidate.triggerReasons],
    status,
    createdAt: now,
    updatedAt: now,
  };
}
