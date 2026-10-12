/**
 * 命令行冒烟：不经 LLM，把「发布 → 接取 → 校验 → 交付 → 扣除 → 发奖 → 结算」整条链路跑通。
 *
 * 存在意义（交接文档 §7）：先做裁决层，别先做对话。
 * 这一层对了，接 LLM 只是把它变成一个更灵活的输入方式；
 * 这一层错了，接上 LLM 只会让 bug 变得更难复现。
 *
 * 运行：node scripts/quest-smoke.ts    （或 pnpm run smoke:quest / npm run smoke:quest）
 * 全部断言通过则退出码为 0，否则为 1。
 */
import assert from 'node:assert/strict';

import {
  acceptQuest,
  auditItemTable,
  auditWorld,
  createWorld,
  declineQuest,
  getNpc,
  inspectNpc,
  inspectPlayer,
  itemName,
  listAvailable,
  proposeQuest,
  submitQuest,
  worldTotalOf,
} from '../src/lib/quest/index.ts';
import type { Adjudication, Inventory, QuestErrorCode } from '../src/lib/quest/index.ts';

let failures = 0;

function section(title: string): void {
  const line = '─'.repeat(Math.max(4, 54 - title.length));
  console.log(`\n── ${title} ${line}`);
}

function fmt(inventory: Inventory): string {
  const stacks = listAvailable(inventory);
  if (stacks.length === 0) return '（空）';
  return stacks.map((stack) => `${itemName(stack.itemId)}×${stack.count}`).join('、');
}

function expectOk(label: string, result: Adjudication): Extract<Adjudication, { ok: true }> {
  if (!result.ok) {
    failures += 1;
    console.error(`✘ ${label}\n    预期成功，却被拒绝：${result.code}｜${result.message}`);
    throw new Error(`冒烟中断：${label}`);
  }
  console.log(`✔ ${label}${result.replay ? '（幂等重放，世界未变）' : ''}`);
  for (const line of result.applied) console.log(`    · ${line}`);
  return result;
}

function expectRejected(label: string, result: Adjudication, code: QuestErrorCode): void {
  if (result.ok) {
    failures += 1;
    console.error(`✘ ${label}\n    预期被拒（${code}），却成功了`);
    throw new Error(`冒烟中断：${label}`);
  }
  assert.equal(result.code, code, `${label} 的拒绝码应为 ${code}`);
  console.log(`✘ ${label}\n    被拒：${result.code}｜${result.message}`);
}

