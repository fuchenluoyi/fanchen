/**
 * 关系阶段（五档，单向不回落）：阈值、脏值、进度、态度文案，
 * 以及最重要的一条纪律 —— **阶段只进提示词，不做硬门闩**。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildNpcSystemPrompt } from '../src/lib/quest/prompt.ts';
import {
  STAGES,
  STAGE_IDS,
  STAGE_LABEL,
  STAGE_THRESHOLDS,
  describeAttitude,
  nextStagePeak,
  peakStageIndexOf,
  peakStageOf,
  progressToNextStage,
  stageIndexOf,
  stageOf,
} from '../src/lib/quest/relationship.ts';
import { createWorld, getNpc } from '../src/lib/quest/world.ts';

describe('关系阶段：五档、阈值、单向', () => {
  it('五档齐全：id 是英文、标签是中文', () => {
    assert.equal(STAGES.length, 5);
    assert.deepEqual(
      STAGES.map((stage) => stage.label),
      ['萍水', '相识', '知交', '知己', '莫逆'],
    );
    assert.deepEqual(
      STAGE_IDS,
      STAGES.map((stage) => stage.id),
    );
    for (const stage of STAGES) assert.match(stage.id, /^[a-z]+$/);
  });

  it('阈值：0-4 萍水 / 5-14 相识 / 15-29 知交 / 30-59 知己 / 60+ 莫逆', () => {
    assert.deepEqual(STAGE_THRESHOLDS, [0, 5, 15, 30, 60]);
    const cases: Array<[number, string]> = [
      [0, '萍水'],
      [4, '萍水'],
      [5, '相识'],
      [14, '相识'],
      [15, '知交'],
      [29, '知交'],
      [30, '知己'],
      [59, '知己'],
      [60, '莫逆'],
      [6000, '莫逆'],
    ];
    for (const [affinity, label] of cases) {
      assert.equal(STAGE_LABEL[stageOf(affinity)], label, `好感度 ${affinity} 应落在「${label}」`);
    }
  });

  it('脏值不炸：负数与非有限值当 0，小数向下取整', () => {
    assert.equal(stageOf(-100), 'piaoshui');
    assert.equal(stageOf(Number.NaN), 'piaoshui');
    assert.equal(stageOf(5.9), 'xiangshi');
    // NaN 与 Infinity 一视同仁：脏数据退回最低档，不猜也不夹到顶
    assert.equal(stageIndexOf(Number.POSITIVE_INFINITY), 0);
    assert.equal(stageIndexOf(Number.NaN), 0);
  });

  it('单向不回落：好感掉了不降阶，历史最高说了算', () => {
    // 曾经到过「知交」（索引 2），现在掉到 3
    assert.equal(peakStageOf(3, 2), 'zhijiao');
    assert.equal(peakStageIndexOf(3, 2), 2);
    // 当前阶段更高时以当前为准
    assert.equal(peakStageOf(35, 1), 'zhiji');
    // 历史峰值越界会被夹住
    assert.equal(nextStagePeak(0, 99), 4);
    assert.equal(nextStagePeak(0, -3), 0);
    assert.equal(nextStagePeak(3, undefined), 0);
  });

  it('进度：距下一阶段还差多少；到顶之后没有下一阶段', () => {
    const middle = progressToNextStage(18);
    assert.equal(middle.label, '知交');
    assert.equal(middle.stage, 'zhijiao');
    assert.equal(middle.nextThreshold, 30);
    assert.equal(middle.toNext, 12);
    assert.ok(middle.ratio > 0 && middle.ratio < 1);

    const top = progressToNextStage(88);
    assert.equal(top.label, '莫逆');
    assert.equal(top.nextThreshold, null);
    assert.equal(top.toNext, 0);
    assert.equal(top.ratio, 1);

    const start = progressToNextStage(0);
    assert.equal(start.toNext, 5);
    assert.equal(start.ratio, 0);

    // 传 peak 时按单向不回落后的阶段算进度
    const kept = progressToNextStage(4, 2);
    assert.equal(kept.label, '知交');
  });

  it('态度文案五档各不相同，且都点出称呼与关心程度', () => {
    const npc = { name: '苏晚照', title: '药庐女医' };
    const texts = STAGE_IDS.map((stage) => describeAttitude(stage, npc));
    for (const text of texts) assert.match(text, /苏晚照/);
    assert.match(texts[0], /过路的客人/); // 萍水：客气、不交底
    assert.match(texts[4], /生死之交/); // 莫逆
    assert.equal(new Set(texts).size, 5);
  });

  it('**阶段不做硬门闩**：低阶段照样能把大事说出口', () => {
    const world = createWorld();
    const npc = getNpc(world, 'su-wanzhao');
    assert.ok(npc);
    // 开局是「萍水」
    assert.equal(stageOf(world.player.affinity[npc.id] ?? 0), 'piaoshui');
    const prompt = buildNpcSystemPrompt(world, npc.id, null);
    assert.match(prompt, /事情能不能开口与阶段无关/);
    // 提示词里不允许出现"低阶段就不许托付"这类硬门闩句式
    assert.doesNotMatch(prompt, /阶段[^\n]*(驳回|不许|不能发布|必须达到)/);
  });
});
