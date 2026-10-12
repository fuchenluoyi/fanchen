/**
 * 目标原语白名单（§3.6）。
 *
 * 模型可以自由编故事，但**目标不能自由发明**：如果它提出「让我开心就行」，
 * 代码没法判定完成。所以目标必须是可验证原语。
 *
 * 每个原语声明自己的可用状态：supported = 现在就能裁决；
 * pending_dependency = 依赖尚不存在的系统（例如 defeat 依赖战斗系统，§3.4 隐藏依赖）。
 */
import { QuestError } from './types.ts';
import type { ObjectivePrimitive, PrimitiveSupport, Quest, World } from './types.ts';
import { isKnownItem, itemName } from './items.ts';

export const PRIMITIVE_SUPPORT: Record<ObjectivePrimitive['kind'], PrimitiveSupport> = {
  deliver_item: 'supported',
  has_item: 'supported',
  talk_count: 'supported',
  affinity_at_least: 'supported',
  defeat: 'pending_dependency',
};

/** 形状与白名单校验（不检查可用状态） */
export function validateObjective(objective: ObjectivePrimitive): void {
  if (!objective || typeof objective !== 'object' || typeof objective.kind !== 'string') {
    throw new QuestError('invalid_objective', '目标必须是带 kind 的对象');
  }
  if (!(objective.kind in PRIMITIVE_SUPPORT)) {
    throw new QuestError('invalid_objective', `未知目标原语：${objective.kind}`);
  }
  switch (objective.kind) {
    case 'deliver_item':
    case 'has_item': {
      if (!isKnownItem(objective.itemId)) {
        throw new QuestError('unknown_item', `目标引用了未登记的道具：${objective.itemId}`);
      }
      if (!Number.isInteger(objective.count) || objective.count < 1) {
        throw new QuestError('invalid_objective', '目标道具数量必须是 ≥ 1 的整数');
      }
      return;
    }
    case 'talk_count': {
      if (!Number.isInteger(objective.rounds) || objective.rounds < 1) {
        throw new QuestError('invalid_objective', '对话轮数必须是 ≥ 1 的整数');
      }
      return;
    }
    case 'affinity_at_least': {
      if (!Number.isInteger(objective.value) || objective.value < 1) {
        throw new QuestError('invalid_objective', '好感度阈值必须是 ≥ 1 的整数');
      }
      return;
    }
    case 'defeat': {
      if (typeof objective.targetId !== 'string' || !objective.targetId.trim()) {
        throw new QuestError('invalid_objective', '击败目标必须给出 targetId');
      }
      return;
    }
    default:
      return;
  }
}

/** 可用状态校验：依赖尚不存在系统的原语，一律拒绝登记 */
export function assertObjectiveSupported(objective: ObjectivePrimitive): void {
  if (PRIMITIVE_SUPPORT[objective.kind] === 'pending_dependency') {
    throw new QuestError(
      'unsupported_objective',
      `目标原语「${objective.kind}」依赖尚不存在的系统，暂时无法裁决`,
    );
  }
}

/** 目标里是否涉及道具，以及数量 —— 供套利校验与交付流程使用 */
export function objectiveItemRef(objective: ObjectivePrimitive): { itemId: string; count: number } | null {
  if (objective.kind === 'deliver_item' || objective.kind === 'has_item') {
    return { itemId: objective.itemId, count: objective.count };
  }
  return null;
}

/**
 * 目标是否已达成。
 * 注意 deliver_item 永远返回 false：它必须走 submitQuest 的交付流程（先扣道具再结算），
 * 不能靠「看一眼背包」判定了事。
 */
export function objectiveSatisfied(world: World, quest: Quest): boolean {
  const objective = quest.objective;
  switch (objective.kind) {
    case 'has_item':
      return world.player.inventory.stacks.some(
        (stack) => stack.itemId === objective.itemId && stack.count >= objective.count,
      );
    case 'talk_count':
      return (world.player.talks[quest.requesterId] ?? 0) >= objective.rounds;
    case 'affinity_at_least':
      return (world.player.affinity[quest.requesterId] ?? 0) >= objective.value;
    case 'deliver_item':
    case 'defeat':
    default:
      return false;
  }
}

/** 面向人的目标描述，供界面与命令行演示 */
export function describeObjective(objective: ObjectivePrimitive): string {
  switch (objective.kind) {
    case 'deliver_item':
      return `交付「${itemName(objective.itemId)}」×${objective.count}`;
    case 'has_item':
      return `持有「${itemName(objective.itemId)}」×${objective.count}`;
    case 'talk_count':
      return `累计对话 ${objective.rounds} 轮`;
    case 'affinity_at_least':
      return `好感度达到 ${objective.value}`;
    case 'defeat':
      return `击败 ${objective.targetId}（依赖战斗系统）`;
    default:
      return '未知目标';
  }
}
