/**
 * 前端接线的纯逻辑单测（不需要 DOM / 浏览器）：
 *   1. 设置：默认走 npc 模式，脏值回退，desk 模式的人格路径一字不变
 *   2. 提示词：只注入 NPC 自己的视角（ADR-013），并把上一轮裁决当事实回注（AC-21.5）
 *   3. 存档容错：脏数据回到开局，绝不让页面白屏
 *   4. 事件 → 裁决的接线（含原子性、预留锁、npcId 由客户端决定）
 *   5. 客户端二次收敛：结构不对的服务端事件直接丢弃
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeServerEvent, sanitizeQuestProposal } from '../src/lib/api.ts';
import type { QuestProposalDraft, QuestRuling } from '../src/lib/quest/bridge.ts';
import { applyPlayerAccept, applyQuestEvent } from '../src/lib/quest/bridge.ts';
import { availableOf, auditInventory, totalOf } from '../src/lib/quest/inventory.ts';
import { normalizeStoredWorld } from '../src/lib/quest/persist.ts';
import { buildNpcSystemPrompt } from '../src/lib/quest/prompt.ts';
import { auditWorld, createWorld, getNpc, getQuest, worldTotalOf } from '../src/lib/quest/world.ts';
import { proposeQuest } from '../src/lib/quest/adjudicate.ts';
import {
  DEFAULT_QUEST_NPC_ID,
  DEFAULT_SETTINGS,
  DEFAULT_SYSTEM_PROMPT,
  buildRequestMessages,
  isCustomPersona,
  normalizeSettings,
  npcPersonaDraft,
} from '../src/lib/settings.ts';
import type { ChatMode } from '../src/types.ts';

/** 一条合法的模型提案（NPC 旧疾求药） */
function proposal(overrides: Partial<QuestProposalDraft> = {}): QuestProposalDraft {
  return {
    title: '寻一味三七',
    want: '我旧疾复发，需一味三七入药',
    tier: 2,
    objective: { kind: 'deliver_item', itemId: 'sanqi', count: 1 },
    reward: { kind: 'item', itemId: 'jinchuang-gao', count: 1 },
    ...overrides,
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/* ============================ 设置与模式 ============================ */

describe('设置：对话模式与出面 NPC', () => {
  it('默认走 npc 模式（刷新就能看见委托功能）', () => {
    assert.equal(DEFAULT_SETTINGS.chatMode, 'npc');
    assert.equal(DEFAULT_SETTINGS.questNpcId, DEFAULT_QUEST_NPC_ID);
    assert.equal(normalizeSettings({}).chatMode, 'npc');
  });

  it('脏值回退：模式与 NPC 都必须落在白名单里', () => {
    assert.equal(normalizeSettings({ chatMode: 'desk' }).chatMode, 'desk');
    assert.equal(normalizeSettings({ chatMode: '乱写' }).chatMode, 'npc');
    assert.equal(normalizeSettings({ chatMode: 42 }).chatMode, 'npc');
    assert.equal(normalizeSettings({ questNpcId: 'a-lai' }).questNpcId, 'a-lai');
    assert.equal(normalizeSettings({ questNpcId: '不存在的人' }).questNpcId, DEFAULT_QUEST_NPC_ID);
    assert.equal(normalizeSettings({ questNpcId: '' }).questNpcId, DEFAULT_QUEST_NPC_ID);
  });

  it('desk 模式的人格路径一字不变：不传 override 时仍然用设置里的 systemPrompt', () => {
    const messages = buildRequestMessages({ ...DEFAULT_SETTINGS, systemPrompt: '说书人' }, [
      { role: 'user', content: '你好' },
    ]);
    assert.equal(messages[0].role, 'system');
    assert.equal(messages[0].content, '说书人');
  });

  it('npc 模式用动态人格覆盖 system', () => {
    const messages = buildRequestMessages(
      { ...DEFAULT_SETTINGS, systemPrompt: '说书人' },
      [{ role: 'user', content: '你好' }],
      'NPC 框架',
    );
    assert.equal(messages[0].content, 'NPC 框架');
  });

  it('人格框显示什么 = 会不会真的被追加（同一个判据）', () => {
    // 与 SettingsDialog 里 textarea 的 value 表达式同形，判据共用 npcPersonaDraft
    const shownInDialog = (chatMode: ChatMode, systemPrompt: string): string =>
      chatMode === 'npc' ? npcPersonaDraft(systemPrompt) : systemPrompt;

    // 老用户 localStorage 里存着默认那段「说书人」人格：判否 → 框里显示空（不会"看似生效其实被跳过"）
    assert.equal(isCustomPersona(DEFAULT_SETTINGS.systemPrompt), false);
    assert.equal(shownInDialog('npc', DEFAULT_SETTINGS.systemPrompt), '');
    // 「恢复全部默认值」之后 systemPrompt === DEFAULT_SYSTEM_PROMPT → 同样显示为空
    assert.equal(shownInDialog('npc', DEFAULT_SYSTEM_PROMPT), '');
    // 只有空白也算没自定义
    assert.equal(shownInDialog('npc', '   '), '');
    // 手写过的原样显示
    assert.equal(shownInDialog('npc', '你说话带点川音。'), '你说话带点川音。');
    // desk 模式一字不改
    assert.equal(shownInDialog('desk', DEFAULT_SETTINGS.systemPrompt), DEFAULT_SYSTEM_PROMPT);
    assert.equal(shownInDialog('desk', ''), '');

    // 闭环：框里显示为空 ⇒ 提示词里确实没有「额外人格补充」
    const world = createWorld();
    assert.doesNotMatch(
      buildNpcSystemPrompt(world, 'su-wanzhao', null, shownInDialog('npc', DEFAULT_SETTINGS.systemPrompt)),
      /额外人格补充/,
    );
    assert.match(
      buildNpcSystemPrompt(world, 'su-wanzhao', null, shownInDialog('npc', '你说话带点川音。')),
      /额外人格补充[\s\S]*川音/,
    );
  });
});

/* ========================= 提示词：NPC 视角 ========================= */

describe('npc 提示词：只给 NPC 自己的视角（ADR-013）', () => {
  it('写清 NPC 是谁、它的背包、它的关系', () => {
    const world = createWorld();
    const prompt = buildNpcSystemPrompt(world, 'su-wanzhao', null);
    assert.match(prompt, /苏晚照/);
    assert.match(prompt, /药庐女医/);
    assert.match(prompt, /我自己的背包/);
    assert.match(prompt, /三七（id: sanqi）· 上品 · 单价 45 · ×2/);
    assert.match(prompt, /对方与我的关系/);
    assert.match(prompt, /好感度：0/);
  });

  it('**不含玩家背包**：玩家独有的数量不会出现在提示词里', () => {
    // 玩家手握 5 份清水；苏晚照背包里没有清水
    const world = createWorld({ playerInventory: [{ itemId: 'water', count: 5 }] });
    const prompt = buildNpcSystemPrompt(world, 'su-wanzhao', null);
    assert.doesNotMatch(prompt, /玩家背包|对方背包|对方的背包/);
    assert.doesNotMatch(prompt, /行客/); // 连玩家名字都不给它
    assert.doesNotMatch(prompt, /清水[^\n]*[×x]\s*5/); // 背包区不会列出玩家的持有量
  });

  it('道具白名单按珍贵等级分组，id 与价值都在，模型能挑合法 id', () => {
    const prompt = buildNpcSystemPrompt(createWorld(), 'su-wanzhao', null);
    assert.match(prompt, /凡品（值 1-5）：/);
    assert.match(prompt, /上品（值 21-80）：/);
    assert.match(prompt, /三七\(sanqi, 值45\)/);
    assert.match(prompt, /绝品（值 301-1000）：/);
    assert.match(prompt, /结缘\(jieyuan\)/);
  });

  it('自己的委托（含目标 / 谢礼 / 档位 / 预留锁）会被复述', () => {
    const proposed = proposeQuest(createWorld(), {
      requestId: 'req-1',
      npcId: 'su-wanzhao',
      now: 1000,
      ...proposal(),
    });
    assert.equal(proposed.ok, true);
    if (!proposed.ok) return;
    const prompt = buildNpcSystemPrompt(proposed.world, 'su-wanzhao', null);
    assert.match(prompt, /我手上的委托/);
    assert.match(prompt, /quest-1「寻一味三七」/);
    assert.match(prompt, /状态：已发布/);
    assert.match(prompt, /轻重：正事/);
    assert.match(prompt, /目标：交付「三七」×1/);
    assert.match(prompt, /谢礼：「金疮药」×1/);
    assert.match(prompt, /档位：中酬/);
    assert.match(prompt, /已许给委托 quest-1/);
  });

  it('背包空的 NPC：说清它拿不出谢礼，别发委托', () => {
    const prompt = buildNpcSystemPrompt(createWorld(), 'a-lai', null);
    assert.match(prompt, /阿癞/);
    assert.match(prompt, /拿不出任何谢礼/);
  });

  it('找不到这位 NPC 时不注入任何背包事实', () => {
    const prompt = buildNpcSystemPrompt(createWorld(), '查无此人', null);
    assert.match(prompt, /找不到/);
    assert.doesNotMatch(prompt, /我自己的背包/);
  });

  it('手写人格只在确实自定义过时才追加', () => {
    const world = createWorld();
    assert.doesNotMatch(buildNpcSystemPrompt(world, 'su-wanzhao', null, DEFAULT_SYSTEM_PROMPT), /额外人格补充/);
    assert.doesNotMatch(buildNpcSystemPrompt(world, 'su-wanzhao', null, '   '), /额外人格补充/);
    assert.match(buildNpcSystemPrompt(world, 'su-wanzhao', null, '你说话带点川音。'), /额外人格补充[\s\S]*川音/);
  });
});

/* ====================== 提示词：裁决事实回注 ====================== */

describe('npc 提示词：上一轮裁决作为事实回注（AC-21.5）', () => {
  it('被拒的交付：明确告诉它"东西没交到你手上，不许道谢"', () => {
    const ruling: QuestRuling = {
      ok: false,
      action: 'submit_quest',
      questId: 'quest-1',
      code: 'player_item_insufficient',
      message: '玩家只有 1 份「三七」，需要 2 份',
      applied: [],
      at: 2000,
    };
    const prompt = buildNpcSystemPrompt(createWorld(), 'su-wanzhao', ruling);
    assert.match(prompt, /上一轮系统裁决/);
    assert.match(prompt, /结果：拒绝（交付结算 quest-1）/);
    assert.match(prompt, /原因码：player_item_insufficient/);
    assert.match(prompt, /玩家只有 1 份「三七」，需要 2 份/);
    assert.match(prompt, /并没有把东西交到你手上/);
    assert.match(prompt, /绝不要道谢/);
  });

  it('通过的裁决：说清哪些是已经发生的事实', () => {
    const ruling: QuestRuling = {
      ok: true,
      action: 'submit_quest',
      questId: 'quest-1',
      code: null,
      message: '交付：「三七」×1 由玩家转移给 苏晚照',
      applied: ['交付：「三七」×1 由玩家转移给 苏晚照', '发放奖励：「金疮药」×1（值 12，fine）'],
      at: 3000,
    };
    const prompt = buildNpcSystemPrompt(createWorld(), 'su-wanzhao', ruling);
    assert.match(prompt, /结果：确认通过（交付结算 quest-1）/);
    assert.match(prompt, /发放奖励：「金疮药」×1/);
    assert.match(prompt, /已经发生的事实/);
  });

  it('没有裁决事实时不出现这一节', () => {
    assert.doesNotMatch(buildNpcSystemPrompt(createWorld(), 'su-wanzhao', null), /上一轮系统裁决/);
  });
});

/* ============================ 存档容错 ============================ */

describe('世界存档容错：脏数据不得白屏', () => {
  it('各种垃圾输入都回到开局世界，且不抛错', () => {
    const garbage: unknown[] = [null, undefined, 0, 42, 'x', [], {}, { player: 'nope' }, { quests: 5 }, { npcs: [] }];
    for (const raw of garbage) {
      const world = normalizeStoredWorld(raw);
      assert.equal(Object.keys(world.quests).length, 0);
      assert.ok(getNpc(world, 'su-wanzhao'));
      assert.deepEqual(auditWorld(world), []);
    }
  });

  it('合法存档原样恢复（背包 / 预留 / 委托 / 事件 / 幂等记录）', () => {
    const proposed = proposeQuest(createWorld(), {
      requestId: 'req-1',
      npcId: 'su-wanzhao',
      sourceDialogueId: 'msg-1',
      now: 1000,
      ...proposal(),
    });
    assert.equal(proposed.ok, true);
    if (!proposed.ok) return;
    const restored = normalizeStoredWorld(clone(proposed.world));
    assert.deepEqual(restored, clone(proposed.world));
    assert.equal(getNpc(restored, 'su-wanzhao')?.inventory.holds.length, 1);
    assert.equal(availableOf(getNpc(restored, 'su-wanzhao')!.inventory, 'jinchuang-gao'), 1);
    assert.equal(getQuest(restored, 'quest-1')?.provenance.sourceDialogueId, 'msg-1');
  });

  it('结构有问题的预留被丢弃，合法预留照常恢复（可用 + 预留 = 拥有量）', () => {
    const restored = normalizeStoredWorld({
      player: { inventory: { stacks: [{ itemId: 'sanqi', count: 1 }], holds: [] } },
      npcs: {
        'su-wanzhao': {
          inventory: {
            stacks: [{ itemId: 'sanqi', count: 1 }],
            holds: [
              { id: 'hold-1', questId: 'quest-1', itemId: 'sanqi', count: 1, createdAt: 1 }, // 合法
              { id: 'hold-2', questId: 'quest-2', itemId: '没这件', count: 1, createdAt: 1 }, // 未登记 → 丢
              { id: 'hold-3', itemId: 'sanqi', count: 1, createdAt: 1 }, // 缺 questId → 丢
              { id: 'hold-1', questId: 'quest-4', itemId: 'sanqi', count: 1, createdAt: 1 }, // id 重复 → 丢
              { id: 'hold-5', questId: 'quest-5', itemId: 'sanqi', count: 0, createdAt: 1 }, // 数量非正 → 丢
            ],
          },
        },
      },
    });
    const inventory = getNpc(restored, 'su-wanzhao')!.inventory;
    assert.equal(inventory.holds.length, 1);
    assert.equal(inventory.holds[0].id, 'hold-1');
    assert.equal(availableOf(inventory, 'sanqi'), 1); // stacks 记的是可用
    assert.equal(totalOf(inventory, 'sanqi'), 2); // 可用 1 + 预留 1
    assert.deepEqual(auditInventory(inventory), []);
  });

  it('道具奖励的委托若丢了预留锁，整条丢掉（否则永远无法完成）', () => {
    const proposed = proposeQuest(createWorld(), { requestId: 'req-1', npcId: 'su-wanzhao', now: 1, ...proposal() });
    assert.equal(proposed.ok, true);
    if (!proposed.ok) return;
    const broken = clone(proposed.world) as unknown as {
      npcs: Record<string, { inventory: { holds?: unknown } }>;
    };
    delete broken.npcs['su-wanzhao'].inventory.holds;
    const restored = normalizeStoredWorld(broken);
    assert.equal(Object.keys(restored.quests).length, 0);
    assert.equal(restored.questOrder.length, 0);
  });

  it('自增序号不会与已有 id 撞车', () => {
    const proposed = proposeQuest(createWorld(), { requestId: 'req-1', npcId: 'su-wanzhao', now: 1, ...proposal() });
    assert.equal(proposed.ok, true);
    if (!proposed.ok) return;
    const stale = clone(proposed.world) as unknown as { seq: { quest: number; hold: number; event: number } };
    stale.seq = { quest: 0, hold: 0, event: 0 };
    const restored = normalizeStoredWorld(stale);
    assert.ok(restored.seq.quest >= 1, '序号必须大于已恢复的任务 id');
    assert.ok(restored.seq.hold >= 1);
    assert.ok(restored.seq.event >= 2);
  });
});

/* ========================= 事件 → 裁决接线 ========================= */

describe('事件 → 裁决接线', () => {
  it('提案事件：世界真的变了，奖励被预留，溯源记下这次对话', () => {
    const world = createWorld();
    const outcome = applyQuestEvent(world, { type: 'quest_proposal', proposal: proposal() }, {
      npcId: 'su-wanzhao',
      requestId: 'req-1',
      dialogueId: 'msg-9',
      now: 1000,
    });
    assert.equal(outcome.ruling.ok, true);
    assert.equal(outcome.ruling.action, 'propose_quest');
    assert.equal(outcome.ruling.code, null);
    const quest = getQuest(outcome.world, 'quest-1');
    assert.ok(quest);
    assert.equal(quest.requesterId, 'su-wanzhao');
    assert.equal(quest.status, 'offered');
    assert.equal(quest.provenance.sourceDialogueId, 'msg-9');
    assert.equal(quest.provenance.draftedBy, 'dialogue');
    assert.equal(getNpc(outcome.world, 'su-wanzhao')?.inventory.holds.length, 1);
    // 入参世界不被修改（领域层的原子性）
    assert.equal(getQuest(world, 'quest-1'), null);
  });

  it('出面的人由客户端决定：模型塞进来的 npcId 不作数', () => {
    const sneaky = { ...proposal(), npcId: 'lu-xingzhou' } as QuestProposalDraft;
    const outcome = applyQuestEvent(createWorld(), { type: 'quest_proposal', proposal: sneaky }, {
      npcId: 'su-wanzhao',
      requestId: 'req-1',
      dialogueId: null,
      now: 1,
    });
    assert.equal(outcome.ruling.ok, true);
    assert.equal(getQuest(outcome.world, outcome.ruling.questId ?? '')?.requesterId, 'su-wanzhao');
  });

  it('非法提案变成一条可读的拒绝事实，而不是崩溃', () => {
    const bad = { ...proposal(), tier: 9 } as unknown as QuestProposalDraft;
    const outcome = applyQuestEvent(createWorld(), { type: 'quest_proposal', proposal: bad }, {
      npcId: 'su-wanzhao',
      requestId: 'req-1',
      dialogueId: null,
      now: 1,
    });
    assert.equal(outcome.ruling.ok, false);
    assert.equal(outcome.ruling.code, 'invalid_tier');
    assert.ok(outcome.ruling.message.length > 0);
  });

  it('交付成功：道具转移 + 预留核销 + 资源守恒', () => {
    const world = createWorld({ playerInventory: [{ itemId: 'sanqi', count: 2 }] });
    const sanqiBefore = worldTotalOf(world, 'sanqi');

    const proposed = applyQuestEvent(world, { type: 'quest_proposal', proposal: proposal() }, {
      npcId: 'su-wanzhao',
      requestId: 'req-1',
      dialogueId: 'msg-1',
      now: 1,
    });
    const questId = proposed.ruling.questId ?? '';
    const accepted = applyPlayerAccept(proposed.world, { questId, requestId: 'req-2', now: 2 });
    assert.equal(accepted.ruling.ok, true);

    const settled = applyQuestEvent(
      accepted.world,
      { type: 'quest_submit', submission: { questId, deliver: { itemId: 'sanqi', count: 1 } } },
      { npcId: 'su-wanzhao', requestId: 'req-3', dialogueId: 'msg-2', now: 3 },
    );
    assert.equal(settled.ruling.ok, true);
    assert.equal(getQuest(settled.world, questId)?.status, 'settled');
    assert.equal(availableOf(settled.world.player.inventory, 'sanqi'), 1);
    assert.equal(availableOf(settled.world.player.inventory, 'jinchuang-gao'), 1);
    assert.equal(getNpc(settled.world, 'su-wanzhao')?.inventory.holds.length, 0);
    assert.equal(worldTotalOf(settled.world, 'sanqi'), sanqiBefore);
    assert.deepEqual(auditWorld(settled.world), []);
  });

  it('交付被拒：给出原因码，且世界与入参是同一个引用（原子性）', () => {
    const world = createWorld(); // 玩家只有 1 份三七
    const proposed = applyQuestEvent(
      world,
      { type: 'quest_proposal', proposal: proposal({ objective: { kind: 'deliver_item', itemId: 'sanqi', count: 2 } }) },
      { npcId: 'su-wanzhao', requestId: 'req-1', dialogueId: null, now: 1 },
    );
    const questId = proposed.ruling.questId ?? '';
    const accepted = applyPlayerAccept(proposed.world, { questId, requestId: 'req-2', now: 2 });

    const before = JSON.stringify(accepted.world);
    const failed = applyQuestEvent(
      accepted.world,
      { type: 'quest_submit', submission: { questId, deliver: { itemId: 'sanqi', count: 2 } } },
      { npcId: 'su-wanzhao', requestId: 'req-3', dialogueId: null, now: 3 },
    );
    assert.equal(failed.ruling.ok, false);
    assert.equal(failed.ruling.code, 'player_item_insufficient');
    assert.match(failed.ruling.message, /三七/);
    assert.equal(failed.world, accepted.world);
    assert.equal(JSON.stringify(failed.world), before);
  });

  it('婉拒事件：释放预留，委托转为已婉拒', () => {
    const world = createWorld();
    const proposed = applyQuestEvent(world, { type: 'quest_proposal', proposal: proposal() }, {
      npcId: 'su-wanzhao',
      requestId: 'req-1',
      dialogueId: null,
      now: 1,
    });
    const questId = proposed.ruling.questId ?? '';
    const declined = applyQuestEvent(
      proposed.world,
      { type: 'quest_decline', decline: { questId, reason: '我不接' } },
      { npcId: 'su-wanzhao', requestId: 'req-2', dialogueId: null, now: 2 },
    );
    assert.equal(declined.ruling.ok, true);
    assert.equal(getQuest(declined.world, questId)?.status, 'declined');
    assert.equal(getNpc(declined.world, 'su-wanzhao')?.inventory.holds.length, 0);
    assert.equal(availableOf(getNpc(declined.world, 'su-wanzhao')!.inventory, 'jinchuang-gao'), 2);
    assert.ok(declined.ruling.applied.some((line) => line.includes('释放预留')));
  });

  it('玩家在界面上接取：走裁决层，失败也有可读原因', () => {
    const world = createWorld();
    const proposed = applyQuestEvent(world, { type: 'quest_proposal', proposal: proposal() }, {
      npcId: 'su-wanzhao',
      requestId: 'req-1',
      dialogueId: null,
      now: 1,
    });
    const questId = proposed.ruling.questId ?? '';
    const accepted = applyPlayerAccept(proposed.world, { questId, requestId: 'req-2', now: 2 });
    assert.equal(accepted.ruling.ok, true);
    assert.equal(getQuest(accepted.world, questId)?.status, 'accepted');

    // 再点一次同一个委托：状态已经变了，必须拒绝而不是静默成功
    const again = applyPlayerAccept(accepted.world, { questId, requestId: 'req-3', now: 3 });
    assert.equal(again.ruling.ok, false);
    assert.equal(again.ruling.code, 'quest_not_offered');
  });
});

/* ====================== 客户端二次收敛（纵深防御） ====================== */

describe('客户端事件收敛', () => {
  it('形状不对的提案进不了世界', () => {
    assert.equal(sanitizeQuestProposal(null), null);
    assert.equal(sanitizeQuestProposal({ title: 'x' }), null);
    assert.equal(
      sanitizeQuestProposal({ title: '', want: 'w', objective: { kind: 'deliver_item' }, reward: { kind: 'none' } }),
      null,
    );
    assert.equal(
      sanitizeQuestProposal({ title: 't', want: 'w', objective: { kind: '瞎编' }, reward: { kind: 'none' } }),
      null,
    );
    assert.equal(
      sanitizeQuestProposal({ title: 't', want: 'w', objective: { kind: 'has_item' }, reward: { kind: '瞎编' } }),
      null,
    );
    const ok = sanitizeQuestProposal({
      title: ' 寻药 ',
      want: ' 想要三七 ',
      tier: 2,
      objective: { kind: 'deliver_item', itemId: 'sanqi', count: 1 },
      reward: { kind: 'none' },
    });
    assert.equal(ok?.title, '寻药');
    assert.equal(ok?.want, '想要三七');
  });

  it('结构不对的服务端事件被丢弃，合法事件原样通过', () => {
    assert.equal(normalizeServerEvent(null), null);
    assert.equal(normalizeServerEvent('x'), null);
    assert.equal(normalizeServerEvent({ type: '没有这种事件' }), null);
    assert.equal(normalizeServerEvent({ type: 'delta' }), null);
    assert.deepEqual(normalizeServerEvent({ type: 'done' }), { type: 'done' });
    assert.deepEqual(normalizeServerEvent({ type: 'delta', text: '在' }), { type: 'delta', text: '在' });
    const event = normalizeServerEvent({
      type: 'quest_proposal',
      index: 0,
      proposal: {
        title: 't',
        want: 'w',
        tier: 1,
        objective: { kind: 'has_item', itemId: 'gancao', count: 1 },
        reward: { kind: 'none' },
      },
    });
    assert.equal(event?.type, 'quest_proposal');
    assert.equal(normalizeServerEvent({ type: 'quest_proposal', proposal: { title: 'x' } }), null);
  });
});
