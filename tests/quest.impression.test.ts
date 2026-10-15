/**
 * 印象（好感度的涨法）：计分、冷却、下限、幂等、原子性，
 * 以及客户端接线（applyQuestImpression / sanitizeQuestImpression / 事件收敛）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeServerEvent, sanitizeQuestImpression } from '../src/lib/api.ts';
import { noteImpression } from '../src/lib/quest/adjudicate.ts';
import { applyQuestImpression } from '../src/lib/quest/bridge.ts';
import { IMPRESSION_COOLDOWN_ROUNDS, IMPRESSION_DELTA } from '../src/lib/quest/constants.ts';
import { auditWorld, createWorld } from '../src/lib/quest/world.ts';
import type { ImpressionKind } from '../src/lib/quest/types.ts';
import type { World } from '../src/lib/quest/types.ts';

function note(
  world: World,
  overrides: Partial<{ requestId: string; npcId: string; impression: ImpressionKind; reason: string; now: number }> = {},
) {
  return noteImpression(world, {
    requestId: 'req-1',
    npcId: 'su-wanzhao',
    impression: 'pleased',
    now: 1000,
    ...overrides,
  });
}

describe('note_impression：好感度的涨法', () => {
  it('计分：pleased +2 / neutral 0 / offended -1', () => {
    assert.deepEqual(IMPRESSION_DELTA, { pleased: 2, neutral: 0, offended: -1 });
    const world = createWorld();

    const pleased = note(world);
    assert.equal(pleased.ok, true);
    if (!pleased.ok) return;
    assert.equal(pleased.world.player.affinity['su-wanzhao'], 2);

    const neutral = note(world, { requestId: 'req-2', impression: 'neutral' });
    assert.equal(neutral.ok, true);
    if (!neutral.ok) return;
    assert.equal(neutral.world.player.affinity['su-wanzhao'], 0);

    const offended = note(world, { requestId: 'req-3', impression: 'offended' });
    assert.equal(offended.ok, true);
    if (!offended.ok) return;
    assert.equal(offended.world.player.affinity['su-wanzhao'], 0); // 下限 clamp 到 0
  });

  it('好感度不允许为负：连着冒犯也停在 0', () => {
    let world = createWorld();
    for (let i = 0; i < 5; i += 1) {
      const result = note(world, { requestId: `req-${i}`, impression: 'offended' });
      assert.equal(result.ok, true);
      if (!result.ok) return;
      world = result.world;
    }
    assert.equal(world.player.affinity['su-wanzhao'], 0);
  });

  it('冷却：同一 NPC 每 2 轮最多因印象涨一次；offended 不受限', () => {
    let world = createWorld();

    const first = note(world, { requestId: 'r1' });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    world = first.world;
    assert.equal(world.player.affinity['su-wanzhao'], 2);
    assert.equal(world.player.impressionGainAt['su-wanzhao'], 0); // 记在第 0 轮

    // 同一轮再来一次：冷却驳回
    const sameRound = note(world, { requestId: 'r2' });
    assert.equal(sameRound.ok, false);
    if (!sameRound.ok) assert.equal(sameRound.code, 'impression_cooldown');

    // 差 1 轮：仍在冷却
    world.player.talks['su-wanzhao'] = IMPRESSION_COOLDOWN_ROUNDS - 1;
    const oneRoundLater = note(world, { requestId: 'r3' });
    assert.equal(oneRoundLater.ok, false);
    if (!oneRoundLater.ok) assert.equal(oneRoundLater.code, 'impression_cooldown');

    // 满 2 轮：解冻
    world.player.talks['su-wanzhao'] = IMPRESSION_COOLDOWN_ROUNDS;
    const thawed = note(world, { requestId: 'r4' });
    assert.equal(thawed.ok, true);
    if (!thawed.ok) return;
    assert.equal(thawed.world.player.affinity['su-wanzhao'], 4);
    assert.equal(thawed.world.player.impressionGainAt['su-wanzhao'], IMPRESSION_COOLDOWN_ROUNDS);

    // offended 不看冷却：同一轮立刻生效（-1）
    const offended = note(thawed.world, { requestId: 'r5', impression: 'offended' });
    assert.equal(offended.ok, true);
    if (!offended.ok) return;
    assert.equal(offended.world.player.affinity['su-wanzhao'], 3);
  });

  it('幂等：同一个 requestId 重放不加第二次；换参数则是客户端 bug', () => {
    const first = note(createWorld(), { requestId: 'same' });
    assert.equal(first.ok, true);
    if (!first.ok) return;

    const replay = noteImpression(first.world, {
      requestId: 'same',
      npcId: 'su-wanzhao',
      impression: 'pleased',
    });
    assert.equal(replay.ok, true);
    if (!replay.ok) return;
    assert.equal(replay.replay, true);
    assert.equal(replay.world.player.affinity['su-wanzhao'], 2);

    const reused = noteImpression(first.world, {
      requestId: 'same',
      npcId: 'su-wanzhao',
      impression: 'offended',
    });
    assert.equal(reused.ok, false);
    if (!reused.ok) assert.equal(reused.code, 'idempotency_key_reused');
  });

  it('拒绝：没有这个 NPC / 印象瞎写 / 空 requestId，世界逐字节不变（原子）', () => {
    const world = createWorld();
    const before = JSON.stringify(world);

    const noNpc = note(world, { npcId: '查无此人' });
    assert.equal(noNpc.ok, false);
    if (!noNpc.ok) assert.equal(noNpc.code, 'unknown_npc');

    const badKind = note(world, { impression: '很感动' as ImpressionKind });
    assert.equal(badKind.ok, false);
    if (!badKind.ok) assert.equal(badKind.code, 'invalid_impression');

    const noKey = note(world, { requestId: '   ' });
    assert.equal(noKey.ok, false);
    if (!noKey.ok) assert.equal(noKey.code, 'invalid_field');

    assert.equal(noKey.world, world); // 同一个引用：没有半成品
    assert.equal(JSON.stringify(world), before);
    assert.deepEqual(auditWorld(world), []);
  });

  it('事件流水记一笔 impression_noted，且不属于任何委托', () => {
    const result = note(createWorld(), { reason: '他记得我旧疾' });
    assert.equal(result.ok, true);
    if (!result.ok) return;

    const event = result.world.events.at(-1);
    assert.ok(event);
    assert.equal(event.type, 'impression_noted');
    assert.equal(event.questId, null);
    assert.equal(event.npcId, 'su-wanzhao');
    assert.match(event.detail, /好感度 0 → 2/);
    assert.match(event.detail, /他记得我旧疾/);
    // 印象不动背包：审计必须干净
    assert.deepEqual(auditWorld(result.world), []);
  });

  it('阶段峰值单向推进：涨到「相识」之后掉回去也不降阶', () => {
    let world = createWorld();

    const first = note(world, { requestId: 'r1' });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    world = first.world;
    assert.equal(world.player.affinity['su-wanzhao'], 2);
    assert.equal(world.player.stagePeak['su-wanzhao'], 0); // 2 → 仍是「萍水」

    world.player.talks['su-wanzhao'] = 5;
    const second = note(world, { requestId: 'r2' });
    assert.equal(second.ok, true);
    if (!second.ok) return;
    world = second.world;
    assert.equal(world.player.affinity['su-wanzhao'], 4);
    assert.equal(world.player.stagePeak['su-wanzhao'], 0);

    world.player.talks['su-wanzhao'] = 10;
    const third = note(world, { requestId: 'r3' });
    assert.equal(third.ok, true);
    if (!third.ok) return;
    world = third.world;
    assert.equal(world.player.affinity['su-wanzhao'], 6);
    assert.equal(world.player.stagePeak['su-wanzhao'], 1); // 6 → 「相识」

    world.player.affinity['su-wanzhao'] = 0; // 人为掉分
    assert.equal(world.player.stagePeak['su-wanzhao'], 1); // 峰值不回落
  });
});

describe('印象的客户端接线', () => {
  it('applyQuestImpression 走裁决层并产出裁决事实', () => {
    const outcome = applyQuestImpression(createWorld(), {
      npcId: 'su-wanzhao',
      impression: 'pleased',
      reason: '他记得我旧疾',
      requestId: 'req-1',
      now: 1000,
    });
    assert.equal(outcome.ruling.ok, true);
    assert.equal(outcome.ruling.action, 'note_impression');
    assert.equal(outcome.ruling.questId, null);
    assert.equal(outcome.ruling.code, null);
    assert.equal(outcome.world.player.affinity['su-wanzhao'], 2);
    assert.ok(outcome.ruling.applied.some((line) => /印象/.test(line)));
  });

  it('applyQuestImpression 的拒绝也照实返回（冷却时）', () => {
    const first = applyQuestImpression(createWorld(), {
      npcId: 'su-wanzhao',
      impression: 'pleased',
      requestId: 'req-1',
      now: 1000,
    });
    const second = applyQuestImpression(first.world, {
      npcId: 'su-wanzhao',
      impression: 'pleased',
      requestId: 'req-2',
      now: 2000,
    });
    assert.equal(second.ruling.ok, false);
    assert.equal(second.ruling.code, 'impression_cooldown');
    assert.equal(second.world, first.world);
  });

  it('sanitizeQuestImpression：收敛形状，脏值丢弃', () => {
    assert.deepEqual(sanitizeQuestImpression({ kind: 'pleased', reason: ' 说到心坎里 ' }), {
      kind: 'pleased',
      reason: '说到心坎里',
    });
    assert.deepEqual(sanitizeQuestImpression({ kind: 'offended' }), { kind: 'offended' });
    assert.equal(sanitizeQuestImpression({ kind: '很感动' }), null);
    assert.equal(sanitizeQuestImpression({}), null);
    assert.equal(sanitizeQuestImpression(null), null);
    assert.equal(sanitizeQuestImpression([]), null);
  });

  it('normalizeServerEvent 认得 quest_impression，脏事件丢掉', () => {
    const event = normalizeServerEvent({ type: 'quest_impression', index: 2, impression: { kind: 'pleased' } });
    assert.equal(event?.type, 'quest_impression');
    if (event?.type === 'quest_impression') {
      assert.equal(event.index, 2);
      assert.equal(event.impression.kind, 'pleased');
    }
    assert.equal(normalizeServerEvent({ type: 'quest_impression', impression: { kind: '瞎写' } }), null);
    assert.equal(normalizeServerEvent({ type: 'quest_impression' }), null);
  });
});
