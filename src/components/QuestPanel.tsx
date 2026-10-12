import { useState } from 'react';
import { useStore } from '../state/store.tsx';
import { QUEST_STATUS_LABEL, formatTime } from '../lib/labels.ts';
import {
  OFFER_LEVEL_LABEL,
  QUEST_TIER_LABEL,
  TIER_LABEL,
  describeObjective,
  describeReward,
  getItem,
  getNpc,
  inspectNpc,
  questsOfNpc,
} from '../lib/quest/index.ts';
import type { NpcSnapshot, Quest } from '../lib/quest/index.ts';

/** 一次最多列几条委托（更早的还在世界里，只是不占版面） */
const MAX_VISIBLE_QUESTS = 6;

/** 按 id 取等级中文名（快照里给的是等级 id） */
function tierOf(itemId: string): string {
  const def = getItem(itemId);
  return def ? TIER_LABEL[def.tier] : '未知';
}

/**
 * 右栏顶部的「NPC 委托」区（npc 模式才渲染）。
 * 这是给玩家看的窗口：谁在求你、求什么、拿什么谢你、它的背包里还剩什么、
 * 哪件谢礼已经被哪条委托锁住（预留锁）。
 */
export function QuestPanel() {
  const { state, acceptQuest, declineQuest } = useStore();
  const [showBag, setShowBag] = useState(false);

  const npcId = state.settings.questNpcId;
  const npc = getNpc(state.world, npcId);
  const snapshot = inspectNpc(state.world, npcId);
  const allQuests = questsOfNpc(state.world, npcId);
  const quests = allQuests.slice(-MAX_VISIBLE_QUESTS).reverse(); // 新到旧

  if (!npc || !snapshot) {
    return (
      <div className="task-panel__candidates">
        <div className="task-panel__candidates-head">
          <span>NPC 委托</span>
        </div>
        <p className="empty-hint empty-hint--small">
          设置里选中的 NPC（{npcId}）不在世界里，请到「设置 → 对话模式」换一位。
        </p>
      </div>
    );
  }

  return (
    <div className="task-panel__candidates">
      <div className="task-panel__candidates-head">
        <span>
          NPC 委托 · <b>{npc.name}</b>
          <span className="badge badge--muted">{npc.title}</span>
        </span>
        <button
          type="button"
          className="btn btn--tiny btn--ghost"
          onClick={() => setShowBag((value) => !value)}
          aria-expanded={showBag}
        >
          NPC 背包 {showBag ? '▲' : '▼'}
        </button>
      </div>

      {showBag ? <NpcBag snapshot={snapshot} /> : null}

      {quests.length === 0 ? (
        <p className="empty-hint empty-hint--small">
          还没有委托。在左边跟 {npc.name} 搭话 —— 它想请你帮忙时，这里会冒出委托卡。
        </p>
      ) : (
        quests.map((quest) => (
          <QuestCard
            key={quest.id}
            quest={quest}
            npcName={npc.name}
            onAccept={() => acceptQuest(quest.id)}
            onDecline={() => declineQuest(quest.id, '玩家在委托面板上婉拒')}
          />
        ))
      )}

      {allQuests.length > MAX_VISIBLE_QUESTS ? (
        <p className="empty-hint empty-hint--small">
          只显示最近 {MAX_VISIBLE_QUESTS} 条（共 {allQuests.length} 条）。
        </p>
      ) : null}
    </div>
  );
}

function QuestCard({
  quest,
  npcName,
  onAccept,
  onDecline,
}: {
  quest: Quest;
  npcName: string;
  onAccept: () => void;
  onDecline: () => void;
}) {
  return (
    <article className="candidate">
      <div className="candidate__head">
        <span className="candidate__tag">NPC 所求</span>
        <span className="badge">{QUEST_TIER_LABEL[quest.tier]}</span>
        <span className="badge badge--muted">{QUEST_STATUS_LABEL[quest.status]}</span>
        <span className="badge">{OFFER_LEVEL_LABEL[quest.offerLevel]}</span>
        <span className="badge badge--muted">{formatTime(quest.createdAt)}</span>
      </div>

      <h4 className="candidate__title">{quest.title}</h4>
      <p className="candidate__detail">{quest.want}</p>

      <ul className="candidate__acceptance">
        <li>目标：{describeObjective(quest.objective)}</li>
        <li>谢礼：{describeReward(quest.reward)}</li>
      </ul>

      {quest.status === 'offered' ? (
        <div className="candidate__actions">
          <button type="button" className="btn btn--primary btn--sm" onClick={onAccept}>
            接取委托
          </button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={onDecline}>
            婉拒
          </button>
        </div>
      ) : null}

      {quest.status === 'accepted' ? (
        <p className="candidate__evidence">
          已接取 —— 在对话里把东西交给 {npcName} 即可（{describeObjective(quest.objective)}
          ）。交付由系统核对，{npcName} 说了不算。
        </p>
      ) : null}

      {quest.status === 'settled' ? (
        <p className="candidate__evidence">已了结：谢礼已发出，预留锁已核销。</p>
      ) : null}
    </article>
  );
}

function NpcBag({ snapshot }: { snapshot: NpcSnapshot }) {
  return (
    <div className="task__detail">
      <div className="task__label">可用道具</div>
      {snapshot.available.length === 0 ? (
        <p className="empty-hint empty-hint--small">背包空空 —— 拿不出谢礼，它也就不会发布委托。</p>
      ) : (
        <ul>
          {snapshot.available.map((entry) => (
            <li key={entry.itemId}>
              {entry.name}（{entry.itemId}）· {tierOf(entry.itemId)} · 值 {entry.unitValue} · ×{entry.count}
            </li>
          ))}
        </ul>
      )}

      <div className="task__label">已预留</div>
      {snapshot.held.length === 0 ? (
        <p className="empty-hint empty-hint--small">没有预留 —— 没有已答应出去的谢礼。</p>
      ) : (
        <ul>
          {snapshot.held.map((hold) => (
            <li key={`${hold.questId}-${hold.itemId}-${hold.count}`}>
              {hold.name} ×{hold.count} ← 被 {hold.questId} 锁着
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
