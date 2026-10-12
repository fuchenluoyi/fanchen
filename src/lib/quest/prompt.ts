/**
 * NPC 模式的人格与只读真相（纯函数，可单测，不需要 DOM）。
 *
 * 遵守 ADR-013：注入给模型的真相**只有 NPC 自己的视角** ——
 *   自己的背包（可用 / 已预留 + 等级与价值）、自己的委托（含状态）、
 *   道具白名单（按珍贵等级分组）、玩家对自己的好感度。
 * **绝不注入玩家背包**：东西交没交到，由裁决层在 submitQuest 时核对；
 * NPC 对"交付已发生"的认知来自委托状态变化与下面的裁决事实。
 *
 * 遵守 AC-21.5：上一轮裁决（尤其拒绝原因）作为**事实**回注，
 * 否则 NPC 会继续演"我已经收到了"。
 */
import { QUEST_ACTION_LABEL, QUEST_STATUS_LABEL } from '../labels.ts';
import { NPC_PERSONA_PROMPT, isCustomPersona } from '../settings.ts';
import type { QuestRuling } from './bridge.ts';
import {
  ABILITY_LABEL,
  ABILITY_LIST,
  OFFER_LEVEL_AFFINITY_CAP,
  OFFER_LEVEL_LABEL,
  OFFER_LEVEL_LIST,
  OFFER_LEVEL_VALUE_CAP,
  QUEST_TIER_LABEL,
  TIER_LABEL,
  TIER_LIST,
  TIER_VALUE_RANGE,
} from './constants.ts';
import { listAvailable, listHolds } from './inventory.ts';
import { getItem, itemsByTier } from './items.ts';
import { describeObjective } from './objectives.ts';
import { describeReward } from './rewards.ts';
import type { NpcState, Quest, World } from './types.ts';
import { getNpc, questsOfNpc } from './world.ts';

/** 一次最多复述多少条自己的委托（新到旧） */
const MAX_QUEST_LINES = 6;

function describeGenerosity(value: number): string {
  if (value >= 0.7) return '你出手大方，不太计较得失。';
  if (value < 0.3) return '你手头拮据，也惜物，谢礼能薄就薄。';
  return '你为人还算厚道，谢礼合乎情理即可。';
}

function renderIdentity(npc: NpcState): string {
  return [
    '【你是谁】',
    `名字：${npc.name}`,
    `身份：${npc.title}`,
    describeGenerosity(npc.generosity),
    '你在跟一位来访的玩家说话。关于"东西"，你只知道下面这些事实。',
  ].join('\n');
}

function renderOwnBag(npc: NpcState): string {
  const available = listAvailable(npc.inventory);
  const holds = listHolds(npc.inventory);
  const lines = [
    '【我自己的背包】',
    '（这是我唯一知道的关于"东西"的事实；对方口袋里有什么，你看不见，也不该去猜）',
  ];
  if (available.length === 0) {
    lines.push('可用：空 —— 你拿不出任何谢礼，这种时候不该发布委托。');
  } else {
    lines.push('可用：');
    for (const stack of available) {
      const def = getItem(stack.itemId);
      const tier = def ? TIER_LABEL[def.tier] : '未知';
      lines.push(
        `- ${def?.name ?? stack.itemId}（id: ${stack.itemId}）· ${tier} · 单价 ${def?.value ?? 0} · ×${stack.count}`,
      );
    }
  }
  if (holds.length > 0) {
    lines.push('已预留（已经答应给别人的，不能再许给第二件事）：');
    for (const hold of holds) {
      const def = getItem(hold.itemId);
      lines.push(`- ${def?.name ?? hold.itemId} ×${hold.count} ← 已许给委托 ${hold.questId}`);
    }
  }
  return lines.join('\n');
}

function renderQuestLine(quest: Quest): string {
  return [
    `- ${quest.id}「${quest.title}」`,
    `· 状态：${QUEST_STATUS_LABEL[quest.status]}`,
    `· 轻重：${QUEST_TIER_LABEL[quest.tier]}`,
    `· 目标：${describeObjective(quest.objective)}`,
    `· 谢礼：${describeReward(quest.reward)}`,
    `· 档位：${OFFER_LEVEL_LABEL[quest.offerLevel]}`,
    `· 你想要的是：${quest.want}`,
  ].join(' ');
}

function renderOwnQuests(world: World, npc: NpcState): string {
  const quests = questsOfNpc(world, npc.id).slice(-MAX_QUEST_LINES).reverse();
  const lines = ['【我手上的委托】（新到旧）'];
  if (quests.length === 0) {
    lines.push('（还没有委托。想请对方办事，先想清楚：要什么、拿什么谢他。）');
    return lines.join('\n');
  }
  for (const quest of quests) lines.push(renderQuestLine(quest));
  const hasOpen = quests.some((quest) => quest.status === 'offered' || quest.status === 'accepted');
  lines.push(hasOpen ? '其中还有没了结的委托：先把它了结，别再发新的。' : '当前没有未了结的委托。');
  return lines.join('\n');
}

