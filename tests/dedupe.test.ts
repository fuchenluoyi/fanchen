/**
 * U-04：相似度与去重。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  dedupeCandidates,
  isDuplicate,
  longestCommonSubstringLength,
  normalizeText,
  similarity,
} from '../src/lib/dedupe.ts';

describe('去重与相似度', () => {
  it('normalizeText 会去掉标点、空白与常见前后缀', () => {
    assert.equal(normalizeText(' 请 帮我 做一个 排班表 吧 '), '做一个排班表');
  });

  it('longestCommonSubstringLength 计算正确', () => {
    assert.equal(longestCommonSubstringLength('支持换班申请', '换班申请功能'), 4);
    assert.equal(longestCommonSubstringLength('abc', 'xyz'), 0);
  });

  it('U-04 同义表达的标题应判为高度相似', () => {
    const score = similarity('支持换班申请', '换班申请功能');
    assert.ok(score >= 0.62, `期望 >= 0.62，实际 ${score}`);
    assert.equal(isDuplicate('支持换班申请', ['换班申请功能'], 0.62), true);
  });

  it('实质不同的动作不应被误判为重复', () => {
    const score = similarity('导出 Excel', '导入 Excel');
    assert.ok(score < 0.62, `导出/导入 不应重复，实际 ${score}`);
    assert.equal(isDuplicate('导出 Excel', ['导入 Excel'], 0.62), false);
  });

  it('不相关标题不应判为重复', () => {
    assert.equal(isDuplicate('自动提醒', ['支持换班申请'], 0.62), false);
    assert.ok(similarity('支持换班申请', '支持自动提醒') < 0.62);
  });

  it('完全相同的标题必判重复', () => {
    assert.equal(similarity('排班表', '排班表'), 1);
    assert.equal(isDuplicate('排班表', ['排班表'], 0.62), true);
  });

  it('dedupeCandidates 同时对比既有标题与同批次内的项（AC-9.3）', () => {
    const candidates = [
      { title: '支持换班申请' },
      { title: '换班申请功能' },
      { title: '导出 Excel' },
    ];
    const result = dedupeCandidates(candidates, ['自动提醒'], 0.62);
    assert.equal(result.kept.length, 2, JSON.stringify(result.kept));
    assert.equal(result.dropped.length, 1);
    assert.equal(result.dropped[0].duplicateOf, '支持换班申请');
  });

  it('与既有任务重复的候选应被丢弃', () => {
    const result = dedupeCandidates([{ title: '导出 Excel' }], ['导出Excel'], 0.62);
    assert.equal(result.kept.length, 0);
    assert.equal(result.dropped.length, 1);
  });
});