function main(): void {
  console.log('凡尘 · NPC 委托领域层冒烟（不经 LLM）');

  /* ---------------------------------------------------------------- */
  section('0. 开局：玩家与三个 NPC 的家底');

  const world0 = createWorld({ playerName: '行客' });
  console.log(`玩家「${world0.player.name}」可用：${fmt(world0.player.inventory)}`);
  for (const npc of Object.values(world0.npcs)) {
    console.log(`${npc.name}（${npc.title}，慷慨度 ${npc.generosity}）可用：${fmt(npc.inventory)}`);
  }
  const sanqiBefore = worldTotalOf(world0, 'sanqi');
  const gaoBefore = worldTotalOf(world0, 'jinchuang-gao');

  /* ---------------------------------------------------------------- */
  section('1. NPC 想讨一味三七：发布一条涌现式委托');

  const proposed = expectOk(
    '苏晚照 发布委托',
    proposeQuest(world0, {
      requestId: 'smoke-propose-1',
      npcId: 'su-wanzhao',
      title: '寻一味三七',
      want: '我旧疾复发，需一味三七入药',
      tier: 2,
      objective: { kind: 'deliver_item', itemId: 'sanqi', count: 1 },
      reward: { kind: 'item', itemId: 'jinchuang-gao', count: 1 },
      sourceDialogueId: 'dialogue-smoke-1',
      now: 1000,
    }),
  );
  let world = proposed.world;
  const questId = proposed.quest!.id;
  console.log(`    所求者是 ${getNpc(world, 'su-wanzhao')?.name}；接取方是 ${world.player.name}`);
  console.log(`    奖励预留：${proposed.quest!.rewardReservation ? '已锁定（别人抢不走了）' : '无需预留'}`);

  /* ---------------------------------------------------------------- */
  section('2. 只读真相：模型看得见的东西（不必猜）');

  const npcView = inspectNpc(world, 'su-wanzhao');
  console.log(`    ${npcView?.name} 可用：${npcView?.available.map((s) => `${s.name}×${s.count}`).join('、')}`);
  console.log(`    ${npcView?.name} 已预留：${npcView?.held.map((h) => `${h.name}×${h.count}`).join('、') || '（无）'}`);
  console.log(`    ${npcView?.name} 在手委托：${npcView?.openQuestId ?? '（无）'}`);
  const playerView = inspectPlayer(world);
  console.log(`    ${playerView.name} 可用：${playerView.available.map((s) => `${s.name}×${s.count}`).join('、')}`);

  /* ---------------------------------------------------------------- */
  section('3. 拒绝路径：这些都不该让世界动一下');

  expectRejected(
    '阿癞身无长物，拿不出奖励（背包枯竭闸门）',
    proposeQuest(world, {
      requestId: 'smoke-reject-1',
      npcId: 'a-lai',
      title: '去给我弄点吃的',
      want: '饿了',
      tier: 1,
      objective: { kind: 'has_item', itemId: 'rations', count: 1 },
      reward: { kind: 'item', itemId: 'rations', count: 1 },
      now: 1100,
    }),
    'reward_not_owned',
  );
  expectRejected(
    '同一个 NPC 再挂一条（串行任务链）',
    proposeQuest(world, {
      requestId: 'smoke-reject-2',
      npcId: 'su-wanzhao',
      title: '再来一件事',
      want: '顺便帮我把门板修了',
      tier: 1,
      objective: { kind: 'has_item', itemId: 'gancao', count: 1 },
      reward: { kind: 'item', itemId: 'jinchuang-gao', count: 1 },
      now: 1200,
    }),
    'npc_has_open_quest',
  );
  expectRejected(
    '小事给不起百年灵芝（档位上限）',
    proposeQuest(world, {
      requestId: 'smoke-reject-3',
      npcId: 'su-wanzhao',
      title: '小事一桩',
      want: '帮我把药碾子挪一挪',
      tier: 1,
      objective: { kind: 'has_item', itemId: 'gancao', count: 1 },
      reward: { kind: 'item', itemId: 'century-lingzhi', count: 1 },
      now: 1300,
    }),
    'reward_over_cap',
  );
  expectRejected(
    '所要之物就是奖励本身（自循环套利）',
    proposeQuest(world, {
      requestId: 'smoke-reject-4',
      npcId: 'su-wanzhao',
      title: '三七换三七',
      want: '拿你一株三七，换我一株三七',
      tier: 2,
      objective: { kind: 'deliver_item', itemId: 'sanqi', count: 1 },
      reward: { kind: 'item', itemId: 'sanqi', count: 1 },
      now: 1400,
    }),
    'self_loop_objective_reward',
  );
  expectRejected(
    '让玩家去打赢谁（战斗系统尚不存在）',
    proposeQuest(world, {
      requestId: 'smoke-reject-5',
      npcId: 'lu-xingzhou',
      title: '替我出气',
      want: '把后山那头野猪打跑',
      tier: 2,
      objective: { kind: 'defeat', targetId: 'boar' },
      reward: { kind: 'item', itemId: 'rations', count: 1 },
      now: 1500,
    }),
    'unsupported_objective',
  );

  assert.deepEqual(auditWorld(world), []);
  assert.equal(Object.keys(world.quests).length, 1);
  console.log(`    五条拒绝之后世界依然干净：任务 ${Object.keys(world.quests).length} 条、背包自检通过`);

  /* ---------------------------------------------------------------- */
  section('4. 玩家接取委托');

  world = expectOk('接取', acceptQuest(world, { requestId: 'smoke-accept-1', questId, now: 2000 })).world;

  /* ---------------------------------------------------------------- */
  section('5. 道具不够时提交：必须整笔拒绝');

  const hard = expectOk(
    '陆行舟 发布一条要两份三七的委托',
    proposeQuest(world, {
      requestId: 'smoke-propose-2',
      npcId: 'lu-xingzhou',
      title: '替我寻两份三七',
      want: '跑一趟商，想带两份三七回去',
      tier: 2,
      objective: { kind: 'deliver_item', itemId: 'sanqi', count: 2 },
      reward: { kind: 'item', itemId: 'rations', count: 2 },
      now: 2100,
    }),
  );
  world = hard.world;
  world = expectOk(
    '接取',
    acceptQuest(world, { requestId: 'smoke-accept-2', questId: hard.quest!.id, now: 2200 }),
  ).world;

  const before = JSON.stringify(world);
  expectRejected(
    '只交得出 1 份，任务要 2 份',
    submitQuest(world, {
      requestId: 'smoke-submit-fail',
      questId: hard.quest!.id,
      deliver: { itemId: 'sanqi', count: 2 },
      now: 2300,
    }),
    'player_item_insufficient',
  );
  assert.equal(JSON.stringify(world), before, '被拒之后世界应当逐字节不变');
  console.log('    世界逐字节未变：道具没扣、奖励没动、任务仍停在「已接取」');

  /* ---------------------------------------------------------------- */
  section('6. 正常提交：扣除 → 发奖 → 结算');

  world = expectOk(
    '交付三七×1',
    submitQuest(world, {
      requestId: 'smoke-submit-1',
      questId,
      deliver: { itemId: 'sanqi', count: 1 },
      now: 3000,
    }),
  ).world;

  /* ---------------------------------------------------------------- */
  section('7. 核对：资源守恒与任务收尾');

  console.log(`    玩家「${world.player.name}」可用：${fmt(world.player.inventory)}`);
  for (const npc of Object.values(world.npcs)) {
    console.log(`    ${npc.name} 可用：${fmt(npc.inventory)}`);
  }
  const sanqiAfter = worldTotalOf(world, 'sanqi');
  const gaoAfter = worldTotalOf(world, 'jinchuang-gao');
  console.log(`    三七总量 ${sanqiBefore} → ${sanqiAfter}；金疮药总量 ${gaoBefore} → ${gaoAfter}`);
  assert.equal(sanqiAfter, sanqiBefore, '三七应当守恒');
  assert.equal(gaoAfter, gaoBefore, '金疮药应当守恒');
  const su = getNpc(world, 'su-wanzhao');
  assert.ok(su);
  assert.equal(su.inventory.holds.length, 0, '结算后不该残留预留');
  assert.deepEqual(auditWorld(world), []);
  console.log('    守恒成立，且没有任何残留预留');

  /* ---------------------------------------------------------------- */
  section('8. 幂等：同一个 requestId 再提一次');

  const replay = expectOk(
    '重放同一笔提交',
    submitQuest(world, {
      requestId: 'smoke-submit-1',
      questId,
      deliver: { itemId: 'sanqi', count: 1 },
      now: 3100,
    }),
  );
  assert.equal(replay.world, world, '重放不该产生新世界');
  console.log('    没有第二次扣道具，也没有第二次发奖');

  /* ---------------------------------------------------------------- */
  section('9. 婉拒一条委托：预留会被释放');

  const spare = expectOk(
    '苏晚照 又攒出一件小事',
    proposeQuest(world, {
      requestId: 'smoke-propose-3',
      npcId: 'su-wanzhao',
      title: '替我收两把甘草',
      want: '药庐缺两把甘草',
      tier: 1,
      objective: { kind: 'deliver_item', itemId: 'gancao', count: 2 },
      reward: { kind: 'item', itemId: 'rations', count: 1 },
      now: 4000,
    }),
  );
  world = spare.world;
  world = expectOk(
    '玩家婉拒',
    declineQuest(world, { requestId: 'smoke-decline-1', questId: spare.quest!.id, now: 4100 }),
  ).world;
  const suAfterDecline = getNpc(world, 'su-wanzhao');
  assert.ok(suAfterDecline);
  assert.equal(suAfterDecline.inventory.holds.length, 0, '婉拒后应当没有残留预留');

  /* ---------------------------------------------------------------- */
  section('10. 事件流水（这条任务为什么存在，全都有据可查）');

  for (const event of world.events) {
    console.log(`    ${String(event.at).padStart(5)}  ${event.type.padEnd(16)} ${event.detail}`);
  }

  /* ---------------------------------------------------------------- */
  section('冒烟结论');

  const worldProblems = auditWorld(world);
  const itemProblems = auditItemTable();
  assert.deepEqual(worldProblems, []);
  assert.deepEqual(itemProblems, []);
  console.log(`    世界自检：通过（任务 ${Object.keys(world.quests).length} 条，事件 ${world.events.length} 条）`);
  console.log(`    道具表自检：通过（${itemProblems.length} 个问题）`);
  console.log('    裁决层可以脱离 LLM 独立工作 —— 接对话之前，先把这一层钉死。');
}

try {
  main();
} catch (err) {
  failures += 1;
  console.error(`\n冒烟中断：${err instanceof Error ? err.message : String(err)}`);
}

if (failures > 0) {
  console.error(`\n✘ 冒烟失败：${failures} 处不符合预期`);
  process.exit(1);
}
console.log('\n✔ 冒烟通过');
