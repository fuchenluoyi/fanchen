import { useStore } from '../state/store.tsx';
import { CATEGORY_LABEL, ORIGIN_LABEL, PRIORITY_LABEL } from '../lib/labels.ts';
import type { TaskCandidate } from '../types.ts';

/** 待确认的「任务卡」——模仿游戏里接任务的仪式感（FR-007）。 */
export function CandidateCard({ candidate }: { candidate: TaskCandidate }) {
  const { acceptCandidate, dropCandidate } = useStore();

  return (
    <article className="candidate">
      <div className="candidate__head">
        <span className="candidate__tag">发现需求</span>
        <span className={`badge badge--${candidate.priority.toLowerCase()}`}>{PRIORITY_LABEL[candidate.priority]}</span>
        <span className="badge">{CATEGORY_LABEL[candidate.category]}</span>
        <span className={`badge badge--origin-${candidate.origin}`}>{ORIGIN_LABEL[candidate.origin]}</span>
        <span className="badge badge--muted">置信 {(candidate.confidence * 100).toFixed(0)}%</span>
      </div>

      <h4 className="candidate__title">{candidate.title}</h4>
      <p className="candidate__detail">{candidate.detail}</p>

      {candidate.acceptance.length > 0 ? (
        <ul className="candidate__acceptance">
          {candidate.acceptance.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ul>
      ) : null}

      {candidate.evidence ? (
        <p className="candidate__evidence" title="来自对话原话">
          「{candidate.evidence}」
        </p>
      ) : null}

      <div className="candidate__actions">
        <button type="button" className="btn btn--primary btn--sm" onClick={() => acceptCandidate(candidate.id)}>
          接取任务
        </button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => dropCandidate(candidate.id)}>
          忽略
        </button>
      </div>
    </article>
  );
}
