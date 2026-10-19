import { useMemo, useState } from 'react';
import { useStore } from '../state/store.tsx';
import { CandidateCard } from './CandidateCard.tsx';
import { PlayerBagPanel, QuestPanel } from './QuestPanel.tsx';
import { TaskItem } from './TaskItem.tsx';
import { CHANNEL_LABEL, formatTime } from '../lib/labels.ts';
import type { TaskStatus } from '../types.ts';

type Filter = 'all' | TaskStatus;

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'pending', label: '待办' },
  { key: 'active', label: '进行中' },
  { key: 'done', label: '完成' },
  { key: 'dropped', label: '废弃' },
];

/** 右栏：任务清单（FR-007 / FR-008 / FR-014）。 */
export function TaskPanel() {
  const { state, acceptAllCandidates } = useStore();
  const [filter, setFilter] = useState<Filter>('all');
  const [sortByPriority, setSortByPriority] = useState(false);
  const [showAudit, setShowAudit] = useState(false);

  const counts = useMemo(() => {
    const base: Record<Filter, number> = { all: state.tasks.length, pending: 0, active: 0, done: 0, dropped: 0 };
    for (const task of state.tasks) base[task.status] += 1;
    return base;
  }, [state.tasks]);

  const visibleTasks = useMemo(() => {
    const list = filter === 'all' ? state.tasks : state.tasks.filter((task) => task.status === filter);
    if (!sortByPriority) return list;
    const order = { P0: 0, P1: 1, P2: 2 } as const;
    return [...list].sort((a, b) => order[a.priority] - order[b.priority]);
  }, [state.tasks, filter, sortByPriority]);

  const latestAudit = state.audits[0];

  // 行囊里的「送给他」要知道送给谁：跟委托区同一位 NPC
  const npcName = state.world.npcs[state.settings.questNpcId]?.name ?? '这位';

  return (
    <aside className="panel task-panel" aria-label="任务清单">
      <div className="task-panel__header">
        <h2>
          任务清单
          <span className="task-panel__count" aria-label={`共 ${state.tasks.length} 条任务`}>
            {state.tasks.length}
          </span>
        </h2>
        <div className="task-panel__filters">
          {FILTERS.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`btn btn--tiny ${filter === item.key ? 'btn--active' : 'btn--ghost'}`}
              onClick={() => setFilter(item.key)}
            >
              {item.label}
              <span className="btn__count">{counts[item.key]}</span>
            </button>
          ))}
          <button
            type="button"
            className={`btn btn--tiny ${sortByPriority ? 'btn--active' : 'btn--ghost'}`}
            onClick={() => setSortByPriority((value) => !value)}
            title="按优先级排序"
          >
            优先级
          </button>
        </div>
      </div>

      {/* npc 模式：委托区在最上面（刷新即见） */}
      {state.settings.chatMode === 'npc' ? <QuestPanel /> : null}

      {state.candidates.length > 0 ? (
        <div className="task-panel__candidates">
          <div className="task-panel__candidates-head">
            <span>
              {state.candidates.length} 条待确认需求
              {state.settings.autoAccept ? '' : '（需要你点头才算接取）'}
            </span>
            <button type="button" className="btn btn--tiny btn--primary" onClick={acceptAllCandidates}>
              全部接取
            </button>
          </div>
          {state.candidates.map((candidate) => (
            <CandidateCard key={candidate.id} candidate={candidate} />
          ))}
        </div>
      ) : null}

      <div className="task-panel__list">
        {visibleTasks.length === 0 ? (
          <p className="empty-hint empty-hint--small">
            {state.tasks.length === 0
              ? state.settings.chatMode === 'npc'
                ? '需求清单在这里是空的 —— 现在跑的是 NPC 委托模式，往上看「NPC 委托」区。'
                : '还没有任务。当凡尘的话里出现需求时，这里会自动冒出任务卡。'
              : '该状态下没有任务。'}
          </p>
        ) : (
          visibleTasks.map((task) => <TaskItem key={task.id} task={task} />)
        )}
      </div>

      {/* npc 模式：玩家自己的行囊放在需求清单占位提示下面（A-2） */}
      {state.settings.chatMode === 'npc' ? (
        <PlayerBagPanel npcId={state.settings.questNpcId} npcName={npcName} />
      ) : null}

      <div className="task-panel__footer">
        <button type="button" className="btn btn--tiny btn--ghost" onClick={() => setShowAudit((value) => !value)}>
          抽取审计 {showAudit ? '▲' : '▼'}
        </button>
        {latestAudit ? (
          <span className="task-panel__audit-summary">
            最近一次：{CHANNEL_LABEL[latestAudit.channel] ?? latestAudit.channel}，
            产出 {latestAudit.produced}，去重 {latestAudit.dropped}，{latestAudit.durationMs} ms
          </span>
        ) : (
          <span className="task-panel__audit-summary">尚无抽取记录</span>
        )}
      </div>

      {showAudit ? (
        <div className="audit">
          {state.audits.length === 0 ? (
            <p className="empty-hint empty-hint--small">还没有审计记录。</p>
          ) : (
            <ol className="audit__list">
              {state.audits.map((entry) => (
                <li key={entry.id}>
                  <div className="audit__row">
                    <span className="badge badge--muted">{formatTime(entry.at)}</span>
                    <span className={`badge ${entry.triggered ? 'badge--ok' : ''}`}>
                      {entry.triggered ? '命中' : '未命中'}
                    </span>
                    <span className="badge">{CHANNEL_LABEL[entry.channel] ?? entry.channel}</span>
                    <span className="badge badge--muted">
                      +{entry.produced} / -{entry.dropped}
                    </span>
                  </div>
                  {entry.reasons.length > 0 ? <p className="audit__text">依据：{entry.reasons.join(' · ')}</p> : null}
                  {entry.note ? <p className="audit__text audit__text--muted">{entry.note}</p> : null}
                </li>
              ))}
            </ol>
          )}
        </div>
      ) : null}
    </aside>
  );
}