function renderRelationship(world: World, npc: NpcState): string {
  const affinity = world.player.affinity[npc.id] ?? 0;
  const talks = world.player.talks[npc.id] ?? 0;
  return ['【对方与我的关系】', `好感度：${affinity}`, `累计说过：${talks} 轮话`].join('\n');
}

function renderWhitelist(): string {
  const lines = ['【可用的道具清单】（目标与谢礼只能从这里挑，id 必须原样写）'];
  for (const tier of TIER_LIST) {
    const items = itemsByTier(tier);
    if (items.length === 0) continue;
    const [min, max] = TIER_VALUE_RANGE[tier];
    const list = items.map((item) => `${item.name}(${item.id}, 值${item.value})`).join('、');
    lines.push(`${TIER_LABEL[tier]}（值 ${min}-${max}）：${list}`);
  }
  lines.push('');
  lines.push('谢礼档位上限（系统按事情轻重与你的为人算出，超了会被驳回）：');
  for (const level of OFFER_LEVEL_LIST) {
    lines.push(
      `- ${level} ${OFFER_LEVEL_LABEL[level]}：道具价值 ≤ ${OFFER_LEVEL_VALUE_CAP[level]}，好感度 ≤ +${OFFER_LEVEL_AFFINITY_CAP[level]}`,
    );
  }
  lines.push(`- 功能解锁（只允许出现在「大事」上）：${ABILITY_LIST.map((id) => `${ABILITY_LABEL[id]}(${id})`).join('、')}`);
  lines.push('- 也可以不收谢礼：reward_kind 用 none，对方会额外得到一点好感度。');
  lines.push('');
  lines.push(
    '目标只能这样写（objective_kind）：deliver_item 交付道具 / has_item 只需持有 / talk_count 陪聊轮数 / affinity_at_least 好感达标。别的目标系统判不了，会被直接驳回。',
  );
  return lines.join('\n');
}

function renderRuling(ruling: QuestRuling | null): string | null {
  if (!ruling) return null;
  const suffix = ruling.questId ? ` ${ruling.questId}` : '';
  if (ruling.ok) {
    return [
      '【上一轮系统裁决】',
      `- 结果：确认通过（${QUEST_ACTION_LABEL[ruling.action]}${suffix}）`,
      ...ruling.applied.map((line) => `- ${line}`),
      '- 含义：**这些是已经发生的事实**，你可以据此说话 —— 但只限于上面写明的部分。',
    ].join('\n');
  }
  return [
    '【上一轮系统裁决】',
    `- 结果：拒绝（${QUEST_ACTION_LABEL[ruling.action]}${suffix}）`,
    `- 原因码：${ruling.code ?? 'unknown'}`,
    `- 系统说明：${ruling.message}`,
    '- 含义：**这件事没有发生。**若被拒的是交付，那就意味着对方并没有把东西交到你手上：',
    '  绝不要道谢、不要说"我收下了"，也不要假装已经收到。你可以疑惑、可以追问，但事实以系统为准。',
  ].join('\n');
}

/**
 * 组装 npc 模式的 system 提示词。
 *
 * @param world 世界状态（只读）
 * @param npcId 这次由谁出面
 * @param lastRuling 上一轮的系统裁决（AC-21.5 的事实回注），没有就传 null
 * @param customPersona 用户自己写的人格（只在确实自定义过时才追加）
 */
export function buildNpcSystemPrompt(
  world: World,
  npcId: string,
  lastRuling: QuestRuling | null = null,
  customPersona = '',
): string {
  const npc = getNpc(world, npcId);
  if (!npc) {
    return [
      NPC_PERSONA_PROMPT,
      '【注意】系统里找不到你要扮演的这位 NPC。只做普通寒暄，不要发布任何委托，也不要声称自己有什么东西。',
    ].join('\n\n');
  }
  const sections = [
    NPC_PERSONA_PROMPT,
    renderIdentity(npc),
    renderOwnBag(npc),
    renderOwnQuests(world, npc),
    renderRelationship(world, npc),
    renderWhitelist(),
  ];
  const ruling = renderRuling(lastRuling);
  if (ruling) sections.push(ruling);
  if (isCustomPersona(customPersona)) {
    sections.push(`【额外人格补充】（用户手写，与上面的人设一并遵守）\n${customPersona.trim()}`);
  }
  return sections.join('\n\n');
}
