/**
 * NPC 模式的人格与只读真相（纯函数，可单测，不需要 DOM）。
 *
 * 遵守 ADR-013：注入给模型的真相**只有 NPC 自己的视角** ——
 *   自己的背包（可用 / 已预留 + 等级与价值 + 她怎么看这些东西）、自己的委托（含状态）、
 *   道具白名单（按珍贵等级与用途分组）、玩家对自己的好感度与关系阶段。
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
  IMPRESSION_COOLDOWN_ROUNDS,
  OFFER_LEVEL_AFFINITY_CAP,
  OFFER_LEVEL_LABEL,
  OFFER_LEVEL_LIST,
  QUEST_TIER_LABEL,
  TIER_LABEL,
  TIER_LIST,
  TIER_VALUE_RANGE,
} from './constants.ts';
import { listAvailable, listHolds } from './inventory.ts';
import { getItem, itemName, itemsByTier } from './items.ts';
import { describeObjective } from './objectives.ts';
import { STAGES, describeAttitude, peakStageOf, progressToNextStage } from './relationship.ts';
import { describeReward } from './rewards.ts';
import type { NpcState, Quest, World } from './types.ts';
import { cherishedItems, getNpc, itemBiasFor, questsOfNpc, spareItems } from './world.ts';

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
      const bias = itemBiasFor(npc, stack.itemId);
      const mark = bias === 'cherished' ? ' · 我舍不得给' : bias === 'spare' ? ' · 我留着没用' : '';
      lines.push(
        `- ${def?.name ?? stack.itemId}（id: ${stack.itemId}）· ${tier} · 单价 ${def?.value ?? 0} · ×${stack.count}${mark}`,
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

/** 她的偏好：用途、舍不得给的、多余的、爱听与忌讳（**只影响说话与取舍，不是规则**） */
function renderTastes(npc: NpcState): string {
  const cherished = cherishedItems(npc);
  const spares = spareItems(npc);
  const lines = [
    '【我的偏好】',
    `我在意的用途：${npc.wantsUses.length > 0 ? npc.wantsUses.join('、') : '（没有特别的）'}`,
    cherished.length > 0
      ? `我舍不得给的：${cherished.map((item) => item.name).join('、')}（拿这些出去换，我会肉疼）`
      : '我舍不得给的：（眼下没有）',
    spares.length > 0
      ? `我留着没用的：${spares.map((item) => item.name).join('、')}（拿这些去换正合适）`
      : '我留着没用的：（眼下没有）',
  ];
  if (npc.likes.length > 0) lines.push(`我爱听的、在意的：${npc.likes.join('；')}`);
  if (npc.dislikes.length > 0) lines.push(`我忌讳的：${npc.dislikes.join('；')}`);
  lines.push('（这些只决定你怎么说话、愿意把什么拿出来换 —— 系统**不会**因为"我舍不得"就驳回你的提议。）');
  return lines.join('\n');
}

function renderQuestLine(quest: Quest): string {
  const lines = [
    `- ${quest.id}「${quest.title}」`,
    `· 状态：${QUEST_STATUS_LABEL[quest.status]}`,
    `· 轻重：${QUEST_TIER_LABEL[quest.tier]}`,
    `· 目标：${describeObjective(quest.objective)}`,
    `· 谢礼：${describeReward(quest.reward)}`,
    `· 档位：${OFFER_LEVEL_LABEL[quest.offerLevel]}`,
    `· 你想要的是：${quest.want}`,
  ];
  // 交付事实必须**现算**：Quest.delivered 是「道具真的被扣掉那一刻」的落库记录。
  // 只靠 lastRuling 回注会过期 —— 上一轮交付过、这一轮 NPC 就"忘了自己收过"。
  if (quest.delivered.length > 0) {
    const received = quest.delivered.map((entry) => `${itemName(entry.itemId)} ×${entry.count}`).join('、');
    lines.push(`· 已经收到的货：${received}（已入我手，不必再向对方讨要）`);
  }
  if (quest.status === 'settled') {
    lines.push(
      '· **这条委托已经了结**：对方该交的你已经收到、你答应的谢礼也已经给出。' +
        '绝不能再让他交付一次，也不要问「东西呢」「我还没见着」—— 那是没发生过的事。',
    );
  }
  return lines.join(' ');
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
  const peak = world.player.stagePeak[npc.id];
  const stage = peakStageOf(affinity, peak);
  const progress = progressToNextStage(affinity, peak);
  const index = STAGES.findIndex((entry) => entry.id === progress.stage);
  const nextLabel = index >= 0 && index + 1 < STAGES.length ? STAGES[index + 1].label : null;

  const lines = [
    '【对方与我的关系】',
    progress.nextThreshold === null || nextLabel === null
      ? `你们的关系：${progress.label}（好感度 ${affinity}，已经是顶了）`
      : `你们的关系：${progress.label}（好感度 ${affinity}，距「${nextLabel}」还差 ${progress.toNext}）`,
    `累计说过：${talks} 轮话`,
    describeAttitude(stage, npc),
    '（关系只决定你说话的亲疏。事情能不能开口与阶段无关：低阶段也可以托付大事，只是别指望对方一口答应。）',
  ];
  return lines.join('\n');
}

