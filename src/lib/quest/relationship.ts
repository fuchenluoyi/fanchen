/**
 * 关系阶段（五档，**单向不回落**）。
 *
 * 好感度 → 阶段 → 态度描述（写进提示词）。
 *
 * ⚠️ 阶段**不做硬门闩**：低阶段也能托付大事，只是态度上不该那样说话 ——
 * 「事情可以说，就是态度的问题」（用户原话）。所以这里只产出叙事引导，
 * 没有任何一处用阶段去驳回提案。
 */
import type { NpcState } from './types.ts';

export const STAGE_IDS = ['piaoshui', 'xiangshi', 'zhijiao', 'zhiji', 'moni'] as const;

export type StageId = (typeof STAGE_IDS)[number];

export const STAGE_LABEL: Record<StageId, string> = {
  piaoshui: '萍水',
  xiangshi: '相识',
  zhijiao: '知交',
  zhiji: '知己',
  moni: '莫逆',
};

/** 有序的阶段表（界面画进度、测试遍历都用它） */
export const STAGES: ReadonlyArray<{ id: StageId; label: string }> = STAGE_IDS.map((id) => ({
  id,
  label: STAGE_LABEL[id],
}));

/** 各阶段的好感度门槛（含下限）：0-4 / 5-14 / 15-29 / 30-59 / 60+ */
export const STAGE_THRESHOLDS: readonly number[] = [0, 5, 15, 30, 60];

/**
 * 好感度收敛成非负整数。
 * 非有限值（NaN / Infinity）与负数一视同仁当 0：脏数据退回最低档，不猜、也不夹到顶。
 */
function toAffinity(affinity: number): number {
  return Number.isFinite(affinity) ? Math.max(0, Math.floor(affinity)) : 0;
}

function clampIndex(index: number): number {
  if (!Number.isFinite(index)) return 0;
  return Math.min(STAGE_IDS.length - 1, Math.max(0, Math.floor(index)));
}

/** 好感度落在第几档（0 起） */
export function stageIndexOf(affinity: number): number {
  const value = toAffinity(affinity);
  let index = 0;
  for (let i = 0; i < STAGE_THRESHOLDS.length; i += 1) {
    if (value >= STAGE_THRESHOLDS[i]) index = i;
  }
  return index;
}

export function stageOf(affinity: number): StageId {
  return STAGE_IDS[stageIndexOf(affinity)];
}

/**
 * 单向不回落：取「当前阶段」与「历史最高阶段」里更高的那个。
 * 好感度掉下去也不会降阶（记录在 player.stagePeak）。
 */
export function peakStageIndexOf(affinity: number, peak: number | undefined): number {
  const current = stageIndexOf(affinity);
  const recorded = clampIndex(typeof peak === 'number' ? peak : 0);
  return Math.max(current, recorded);
}

export function peakStageOf(affinity: number, peak: number | undefined): StageId {
  return STAGE_IDS[peakStageIndexOf(affinity, peak)];
}

/** 推进用：把历史最高阶段抬到当前阶段，返回应当写回的值 */
export function nextStagePeak(affinity: number, peak: number | undefined): number {
  return peakStageIndexOf(affinity, peak);
}

export interface StageProgress {
  stage: StageId;
  label: string;
  affinity: number;
  /** 距离下一阶段还差多少好感度；已到顶为 0 */
  toNext: number;
  /** 下一阶段的门槛；已到顶为 null */
  nextThreshold: number | null;
  /** 0..1 的进度，给界面画一格很轻的进度用 */
  ratio: number;
}

/** 界面用的阶段进度（传 peak 则按单向不回落后的阶段算） */
export function progressToNextStage(affinity: number, peak?: number): StageProgress {
  const value = toAffinity(affinity);
  const index = peak === undefined ? stageIndexOf(value) : peakStageIndexOf(value, peak);
  const current = STAGE_THRESHOLDS[index];
  const next = index + 1 < STAGE_THRESHOLDS.length ? STAGE_THRESHOLDS[index + 1] : null;
  const span = next === null ? 1 : Math.max(1, next - current);
  return {
    stage: STAGE_IDS[index],
    label: STAGE_LABEL[STAGE_IDS[index]],
    affinity: value,
    toNext: next === null ? 0 : Math.max(0, next - value),
    nextThreshold: next,
    ratio: next === null ? 1 : Math.min(1, Math.max(0, (value - current) / span)),
  };
}

/** 各阶段的说话分寸（提示词用）：称呼、语气、愿不愿说心里话、会不会主动关心 */
const ATTITUDE: Record<StageId, string> = {
  piaoshui: '你只当对方是位过路的客人：称「这位」，多说场面话，心里的事一句不提，也不问他冷暖。',
  xiangshi: '你已认得对方，语气松了些，称「你」，偶尔提一句自己的近况，但还不交底，也不会主动关心。',
  zhijiao: '你把对方当朋友：愿意说些心里话，也会问一句他过得如何，可要紧的事仍留半分。',
  zhiji: '你信得过对方：心事可以讲，遇到难处会想到他，也会主动替他打算。',
  moni: '你把对方当生死之交：什么话都能说，遇事第一个想到他，他的事你当成自己的事。',
};

/** 提示词里「此刻的态度」那一段 */
export function describeAttitude(stage: StageId, npc: Pick<NpcState, 'name' | 'title'>): string {
  return `${npc.title}「${npc.name}」的说话分寸：${ATTITUDE[stage]}`;
}
