/**
 * 前端接线的纯逻辑单测（不需要 DOM / 浏览器）：
 *   1. 设置：默认走 npc 模式，脏值回退，desk 模式的人格路径一字不变
 *   2. 提示词：只注入 NPC 自己的视角（ADR-013），并把上一轮裁决当事实回注（AC-21.5）
 *   3. 存档容错：脏数据回到开局，绝不让页面白屏
 *   4. 事件 → 裁决的接线（含原子性、预留锁、npcId 由客户端决定）
 *   5. 客户端二次收敛：结构不对的服务端事件直接丢弃
 *   6. 玩家在界面上交付/完成委托（走裁决层，拒绝码 → 玩家侧文案）
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeServerEvent, sanitizeQuestProposal } from '../src/lib/api.ts';
import type { QuestProposalDraft, QuestRuling } from '../src/lib/quest/bridge.ts';
import { applyPlayerAccept, applyPlayerGift, applyPlayerRestock, applyPlayerSubmit, applyQuestEvent } from '../src/lib/quest/bridge.ts';
import { availableOf, auditInventory, totalOf } from '../src/lib/quest/inventory.ts';
import { ITEM_LIST } from '../src/lib/quest/items.ts';
import { normalizeStoredWorld } from '../src/lib/quest/persist.ts';
import { buildNpcSystemPrompt } from '../src/lib/quest/prompt.ts';
import {
  auditWorld,
  completePlayerInventory,
  createWorld,
  getNpc,
  getQuest,
  worldTotalOf,
} from '../src/lib/quest/world.ts';
import { proposeQuest } from '../src/lib/quest/adjudicate.ts';
import { playerQuestRejectionText } from '../src/lib/labels.ts';
import {
  DEFAULT_QUEST_NPC_ID,
  DEFAULT_SETTINGS,
  DEFAULT_SYSTEM_PROMPT,
  buildRequestMessages,
  isCustomPersona,
  normalizeSettings,
  npcPersonaFor,
} from '../src/lib/settings.ts';
import { buildRewardMenu } from '../src/lib/quest/prompt.ts';
import { questLetter } from '../src/lib/quest/letter.ts';
import type { World } from '../src/lib/quest/types.ts';

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

  it('人格补充按 NPC 分槽：三人各写各的，老全局内容不迁移', () => {
    // 默认全空：npc 模式只用内置框架
    assert.deepEqual(DEFAULT_SETTINGS.npcPersonas, {});
    assert.equal(npcPersonaFor(DEFAULT_SETTINGS, 'su-wanzhao'), '');

    // 只认白名单里的 key；值 trim，空串丢弃
    const normalized = normalizeSettings({
      npcPersonas: {
        'su-wanzhao': '  你说话带点川音。  ',
        'lu-xingzhou': '   ',
        'a-lai': '你见谁都先笑一下。',
        ghost: '这个不该留下',
      },
    });
    assert.deepEqual(normalized.npcPersonas, {
      'su-wanzhao': '你说话带点川音。',
      'a-lai': '你见谁都先笑一下。',
    });
    assert.equal(npcPersonaFor(normalized, 'lu-xingzhou'), '');

    // 旧存档里那段全局 systemPrompt 不再被当作 npc 人格（丢弃，不迁移）
    const legacy = normalizeSettings({ systemPrompt: '你说话带点川音。' });
    assert.equal(npcPersonaFor(legacy, 'su-wanzhao'), '');
    assert.equal(legacy.systemPrompt, '你说话带点川音。'); // desk 模式照旧用
  });

  it('闭环：补充只追加给那一位，提示词里不会串到别人身上', () => {
    const world = createWorld();
    const settings = normalizeSettings({ npcPersonas: { 'su-wanzhao': '你说话带点川音。' } });

    const suPrompt = buildNpcSystemPrompt(world, 'su-wanzhao', null, npcPersonaFor(settings, 'su-wanzhao'));
    assert.match(suPrompt, /额外人格补充[\s\S]*川音/);

    const luPrompt = buildNpcSystemPrompt(world, 'lu-xingzhou', null, npcPersonaFor(settings, 'lu-xingzhou'));
    assert.doesNotMatch(luPrompt, /额外人格补充/);
    assert.doesNotMatch(luPrompt, /川音/);

    // desk 路径一字未改
    assert.equal(
      buildRequestMessages({ ...DEFAULT_SETTINGS, systemPrompt: '说书人' }, [{ role: 'user', content: '你好' }])[0].content,
      '说书人',
    );
    assert.equal(isCustomPersona(DEFAULT_SYSTEM_PROMPT), false);
  });
});

/* ========================= 提示词：NPC 视角 ========================= */

