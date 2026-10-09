import { useStore } from '../state/store.tsx';

interface Props {
  onOpenSettings: () => void;
}

/** 顶部状态栏：后端健康状态 + 当前模型 + 会话操作（FR-003 / FR-011）。 */
export function StatusBar({ onOpenSettings }: Props) {
  const { state, configured, refreshHealth, clearMessages, clearTasks } = useStore();
  const { health, healthError, settings, tasks } = state;

  const backendText = healthError
    ? `后端未连接：${healthError}`
    : health
      ? `后端正常 v${health.version}`
      : '正在检测后端…';

  const keyText = settings.apiKey
    ? 'Key：已填（浏览器）'
    : health?.defaults.hasKey
      ? 'Key：来自服务端环境变量'
      : 'Key：未配置';

  return (
    <header className="status-bar">
      <div className="status-bar__brand">
        <strong>凡尘·需求台</strong>
        <span className="status-bar__subtitle">与 AI 对话，需求自动入册</span>
      </div>

      <div className="status-bar__meta">
        <span className={`chip ${healthError ? 'chip--danger' : health ? 'chip--ok' : 'chip--muted'}`}>{backendText}</span>
        <span className="chip chip--muted">{settings.model}</span>
        <span className={`chip ${configured ? 'chip--ok' : 'chip--warn'}`}>{keyText}</span>
        <button type="button" className="btn btn--ghost" onClick={() => void refreshHealth()}>
          重新检测
        </button>
      </div>

      <div className="status-bar__actions">
        <button
          type="button"
          className="btn"
          onClick={() => {
            if (window.confirm('新建会话会清空当前对话记录，任务清单会保留。继续？')) clearMessages();
          }}
        >
          新建会话
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            if (tasks.length === 0) return;
            if (window.confirm(`确定清空全部 ${tasks.length} 条任务？此操作不可撤销。`)) clearTasks();
          }}
        >
          清空任务
        </button>
        <button type="button" className="btn btn--primary" onClick={onOpenSettings}>
          设置
        </button>
      </div>
    </header>
  );
}
