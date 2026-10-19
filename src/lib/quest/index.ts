/**
 * NPC 委托领域层 —— 对外出口。
 *
 * 分层：
 *   types / constants   数据形状与规则常量
 *   items               道具注册表、珍贵等级与用途标签
 *   inventory           背包（纯函数，含预留锁）
 *   rewards             奖励白名单、档位（道具无价值上限，背包即上限）
 *   objectives          目标原语白名单与判定
 *   world               世界状态、NPC 主观估值与只读快照
 *   relationship        关系阶段（五档，单向不回落）
 *   adjudicate          裁决层（幂等 / 原子 / 预留 / 守恒）
 */
export * from './types.ts';
export * from './constants.ts';
export * from './items.ts';
export * from './inventory.ts';
export * from './rewards.ts';
export * from './objectives.ts';
export * from './world.ts';
export * from './relationship.ts';
export * from './letter.ts';
export * from './adjudicate.ts';
