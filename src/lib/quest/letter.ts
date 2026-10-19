/**
 * NPC 的「留言」：委托了结后，她留下的一句话。
 *
 * 刻意做成**确定性**的纯函数：同一条委托永远得到同一句，
 * 不额外调用模型（省钱、可断言、刷新后不会变）。
 * 位置：结算时追加到该 NPC 的对话线索里，同时在委托卡上显示。
 */
import { itemName } from './items.ts';
import type { NpcState, Quest } from './types.ts';

function rewardLine(quest: Quest): string {
  switch (quest.reward.kind) {
    case 'item':
      return `说好的${itemName(quest.reward.itemId)}你收着。`;
    case 'affinity':
      return '往后你我之间，又近了一层。';
    case 'ability':
      return '那点本事，好好用。';
    case 'info':
      return '那桩事我还没说完，改日再叙。';
    default:
      return '你没要谢礼，我心里有数。';
  }
}

/**
 * 结算后的留言。只有 `settled` 的委托才有；其余状态返回空串（调用方据此不显示）。
 */
export function questLetter(quest: Quest, npc: Pick<NpcState, 'name'>): string {
  if (quest.status !== 'settled') return '';
  const received = quest.delivered.map((stack) => `${itemName(stack.itemId)}×${stack.count}`).join('、');
  const opening = received ? `你送来的${received}，我收好了。` : '托你办的事，办成了。';
  const thanks =
    quest.tier >= 3 ? '这份情我记牢，往后有事尽管开口。' : quest.tier === 2 ? '这份情我记着，改日必还。' : '小事一桩，也谢过。';
  return `${npc.name}留了一句：${opening}${thanks}${rewardLine(quest)}`;
}
