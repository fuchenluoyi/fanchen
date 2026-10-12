/**
 * NPC 委托领域层 —— 对外出口。
 *
 * 分层：
 *   types / constants   数据形状与规则常量
 *   items               道具注册表与珍贵等级
 *   inventory           背包（纯函数，含预留锁）
 *   rewards             奖励白名单、档位、价值上限
 *   objectives          目标原语白名单与判定
 *   world               世界状态与只读快照
 *   adjudicate          裁决层（幂等 / 原子 / 预留 / 守恒）
 */
export * from './types.ts';
export * from './constants.ts';
export * from './items.ts';
export * from './inventory.ts';
export * from './rewards.ts';
export * from './objectives.ts';
export * from './world.ts';
export * from './adjudicate.ts';
