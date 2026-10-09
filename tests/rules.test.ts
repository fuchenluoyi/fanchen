/**
 * U-01 / U-02 / U-03：规则引擎触发判定与候选切分。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeForRequirements, detectRequirement, makeTitle, ruleCandidates } from '../src/lib/rules.ts';

describe('规则引擎', () => {
  it('U-01 强需求句应命中并给出依据', () => {
    const result = analyzeForRequirements('我需要一个能给团队用的值班排班工具');
    assert.equal(result.hit, true);
    assert.ok(result.score >= 3);
    assert.ok(result.reasons.length > 0);
    assert.ok(result.candidates.length >= 1);
    assert.ok(result.candidates[0].title.length > 0);
  });

  it('U-02 闲聊与过短文本不应命中', () => {
    assert.equal(detectRequirement('今天天气不错'), false);
    assert.equal(detectRequirement('哈哈哈'), false);
    assert.equal(detectRequirement('嗯嗯'), false);
    assert.equal(detectRequirement(''), false);
  });

  it('U-03 列表形式的多条需求应切成多个候选', () => {
    const text = [
      '我觉得需要这几样：',
      '1. 支持换班申请',
      '2. 自动提醒',
      '3. 导出 Excel',
    ].join('\n');
    const candidates = ruleCandidates(text);
    assert.ok(candidates.length >= 2, `期望至少 2 个候选，实际 ${candidates.length}`);
    for (const candidate of candidates) {
      assert.ok(candidate.title.length > 0);
      assert.ok(candidate.title.length <= 21);
    }
    const titles = candidates.map((c) => c.title).join('|');
    assert.match(titles, /换班申请/);
    assert.match(titles, /提醒/);
  });

  it('否定表达不应被当成需求', () => {
    assert.equal(detectRequirement('这个功能不需要导出'), false);
    assert.equal(detectRequirement('暂时不用加提醒'), false);
  });

  it('标题应被裁剪到 20 字以内并去掉装饰符号', () => {
    const long = '**支持把排班结果按照部门分组导出成 Excel 并且自动发送到企业微信群**';
    const title = makeTitle(long);
    assert.ok(title.length <= 21, `标题过长：${title}`);
    assert.ok(!title.includes('*'));
  });

  it('候选数量应有上限，避免刷屏', () => {
    const text = Array.from({ length: 20 }, (_, index) => `${index + 1}. 需要支持功能${index + 1}`).join('\n');
    assert.ok(ruleCandidates(text).length <= 6);
  });
});