function renderWhitelist(): string {
  const lines = [
    '【道具 id 拼写表】（**只是抄 id 用的字典**，不是"你能拿出来的东西"清单 —— 你能不能给，只看【我自己的背包】）',
  ];
  for (const tier of TIER_LIST) {
    const items = itemsByTier(tier);
    if (items.length === 0) continue;
    const [min, max] = TIER_VALUE_RANGE[tier];
    const list = items
      .map((item) => `${item.name}(${item.id}, 值${item.value}，用途${item.uses.join('/')})`)
      .join('、');
    lines.push(`${TIER_LABEL[tier]}（值 ${min}-${max}）：${list}`);
  }
  lines.push('');
  lines.push('谢礼的规矩（档位由系统按事情轻重与你的为人算，**你不用自报档位**）：');
  lines.push('- 道具：**没有价值上限**，只要是你背包里拿得出的、且没被别的委托预留就行（背包即上限）。');
  for (const level of OFFER_LEVEL_LIST) {
    lines.push(`- 好感度：${level} ${OFFER_LEVEL_LABEL[level]} 档最多 +${OFFER_LEVEL_AFFINITY_CAP[level]}（好感度没有守恒，所以要设上限）`);
  }
  lines.push(`- 功能解锁（只允许出现在「大事」上）：${ABILITY_LIST.map((id) => `${ABILITY_LABEL[id]}(${id})`).join('、')}`);
  lines.push('- 也可以不收谢礼：reward_kind 用 none，对方会额外得到一点好感度。');
  lines.push('');
  lines.push(
    '目标只能这样写（objective_kind）：deliver_item 交付道具 / has_item 只需持有 / talk_count 陪聊轮数 / affinity_at_least 好感达标。别的目标系统判不了，会被直接驳回。',
  );
  return lines.join('\n');
}

/**
 * 「我能拿出的谢礼」：从**自己的背包**现算，模型引用的奖励必须命中这里。
 * 白名单（32 件全表）只是抄 id 的字典 —— 苏晚照许诺"竹哨"那次，就是模型把它当菜单了。
 */
export function buildRewardMenu(npc: NpcState): string {
  const available = listAvailable(npc.inventory);
  const lines = ['【我能拿出的谢礼】（只有这些能用；表外的你没有，提都别提）'];
  if (available.length === 0) {
    lines.push('（一件也拿不出来 —— 这一轮不要提谢礼，也别发布委托。）');
    return lines.join('\n');
  }
  for (const stack of available) {
    const def = getItem(stack.itemId);
    lines.push(`- ${def?.name ?? stack.itemId}（id: ${stack.itemId}）×${stack.count}`);
  }
  lines.push('（本次委托**所要之物**不能当谢礼，那会被判成自循环；要的与给的是同一件时，换别的，或者干脆不收谢礼。）');
  lines.push(
    '除了这些道具，也可以：给好感度（reward_kind=affinity）、教本事（ability，只限大事）、说一桩情报（info）、或者不收谢礼（none）。',
  );
  return lines.join('\n');
}

/** 印象工具的用法（好感度的涨法） */
function renderImpressionGuide(): string {
  return [
    '【怎么让我对你更有好感（note_impression）】',
    '判断这一轮对方说的话：',
    '- pleased：说到你心坎里、正合你在意的事（+2 好感度）',
    '- neutral：不咸不淡（不加不减，通常不必调用）',
    '- offended：踩了你的忌讳（-1 好感度；**这一条不受冷却限制**，说错话立刻有代价）',
    `同一套恭维第二次不再新鲜：同一件事反复夸，系统会按冷却驳回（每 ${IMPRESSION_COOLDOWN_ROUNDS} 轮最多因印象涨一次），别白白浪费工具调用。`,
    '调用时把缘由写进 reason（一两句），那是你自己心里的记账。',
  ].join('\n');
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
  const lines = [
    '【上一轮系统裁决】',
    `- 结果：拒绝（${QUEST_ACTION_LABEL[ruling.action]}${suffix}）`,
    `- 原因码：${ruling.code ?? 'unknown'}`,
    `- 系统说明：${ruling.message}`,
    '- 含义：**这件事没有发生。**若被拒的是交付，那就意味着对方并没有把东西交到你手上：',
    '  绝不要道谢、不要说"我收下了"，也不要假装已经收到。你可以疑惑、可以追问，但事实以系统为准。',
  ];
  // 奖励被拒时给一条**可执行**的指引：否则她会反复重复那句拿不出来的承诺
  if (ruling.code === 'reward_not_owned' || ruling.code === 'npc_reward_unavailable') {
    lines.push(
      '- 怎么改：上面那件谢礼你拿不出来，或者已经被别的委托占住了。',
      '  换一件【我能拿出的谢礼】里有的，**重新调用一次 propose_quest**；不要再重复刚才那句承诺，也不要假装已经许出去了。',
    );
  }
  return lines.join('\n');
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
    buildRewardMenu(npc),
    renderTastes(npc),
    renderOwnQuests(world, npc),
    renderRelationship(world, npc),
    renderWhitelist(),
    renderImpressionGuide(),
  ];
  const ruling = renderRuling(lastRuling);
  if (ruling) sections.push(ruling);
  if (isCustomPersona(customPersona)) {
    sections.push(`【额外人格补充】（用户手写，与上面的人设一并遵守）\n${customPersona.trim()}`);
  }
  return sections.join('\n\n');
}
