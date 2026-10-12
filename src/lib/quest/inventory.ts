/**
 * 背包：纯函数、不可变（NFR-009）。NPC 与玩家共用同一套结构。
 *
 * 关键设计 —— 预留锁（§3.3 硬约束 3）：
 *   背包里的道具分成「可用」与「已预留」两份。发布任务时奖励道具从可用挪进已预留，
 *   于是同一瓶药不可能被两个任务同时承诺出去。挪位置不等于消失：
 *   不变式 totalOf(item) === 可用 + 已预留 恒成立（资源守恒）。
 *
 * 每个函数都返回新的背包对象，入参不被修改；失败一律抛 QuestError，
 * 由裁决层统一兜住并保证「拒绝 = 世界完全不变」。
 */
import { QuestError } from './types.ts';
import type { Hold, Inventory, ItemStack } from './types.ts';
import { itemValue } from './items.ts';

/** 归一化：合并重复 itemId、丢掉非正数量、按价值降序排列 */
function normalizeStacks(stacks: readonly ItemStack[]): ItemStack[] {
  const merged = new Map<string, number>();
  for (const stack of stacks) {
    if (!stack || typeof stack.itemId !== 'string' || !stack.itemId) continue;
    const count = Number.isFinite(stack.count) ? Math.floor(stack.count) : 0;
    if (count <= 0) continue;
    merged.set(stack.itemId, (merged.get(stack.itemId) ?? 0) + count);
  }
  return [...merged.entries()]
    .map(([itemId, count]) => ({ itemId, count }))
    .sort((a, b) => itemValue(b.itemId) - itemValue(a.itemId) || a.itemId.localeCompare(b.itemId));
}

export function createInventory(ownerId: string, stacks: readonly ItemStack[] = []): Inventory {
  return { ownerId, stacks: normalizeStacks(stacks), holds: [] };
}

/* ------------------------------ 查询 ------------------------------ */

export function availableOf(inventory: Inventory, itemId: string): number {
  return inventory.stacks.find((stack) => stack.itemId === itemId)?.count ?? 0;
}

export function heldOf(inventory: Inventory, itemId: string): number {
  let sum = 0;
  for (const hold of inventory.holds) if (hold.itemId === itemId) sum += hold.count;
  return sum;
}

/** 拥有总量 = 可用 + 已预留（预留只是挪了位置） */
export function totalOf(inventory: Inventory, itemId: string): number {
  return availableOf(inventory, itemId) + heldOf(inventory, itemId);
}

export function hasAvailable(inventory: Inventory, itemId: string, count: number): boolean {
  return availableOf(inventory, itemId) >= count;
}

export function listAvailable(inventory: Inventory): ItemStack[] {
  return normalizeStacks(inventory.stacks);
}

export function listHolds(inventory: Inventory): Hold[] {
  return [...inventory.holds];
}

/** 背包总值（含已预留），供门控与展示 */
export function inventoryValue(inventory: Inventory): number {
  let sum = 0;
  for (const stack of inventory.stacks) sum += itemValue(stack.itemId) * stack.count;
  for (const hold of inventory.holds) sum += itemValue(hold.itemId) * hold.count;
  return sum;
}

/* ------------------------------ 变更 ------------------------------ */

/** 增加可用道具 */
export function addItems(inventory: Inventory, stacks: readonly ItemStack[]): Inventory {
  return { ...inventory, stacks: normalizeStacks([...inventory.stacks, ...stacks]) };
}

/** 扣减可用道具；不足则抛错（调用方必须在此之前做完所有校验） */
export function removeAvailable(inventory: Inventory, itemId: string, count: number): Inventory {
  if (count <= 0) return inventory;
  const have = availableOf(inventory, itemId);
  if (have < count) {
    throw new QuestError('insufficient_items', `可用「${itemId}」只有 ${have}，需要 ${count}`);
  }
  const next = inventory.stacks
    .map((stack) => (stack.itemId === itemId ? { ...stack, count: stack.count - count } : stack))
    .filter((stack) => stack.count > 0);
  return { ...inventory, stacks: normalizeStacks(next) };
}

/**
 * 预留：可用 → 已预留。数量不足则抛错 —— 这是「发布任务时锁奖励」的原子入口。
 */
export function holdItem(
  inventory: Inventory,
  params: { questId: string; itemId: string; count: number; holdId: string; at: number },
): { inventory: Inventory; hold: Hold } {
  const hold: Hold = {
    id: params.holdId,
    questId: params.questId,
    itemId: params.itemId,
    count: params.count,
    createdAt: params.at,
  };
  const next: Inventory = {
    ...removeAvailable(inventory, params.itemId, params.count),
  };
  return { inventory: { ...next, holds: [...next.holds, hold] }, hold };
}

/** 释放预留：已预留 → 可用（婉拒、撤销、过期时用） */
export function releaseHold(inventory: Inventory, holdId: string): Inventory {
  const hold = inventory.holds.find((entry) => entry.id === holdId);
  if (!hold) throw new QuestError('invalid_field', `预留不存在：${holdId}`);
  return {
    ...addItems({ ...inventory, holds: inventory.holds.filter((entry) => entry.id !== holdId) }, [
      { itemId: hold.itemId, count: hold.count },
    ]),
  };
}

/** 核销预留：已预留的那份被真正发出去（离开本背包），总量随之减少 */
export function consumeHold(inventory: Inventory, holdId: string): Inventory {
  const hold = inventory.holds.find((entry) => entry.id === holdId);
  if (!hold) throw new QuestError('invalid_field', `预留不存在：${holdId}`);
  return { ...inventory, holds: inventory.holds.filter((entry) => entry.id !== holdId) };
}

/** 释放某个任务留下的全部预留（正常只有一个） */
export function releaseHoldsForQuest(inventory: Inventory, questId: string): Inventory {
  let current = inventory;
  for (const hold of inventory.holds.filter((entry) => entry.questId === questId)) {
    current = releaseHold(current, hold.id);
  }
  return current;
}

/** 背包自检：预留数量不得超过拥有总量 */
export function auditInventory(inventory: Inventory): string[] {
  const problems: string[] = [];
  const itemIds = new Set([...inventory.stacks.map((s) => s.itemId), ...inventory.holds.map((h) => h.itemId)]);
  for (const itemId of itemIds) {
    if (availableOf(inventory, itemId) < 0) problems.push(`${itemId} 可用数量为负`);
    if (totalOf(inventory, itemId) < heldOf(inventory, itemId)) problems.push(`${itemId} 预留超过拥有量`);
  }
  for (const hold of inventory.holds) {
    if (hold.count <= 0) problems.push(`预留 ${hold.id} 数量非正`);
  }
  return problems;
}
