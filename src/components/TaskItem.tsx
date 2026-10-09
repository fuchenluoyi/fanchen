import { useState } from 'react';
import { useStore } from '../state/store.tsx';
import { CATEGORY_LABEL, ORIGIN_LABEL, PRIORITY_LABEL, STATUS_LABEL, formatTime } from '../lib/labels.ts';
import type { Task, TaskStatus } from '../types.ts';

const NEXT_ACTIONS: Record<TaskStatus, Array<{ label: string; status: TaskStatus }>> = {
  pending: [
    { label: '开始', status: 'active' },
    { label: '完成', status: 'done' },
    { label: '废弃', status: 'dropped' },
  ],
  active: [
    { label: '完成', status: 'done' },
    { label: '挂起', status: 'pending' },
    { label: '废弃', status: 'dropped' },
  ],
  done: [
    { label: '重开', status: 'pending' },
    { label: '废弃', status: 'dropped' },
  ],
  dropped: [
    { label: '恢复', status: 'pending' },
    { label: '完成', status: 'done' },
  ],
};

/** 单条任务卡片（FR-008）。 */
export function TaskItem({ task }: { task: Task }) {
  const { setTaskStatus, removeTask, highlightMessage } = useStore();
  const [expanded, setExpanded] = useState(false);

  return (
    <article className={`task task--${task.status}`}>
      <div className="task__head">
        <span className={`badge badge--${task.priority.toLowerCase()}`}>{PRIORITY_LABEL[task.priority]}</span>
        <span className={`badge badge--status-${task.status}`}>{STATUS_LABEL[task.status]}</span>
        <span className="badge">{CATEGORY_LABEL[task.category]}</span>
        <span className={`badge badge--origin-${task.origin}`}>{ORIGIN_LABEL[task.origin]}</span>
        <span className="badge badge--muted">{formatTime(task.createdAt)}</span>
      </div>

      <h4 className="task__title" onClick={() => setExpanded((value) => !value)} role="button" tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setExpanded((value) => !value);
          }
        }}
      >
        {task.title}
      </h4>

      {expanded ? (
        <div className="task__detail">
          <p>{task.detail}</p>
          {task.acceptance.length > 0 ? (
            <>
              <div className="task__label">验收要点</div>
              <ul>
                {task.acceptance.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            </>
          ) : null}
          {task.evidence ? (
            <>
              <div className="task__label">来自原话</div>
              <p className="task__evidence">「{task.evidence}」</p>
            </>
          ) : null}
          {task.triggerReasons.length > 0 ? (
            <>
              <div className="task__label">触发依据</div>
              <p className="task__reasons">{task.triggerReasons.join(' · ')}</p>
            </>
          ) : null}
        </div>
      ) : null}

      <div className="task__actions">
        {NEXT_ACTIONS[task.status].map((action) => (
          <button
            key={action.status}
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => setTaskStatus(task.id, action.status)}
          >
            {action.label}
          </button>
        ))}
        {task.sourceMessageId ? (
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => highlightMessage(task.sourceMessageId)}
          >
            查看原话
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn--ghost btn--sm btn--danger-text"
          onClick={() => {
            if (window.confirm(`删除任务「${task.title}」？`)) removeTask(task.id);
          }}
        >
          删除
        </button>
      </div>
    </article>
  );
}