describe('npc 提示词：只给 NPC 自己的视角（ADR-013）', () => {
  it('写清 NPC 是谁、它的背包、它的关系（含关系阶段与说话分寸）', () => {
    const world = createWorld();
    const prompt = buildNpcSystemPrompt(world, 'su-wanzhao', null);
    assert.match(prompt, /苏晚照/);
    assert.match(prompt, /药庐女医/);
    assert.match(prompt, /我自己的背包/);
    assert.match(prompt, /三七（id: sanqi）· 上品 · 单价 45 · ×2 · 我舍不得给/);
    assert.match(prompt, /对方与我的关系/);
    assert.match(prompt, /你们的关系：萍水（好感度 0，距「相识」还差 5）/);
    assert.match(prompt, /累计说过：0 轮话/);
    // 态度描述（提示词用的说话分寸）
    assert.match(prompt, /说话分寸/);
    assert.match(prompt, /过路的客人/);
  });

  it('喜好与忌讳、她在意的用途、舍不得给的 / 她多余的都写进了提示词', () => {
    const prompt = buildNpcSystemPrompt(createWorld(), 'su-wanzhao', null);
    assert.match(prompt, /我的偏好/);
    assert.match(prompt, /我在意的用途：疗伤、补血、调和/);
    assert.match(prompt, /我舍不得给的：[\s\S]*三七/);
    assert.match(prompt, /我舍不得给的：[\s\S]*当归/);
    assert.match(prompt, /我留着没用的：[\s\S]*百年灵芝/);
    assert.match(prompt, /能救人的药材/); // likes
    assert.match(prompt, /拿人命讨价还价/); // dislikes
    // 叙事引导，不是规则 —— 必须写明系统不会因此驳回
    assert.match(prompt, /不会\*\*因为"我舍不得"就驳回/);
  });

  it('关系阶段只影响态度，不设硬门闩（低阶段也能托付大事）', () => {
    const prompt = buildNpcSystemPrompt(createWorld(), 'su-wanzhao', null);
    assert.match(prompt, /事情能不能开口与阶段无关/);
    // 阶段一律不出现在任何"驳回/不许"的句式里
    assert.doesNotMatch(prompt, /阶段[^\n]*(驳回|不许|不能发布)/);
  });

  it('提示词里教了 note_impression 怎么用，并提醒同一套恭维会冷却', () => {
    const prompt = buildNpcSystemPrompt(createWorld(), 'su-wanzhao', null);
    assert.match(prompt, /note_impression/);
    assert.match(prompt, /pleased/);
    assert.match(prompt, /offended/);
    assert.match(prompt, /第二次不再新鲜/);
    assert.match(prompt, /每 2 轮最多因印象涨一次/);
  });

  it('道具奖励不再宣称有档位价值上限（有守恒的不设上限）', () => {
    const prompt = buildNpcSystemPrompt(createWorld(), 'su-wanzhao', null);
    assert.match(prompt, /没有价值上限/);
    assert.match(prompt, /背包即上限/);
    assert.match(prompt, /好感度：1 薄礼 档最多 \+3/);
    assert.doesNotMatch(prompt, /道具价值 ≤ 20/);
    assert.match(prompt, /不用自报档位/);
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
    assert.match(prompt, /三七\(sanqi, 值45，用途疗伤\/材料\)/);
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

  it('关系峰值与印象冷却记账能存回来（脏值不制造假冷却）', () => {
    const world = createWorld();
    world.player.affinity['su-wanzhao'] = 18;
    world.player.stagePeak['su-wanzhao'] = 2;
    world.player.impressionGainAt['su-wanzhao'] = 7;
    const restored = normalizeStoredWorld(clone(world));
    assert.equal(restored.player.affinity['su-wanzhao'], 18);
    assert.equal(restored.player.stagePeak['su-wanzhao'], 2);
    assert.equal(restored.player.impressionGainAt['su-wanzhao'], 7);

    const dirty = normalizeStoredWorld({
      player: {
        stagePeak: { 'su-wanzhao': 99, 'lu-xingzhou': 'x' },
        impressionGainAt: { 'su-wanzhao': 'y', 'lu-xingzhou': 3 },
      },
    });
    assert.equal(dirty.player.stagePeak['su-wanzhao'], 4); // 越界夹到最高档
    assert.equal(dirty.player.stagePeak['lu-xingzhou'], undefined);
    assert.equal(dirty.player.impressionGainAt['lu-xingzhou'], 3);
    // 字符串脏值必须丢掉：退化成 0 会凭空冷却 2 轮
    assert.equal(dirty.player.impressionGainAt['su-wanzhao'], undefined);
  });

  it('印象事件（questId 为 null）也能存回来', () => {
    const restored = normalizeStoredWorld({
      events: [
        {
          id: 'event-1',
          at: 5,
          type: 'impression_noted',
          questId: null,
          npcId: 'su-wanzhao',
          detail: '说到心坎里：他记得我旧疾',
        },
      ],
    });
    assert.equal(restored.events.length, 1);
    assert.equal(restored.events[0]?.type, 'impression_noted');
    assert.equal(restored.events[0]?.questId, null);
    assert.match(restored.events[0]?.detail ?? '', /说到心坎里/);
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

/* ================= 玩家在界面上交付 / 完成（A） ================= */

describe('玩家在界面上交付 / 完成（走裁决层）', () => {
  /** 造一条「已接取」的委托：发布 → 接取 */
  function setup(base: World, overrides: Partial<QuestProposalDraft> = {}): { world: World; questId: string } {
    const proposed = applyQuestEvent(
      base,
      { type: 'quest_proposal', proposal: proposal(overrides) },
      { npcId: 'su-wanzhao', requestId: 'req-1', dialogueId: 'msg-1', now: 1 },
    );
    assert.equal(proposed.ruling.ok, true, `提案应通过，实际被拒：${proposed.ruling.code ?? ''}`);
    const questId = proposed.ruling.questId ?? '';
    const accepted = applyPlayerAccept(proposed.world, { questId, requestId: 'req-2', now: 2 });
    assert.equal(accepted.ruling.ok, true, `接取应通过，实际被拒：${accepted.ruling.code ?? ''}`);
    return { world: accepted.world, questId };
  }

  it('拒绝码 → 玩家侧文案：有抬头、有明细、未知码有兜底', () => {
    assert.equal(
      playerQuestRejectionText('player_item_insufficient', '玩家只有 1 份「三七」，需要 2 份'),
      '你身上没有这件东西（或不够）：玩家只有 1 份「三七」，需要 2 份',
    );
    assert.match(playerQuestRejectionText('objective_not_met', '目标尚未达成'), /条件还没达成/);
    assert.match(playerQuestRejectionText('quest_not_submittable', '这个委托已经结算过了'), /已经了结/);
    assert.match(playerQuestRejectionText('deliver_forbidden', '这个委托不需要提交道具'), /不用交东西/);
    assert.match(playerQuestRejectionText(null, '明细'), /没能完成：明细/);
    assert.match(playerQuestRejectionText('没见过的码', '明细'), /没能完成：明细/);
  });

  it('交付型：按钮把 objective 里的道具与数量交出去 → 扣除、发奖、结算、守恒', () => {
    const base = createWorld({ playerInventory: [{ itemId: 'sanqi', count: 2 }] });
    const sanqiBefore = worldTotalOf(base, 'sanqi');
    const gaoBefore = worldTotalOf(base, 'jinchuang-gao');
    const { world, questId } = setup(base);

    const outcome = applyPlayerSubmit(world, {
      questId,
      requestId: 'req-3',
      now: 3,
      deliver: { itemId: 'sanqi', count: 1 },
    });
    assert.equal(outcome.ruling.ok, true);
    assert.equal(outcome.ruling.action, 'submit_quest');
    assert.equal(outcome.ruling.code, null);
    assert.equal(getQuest(outcome.world, questId)?.status, 'settled');
    // 交出一份三七，拿到一份金疮药
    assert.equal(availableOf(outcome.world.player.inventory, 'sanqi'), 1);
    assert.equal(availableOf(outcome.world.player.inventory, 'jinchuang-gao'), 1);
    // 守恒 + 无残留预留
    assert.equal(worldTotalOf(outcome.world, 'sanqi'), sanqiBefore);
    assert.equal(worldTotalOf(outcome.world, 'jinchuang-gao'), gaoBefore);
    assert.equal(getNpc(outcome.world, 'su-wanzhao')?.inventory.holds.length, 0);
    assert.deepEqual(auditWorld(outcome.world), []);
  });

  it('交付型但手上不够：拒绝码 + 可读文案，世界与入参同一引用（原子）', () => {
    const { world, questId } = setup(createWorld(), {
      objective: { kind: 'deliver_item', itemId: 'sanqi', count: 2 }, // 玩家只有 1 份
    });
    const before = JSON.stringify(world);
    const failed = applyPlayerSubmit(world, {
      questId,
      requestId: 'req-3',
      now: 3,
      deliver: { itemId: 'sanqi', count: 2 },
    });
    assert.equal(failed.ruling.ok, false);
    assert.equal(failed.ruling.code, 'player_item_insufficient');
    assert.equal(failed.world, world);
    assert.equal(JSON.stringify(failed.world), before);
    assert.match(playerQuestRejectionText(failed.ruling.code, failed.ruling.message), /你身上没有这件东西/);
    // 委托还挂在「已接取」，玩家凑齐了可以再点
    assert.equal(getQuest(world, questId)?.status, 'accepted');
  });

  it('非交付型：不带 deliver 提交；未达成 objective_not_met，达成后结算', () => {
    const { world, questId } = setup(createWorld(), {
      tier: 3,
      objective: { kind: 'talk_count', rounds: 3 },
      reward: { kind: 'ability', abilityId: 'jieyuan' },
    });
    const tooEarly = applyPlayerSubmit(world, { questId, requestId: 'req-3', now: 3 });
    assert.equal(tooEarly.ruling.ok, false);
    assert.equal(tooEarly.ruling.code, 'objective_not_met');
    assert.match(playerQuestRejectionText(tooEarly.ruling.code, tooEarly.ruling.message), /条件还没达成/);

    world.player.talks['su-wanzhao'] = 3; // 模拟「聊够了」——轮数由对话记账
    const done = applyPlayerSubmit(world, { questId, requestId: 'req-4', now: 4 });
    assert.equal(done.ruling.ok, true);
    assert.equal(getQuest(done.world, questId)?.status, 'settled');
    assert.deepEqual(done.world.player.abilities, ['jieyuan']);
  });

  it('非交付型夹带 deliver 会被拒（deliver_forbidden），不带就能过', () => {
    const { world, questId } = setup(createWorld(), {
      tier: 1,
      objective: { kind: 'has_item', itemId: 'gancao', count: 2 },
      reward: { kind: 'affinity', amount: 2 },
    });
    const withItem = applyPlayerSubmit(world, {
      questId,
      requestId: 'req-3',
      now: 3,
      deliver: { itemId: 'gancao', count: 2 },
    });
    assert.equal(withItem.ruling.ok, false);
    assert.equal(withItem.ruling.code, 'deliver_forbidden');

    const plain = applyPlayerSubmit(world, { questId, requestId: 'req-4', now: 4 });
    assert.equal(plain.ruling.ok, true);
    // 持有型目标不消耗道具
    assert.equal(availableOf(plain.world.player.inventory, 'gancao'), 2);
  });

  it('已经了结的委托再点一次：quest_not_submittable', () => {
    const { world, questId } = setup(createWorld({ playerInventory: [{ itemId: 'sanqi', count: 2 }] }));
    const first = applyPlayerSubmit(world, {
      questId,
      requestId: 'req-3',
      now: 3,
      deliver: { itemId: 'sanqi', count: 1 },
    });
    assert.equal(first.ruling.ok, true);

    const again = applyPlayerSubmit(first.world, {
      questId,
      requestId: 'req-4',
      now: 4,
      deliver: { itemId: 'sanqi', count: 1 },
    });
    assert.equal(again.ruling.ok, false);
    assert.equal(again.ruling.code, 'quest_not_submittable');
    assert.match(playerQuestRejectionText(again.ruling.code, again.ruling.message), /已经了结/);
  });
});

/* ============================ 开局背包：道具表全量（A-1） ============================ */

describe('玩家开局背包：道具表里每一件都有', () => {
  it('默认世界里 32 件道具每件至少 1 件，世界自检通过、玩家无预留', () => {
    const world = createWorld();
    for (const def of ITEM_LIST) {
      assert.ok(availableOf(world.player.inventory, def.id) >= 1, `${def.id} 应该开局就有`);
    }
    assert.deepEqual(auditWorld(world), []);
    assert.equal(world.player.inventory.holds.length, 0);
  });

  it('显式条目保持原量、不重复加（三七 1 / 甘草 2 / 干粮 2）', () => {
    const world = createWorld();
    assert.equal(availableOf(world.player.inventory, 'sanqi'), 1);
    assert.equal(availableOf(world.player.inventory, 'gancao'), 2);
    assert.equal(availableOf(world.player.inventory, 'rations'), 2);
  });

  it('completePlayerInventory 不重复：同一件只出现一次，数量相加', () => {
    const filled = completePlayerInventory([
      { itemId: 'sanqi', count: 3 },
      { itemId: 'sanqi', count: 2 },
    ]);
    const sanqi = filled.filter((stack) => stack.itemId === 'sanqi');
    assert.equal(sanqi.length, 1);
    assert.equal(sanqi[0].count, 5);
    assert.equal(filled.length, ITEM_LIST.length);
  });

  it('显式 playerInventory 仍可整份覆盖（测试用）', () => {
    const custom = createWorld({ playerInventory: [{ itemId: 'water', count: 5 }] });
    assert.equal(availableOf(custom.player.inventory, 'water'), 5);
    assert.equal(availableOf(custom.player.inventory, 'sanqi'), 0);
  });
});

/* ============================ 赠送（A-3） ============================ */

describe('赠送：白送道具给 NPC（与委托无关）', () => {
  it('送出 1 件：玩家 −1、NPC +1、总量不变、不产生委托、有事件', () => {
    const base = createWorld();
    const totalBefore = worldTotalOf(base, 'sanqi');
    const npcBefore = totalOf(getNpc(base, 'su-wanzhao')!.inventory, 'sanqi');
    const questsBefore = Object.keys(base.quests).length;

    const outcome = applyPlayerGift(base, {
      npcId: 'su-wanzhao',
      itemId: 'sanqi',
      count: 1,
      requestId: 'gift-1',
      now: 10,
    });

    assert.equal(outcome.ruling.ok, true);
    assert.equal(outcome.ruling.action, 'gift_item');
    assert.equal(outcome.ruling.questId, null);
    assert.equal(availableOf(outcome.world.player.inventory, 'sanqi'), availableOf(base.player.inventory, 'sanqi') - 1);
    assert.equal(totalOf(getNpc(outcome.world, 'su-wanzhao')!.inventory, 'sanqi'), npcBefore + 1);
    assert.equal(worldTotalOf(outcome.world, 'sanqi'), totalBefore, '道具必须守恒');
    assert.equal(Object.keys(outcome.world.quests).length, questsBefore, '赠送不产生委托');
    assert.ok(outcome.world.events.some((event) => event.type === 'item_gifted' && event.questId === null));
    assert.deepEqual(auditWorld(outcome.world), []);
  });

  it('幂等：同一 requestId 重放不再扣一次，世界是同一引用', () => {
    const first = applyPlayerGift(createWorld(), {
      npcId: 'a-lai',
      itemId: 'rations',
      count: 1,
      requestId: 'gift-2',
      now: 1,
    });
    assert.equal(first.ruling.ok, true);
    const replay = applyPlayerGift(first.world, {
      npcId: 'a-lai',
      itemId: 'rations',
      count: 1,
      requestId: 'gift-2',
      now: 2,
    });
    assert.equal(replay.ruling.ok, true);
    assert.equal(replay.world, first.world);
  });

  it('不够就拒绝，世界逐字节不变', () => {
    const base = createWorld({ playerInventory: [{ itemId: 'sanqi', count: 1 }] });
    const snapshot = JSON.stringify(base);
    const outcome = applyPlayerGift(base, {
      npcId: 'su-wanzhao',
      itemId: 'sanqi',
      count: 2,
      requestId: 'gift-3',
      now: 1,
    });
    assert.equal(outcome.ruling.ok, false);
    assert.equal(outcome.ruling.code, 'player_item_insufficient');
    assert.equal(outcome.world, base);
    assert.equal(JSON.stringify(base), snapshot);
    assert.match(playerQuestRejectionText(outcome.ruling.code, outcome.ruling.message), /没有这件东西/);
  });

  it('件数非正 / 未登记道具 / 不认识的人：各自拒绝码', () => {
    const base = createWorld();
    const zero = applyPlayerGift(base, { npcId: 'su-wanzhao', itemId: 'sanqi', count: 0, requestId: 'g1', now: 1 });
    assert.equal(zero.ruling.code, 'invalid_gift_count');
    const unknown = applyPlayerGift(base, { npcId: 'su-wanzhao', itemId: 'made-up', count: 1, requestId: 'g2', now: 1 });
    assert.equal(unknown.ruling.code, 'unknown_item');
    const ghost = applyPlayerGift(base, { npcId: 'ghost', itemId: 'sanqi', count: 1, requestId: 'g3', now: 1 });
    assert.equal(ghost.ruling.code, 'unknown_npc');
  });

  it('NPC 不得以「用不上」为由拒收（NFR-013）：送阿癞清水照样收下', () => {
    const outcome = applyPlayerGift(createWorld(), {
      npcId: 'a-lai',
      itemId: 'water',
      count: 1,
      requestId: 'gift-4',
      now: 1,
    });
    assert.equal(outcome.ruling.ok, true);
    assert.equal(totalOf(getNpc(outcome.world, 'a-lai')!.inventory, 'water'), 1);
  });
});

/* ==================== 提示词里的交付事实（NPC 不会再说"没收到"） ==================== */

describe('提示词：交付事实现算，不靠上一轮裁决', () => {
  /** 发布 → 接取 → 交付，得到一条已结算的委托 */
  function settledGiftQuest(): { world: World; questId: string } {
    const base = createWorld({ playerInventory: [{ itemId: 'gancao', count: 2 }] });
    const proposed = applyQuestEvent(
      base,
      { type: 'quest_proposal', proposal: proposal({ objective: { kind: 'deliver_item', itemId: 'gancao', count: 1 } }) },
      { npcId: 'su-wanzhao', requestId: 'req-1', dialogueId: 'msg-1', now: 1 },
    );
    assert.equal(proposed.ruling.ok, true);
    const questId = proposed.ruling.questId ?? '';
    const accepted = applyPlayerAccept(proposed.world, { questId, requestId: 'req-2', now: 2 });
    assert.equal(accepted.ruling.ok, true);
    const submitted = applyPlayerSubmit(accepted.world, {
      questId,
      requestId: 'req-3',
      now: 3,
      deliver: { itemId: 'gancao', count: 1 },
    });
    assert.equal(submitted.ruling.ok, true);
    return { world: submitted.world, questId };
  }

  it('已结算的委托：提示词写明「已经收到的货」并禁止再催交付', () => {
    const { world } = settledGiftQuest();
    const prompt = buildNpcSystemPrompt(world, 'su-wanzhao', null, '');
    assert.match(prompt, /已经收到的货：甘草 ×1/);
    assert.match(prompt, /这条委托已经了结/);
    assert.match(prompt, /绝不能再让他交付一次/);
    assert.match(prompt, /也不要问「东西呢」/);
  });

  it('还没交付时不出现「已经收到的货」（不给模型编造的依据）', () => {
    const base = createWorld({ playerInventory: [{ itemId: 'gancao', count: 2 }] });
    const proposed = applyQuestEvent(
      base,
      { type: 'quest_proposal', proposal: proposal({ objective: { kind: 'deliver_item', itemId: 'gancao', count: 1 } }) },
      { npcId: 'su-wanzhao', requestId: 'req-1', dialogueId: 'msg-1', now: 1 },
    );
    const prompt = buildNpcSystemPrompt(proposed.world, 'su-wanzhao', null, '');
    assert.doesNotMatch(prompt, /已经收到的货/);
  });

  it('玩家背包仍然绝不出现在提示词里（ADR-013）', () => {
    const { world } = settledGiftQuest();
    const prompt = buildNpcSystemPrompt(world, 'su-wanzhao', null, '');
    // 玩家多给的甘草还在自己包里，提示词里不应有「行囊 / 玩家背包」这种视角
    assert.doesNotMatch(prompt, /玩家背包/);
    assert.doesNotMatch(prompt, /我的行囊/);
  });
});

/* ==================== 谢礼只能从自己背包里挑（竹哨事故） ==================== */

describe('谢礼清单：只列她真正拿得出的东西', () => {
  it('苏晚照拿不出竹哨：谢礼清单里没有它（竹哨只归陆行舟）', () => {
    const world = createWorld();
    const su = getNpc(world, 'su-wanzhao');
    assert.ok(su);
    const menu = buildRewardMenu(su!);
    assert.match(menu, /我能拿出的谢礼/);
    assert.match(menu, /金疮药/);
    assert.doesNotMatch(menu, /竹哨/);
    // 白名单（拼写表）仍然列出全部 32 件，但已明确「不是你能拿出的清单」
    const prompt = buildNpcSystemPrompt(world, 'su-wanzhao', null, '');
    assert.match(prompt, /道具 id 拼写表/);
    assert.match(prompt, /不是"你能拿出来的东西"清单/);
  });

  it('空背包的 NPC：清单里直接说「一件也拿不出来」', () => {
    const world = createWorld();
    const ghostOfBag = buildRewardMenu(getNpc(world, 'a-lai')!);
    assert.match(ghostOfBag, /一件也拿不出来/);
  });

  it('奖励被拒时，裁决事实会给出「换一件重提」的指引', () => {
    const world = createWorld();
    const proposed = applyQuestEvent(
      world,
      {
        type: 'quest_proposal',
        proposal: proposal({ reward: { kind: 'item', itemId: 'bamboo-whistle', count: 1 } }),
      },
      { npcId: 'su-wanzhao', requestId: 'req-1', dialogueId: 'msg-1', now: 1 },
    );
    assert.equal(proposed.ruling.ok, false);
    assert.equal(proposed.ruling.code, 'reward_not_owned');

    const prompt = buildNpcSystemPrompt(proposed.world, 'su-wanzhao', proposed.ruling, '');
    assert.match(prompt, /怎么改/);
    assert.match(prompt, /重新调用一次 propose_quest/);
  });
});

/* ==================== 补齐行囊（每件 64） ==================== */

describe('补齐行囊：每件补到 64，已够的不动', () => {
  it('把缺的补到 64：32 种全部达到 64，已有更多的保持原样', () => {
    const base = createWorld({ playerInventory: [{ itemId: 'sanqi', count: 100 }] });
    const outcome = applyPlayerRestock(base, { requestId: 'restock-1', now: 1 });
    assert.equal(outcome.ruling.ok, true);
    assert.equal(outcome.ruling.action, 'restock_player');
    assert.equal(availableOf(outcome.world.player.inventory, 'sanqi'), 100, '已经超过 64 的不动');
    for (const def of ITEM_LIST) {
      assert.ok(availableOf(outcome.world.player.inventory, def.id) >= 64, `${def.id} 应至少 64`);
    }
    assert.ok(outcome.world.events.some((event) => event.type === 'items_restocked'));
    assert.deepEqual(auditWorld(outcome.world), []);
  });

  it('已经满额时不再加：世界原样返回（重复点击无副作用）', () => {
    const once = applyPlayerRestock(createWorld(), { requestId: 'restock-1', now: 1 });
    const twice = applyPlayerRestock(once.world, { requestId: 'restock-2', now: 2 });
    assert.equal(twice.ruling.ok, true);
    assert.equal(twice.world, once.world, '没有缺口就返回同一个世界');
    assert.match(twice.ruling.applied[0] ?? '', /无需补齐/);
  });

  it('幂等：同一个 requestId 重放不再补一次', () => {
    const first = applyPlayerRestock(createWorld(), { requestId: 'restock-1', now: 1 });
    const replay = applyPlayerRestock(first.world, { requestId: 'restock-1', now: 2 });
    assert.equal(replay.ruling.ok, true);
    assert.equal(replay.world, first.world);
  });
});

/* ==================== 结算后的 NPC 留言 ==================== */

describe('NPC 留言：结算后她留一句（确定性，不调模型）', () => {
  it('已结算：带名字、带收到的货、同一条委托永远同一句', () => {
    const base = createWorld({ playerInventory: [{ itemId: 'gancao', count: 2 }] });
    const proposed = applyQuestEvent(
      base,
      { type: 'quest_proposal', proposal: proposal({ objective: { kind: 'deliver_item', itemId: 'gancao', count: 1 } }) },
      { npcId: 'su-wanzhao', requestId: 'req-1', dialogueId: 'msg-1', now: 1 },
    );
    const questId = proposed.ruling.questId ?? '';
    const accepted = applyPlayerAccept(proposed.world, { questId, requestId: 'req-2', now: 2 });
    const settled = applyPlayerSubmit(accepted.world, {
      questId,
      requestId: 'req-3',
      now: 3,
      deliver: { itemId: 'gancao', count: 1 },
    });
    const quest = getQuest(settled.world, questId)!;
    const npc = getNpc(settled.world, 'su-wanzhao')!;
    const letter = questLetter(quest, npc);
    assert.match(letter, /苏晚照留了一句/);
    assert.match(letter, /甘草×1/);
    assert.equal(questLetter(quest, npc), letter, '确定性：两次调用一致');
  });

  it('没结算就没有留言', () => {
    const world = createWorld();
    const proposed = applyQuestEvent(
      world,
      { type: 'quest_proposal', proposal: proposal() },
      { npcId: 'su-wanzhao', requestId: 'req-1', dialogueId: 'msg-1', now: 1 },
    );
    const quest = getQuest(proposed.world, proposed.ruling.questId ?? '')!;
    assert.equal(questLetter(quest, getNpc(world, 'su-wanzhao')!), '');
  });
});
