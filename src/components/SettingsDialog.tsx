import { useEffect, useState } from 'react';
import { useStore } from '../state/store.tsx';
import { DEFAULT_SETTINGS, DEFAULT_SYSTEM_PROMPT, NPC_ID_LIST, NPC_NAME } from '../lib/settings.ts';
import { NPC_SEEDS } from '../lib/quest/world.ts';
import type { ChatMode, ExtractMode, Settings } from '../types.ts';

interface Props {
  open: boolean;
  onClose: () => void;
}

const EXTRACT_MODE_OPTIONS: Array<{ value: ExtractMode; label: string }> = [
  { value: 'auto', label: '自动：规则命中才调用模型（推荐，省钱）' },
  { value: 'llm', label: '只用模型抽取' },
  { value: 'rule', label: '只用规则引擎（不调用模型）' },
  { value: 'off', label: '关闭抽取通道' },
];

/** 设置面板（FR-002 / FR-003）。 */
export function SettingsDialog({ open, onClose }: Props) {
  const { state, updateSettings, testConnection, listModels, resetAll, resetConversation } = useStore();
  const [draft, setDraft] = useState<Settings>(state.settings);
  const [showKey, setShowKey] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [status, setStatus] = useState<{ kind: 'ok' | 'error' | 'info'; text: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(state.settings);
    setStatus(null);
    setModels([]);
    setPending(null);
    // 仅在打开时同步一次草稿
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  /** 只改某一位 NPC 的人格补充（别的两位不受影响） */
  const setPersona = (npcId: string, text: string) =>
    setDraft((current) => ({
      ...current,
      npcPersonas: { ...current.npcPersonas, [npcId]: text },
    }));

  const clearPersona = (npcId: string) =>
    setDraft((current) => {
      const next = { ...current.npcPersonas };
      delete next[npcId];
      return { ...current, npcPersonas: next };
    });

  const doListModels = async () => {
    setPending('正在拉取模型列表…');
    setStatus(null);
    try {
      const list = await listModels({ baseUrl: draft.baseUrl, apiKey: draft.apiKey });
      setModels(list);
      setStatus(
        list.length > 0
          ? { kind: 'ok', text: `拉到 ${list.length} 个模型` }
          : { kind: 'info', text: '该服务没有返回模型列表，请手动填写模型名' },
      );
    } catch (err) {
      setStatus({ kind: 'error', text: (err as Error)?.message ?? '拉取失败' });
    } finally {
      setPending(null);
    }
  };

  const doSaveAndTest = async () => {
    updateSettings(draft);
    setPending('正在测试对话…');
    setStatus(null);
    const result = await testConnection();
    setPending(null);
    setStatus({ kind: result.ok ? 'ok' : 'error', text: result.message });
  };

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="设置">
      <div className="modal__backdrop" onClick={onClose} />
      <div className="modal__panel">
        <header className="modal__header">
          <h2>设置</h2>
          <button type="button" className="btn btn--ghost btn--sm" onClick={onClose}>
            关闭
          </button>
        </header>

        <div className="modal__body">
          <section className="form-section">
            <h3>对话模式</h3>
            <label className="field">
              <span>模式</span>
              <select
                value={draft.chatMode}
                onChange={(event) => set('chatMode', event.target.value as ChatMode)}
              >
                <option value="npc">NPC 委托：你扮演一位 NPC，它有自己想要的东西，会向你发布委托</option>
                <option value="desk">需求台：原模式，把对话里的需求登记成任务清单</option>
              </select>
              <small>
                {draft.chatMode === 'npc'
                  ? '模型会拿到三个提案工具（发布委托 / 交付结算 / 婉拒）与 NPC 自己的背包视角；东西交没交到由系统核对，NPC 说了不算。'
                  : '原样保留：抽取通道、create_task、候选卡与去重都不变。'}
              </small>
            </label>

            {draft.chatMode === 'npc' ? (
              <label className="field">
                <span>出面 NPC</span>
                <select value={draft.questNpcId} onChange={(event) => set('questNpcId', event.target.value)}>
                  {NPC_SEEDS.map((npc) => (
                    <option key={npc.id} value={npc.id}>
                      {npc.name}（{npc.title}）
                    </option>
                  ))}
                </select>
                <small>每位 NPC 有自己的背包；背包里没有拿得出手的谢礼时，它发不出委托。</small>
              </label>
            ) : null}
          </section>

          <section className="form-section">
            <h3>模型接入（OpenAI 兼容）</h3>
            <label className="field">
              <span>Base URL</span>
              <input
                type="text"
                value={draft.baseUrl}
                placeholder="https://api.deepseek.com/v1"
                onChange={(event) => set('baseUrl', event.target.value)}
              />
              <small>填到 /v1 即可；也可直接粘贴完整的 /chat/completions 地址。</small>
            </label>

            <label className="field">
              <span>API Key</span>
              <span className="field__row">
                <input
                  type={showKey ? 'text' : 'password'}
                  value={draft.apiKey}
                  placeholder={state.health?.defaults.hasKey ? '留空则使用服务端环境变量里的 Key' : 'sk-...'}
                  onChange={(event) => set('apiKey', event.target.value)}
                  autoComplete="off"
                />
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => setShowKey((v) => !v)}>
                  {showKey ? '隐藏' : '显示'}
                </button>
              </span>
              <small>只保存在本机 localStorage；服务端仅做转发，不落盘、不记日志。</small>
            </label>

            <label className="field">
              <span>模型</span>
              <span className="field__row">
                <input
                  type="text"
                  value={draft.model}
                  placeholder="deepseek-chat"
                  onChange={(event) => set('model', event.target.value)}
                  list="model-options"
                />
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => void doListModels()}>
                  拉取列表
                </button>
              </span>
              <datalist id="model-options">
                {models.map((model) => (
                  <option key={model} value={model} />
                ))}
              </datalist>
            </label>

            <label className="field">
              <span>
                温度 <b>{draft.temperature.toFixed(2)}</b>
              </span>
              <input
                type="range"
                min={0}
                max={2}
                step={0.05}
                value={draft.temperature}
                onChange={(event) => set('temperature', Number(event.target.value))}
              />
            </label>

            <div className="field field--inline">
              <label>
                <input type="checkbox" checked={draft.stream} onChange={(e) => set('stream', e.target.checked)} />
                流式输出
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={draft.enableTools}
                  onChange={(e) => set('enableTools', e.target.checked)}
                />
                {draft.chatMode === 'npc' ? '允许模型调用提案工具' : '允许模型调用 create_task'}
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={draft.showReasoning}
                  onChange={(e) => set('showReasoning', e.target.checked)}
                />
                显示思维链
              </label>
            </div>
          </section>

          <section className="form-section">
            <h3>需求抽取</h3>
            {draft.chatMode === 'npc' ? (
              <div className="notice notice--info">
                npc 模式下不走需求抽取通道，这一节的设置只在「需求台」模式生效。
              </div>
            ) : null}
            <label className="field">
              <span>抽取策略</span>
              <select
                value={draft.extractMode}
                onChange={(event) => set('extractMode', event.target.value as ExtractMode)}
              >
                {EXTRACT_MODE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <div className="field field--inline">
              <label>
                <input
                  type="checkbox"
                  checked={draft.autoAccept}
                  onChange={(e) => set('autoAccept', e.target.checked)}
                />
                抽到需求直接入列（不弹任务卡）
              </label>
            </div>

            <label className="field">
              <span>
                去重阈值 <b>{draft.dedupeThreshold.toFixed(2)}</b>
              </span>
              <input
                type="range"
                min={0.3}
                max={0.95}
                step={0.01}
                value={draft.dedupeThreshold}
                onChange={(event) => set('dedupeThreshold', Number(event.target.value))}
              />
              <small>越接近 1 越宽松（更少判为重复）；0.62 左右适合中文短标题。</small>
            </label>

            <label className="field">
              <span>上下文条数上限</span>
              <input
                type="number"
                min={2}
                max={60}
                value={draft.historyLimit}
                onChange={(event) => set('historyLimit', Number(event.target.value))}
              />
            </label>
          </section>

          <section className="form-section">
            <h3>{draft.chatMode === 'npc' ? '人格补充（按 NPC）' : '角色人格'}</h3>
            {draft.chatMode === 'npc' ? (
              <>
                <div className="field field--inline">
                  {NPC_ID_LIST.map((id) => (
                    <button
                      key={id}
                      type="button"
                      className={`btn btn--tiny ${id === draft.questNpcId ? 'btn--active' : 'btn--ghost'}`}
                      onClick={() => set('questNpcId', id)}
                      title={id === draft.questNpcId ? '正在编辑这一位' : `切到 ${NPC_NAME[id] ?? id}`}
                    >
                      {NPC_NAME[id] ?? id}
                    </button>
                  ))}
                </div>
                <label className="field">
                  <span>为 {NPC_NAME[draft.questNpcId] ?? draft.questNpcId} 写人格补充（可选）</span>
                  <textarea
                    rows={8}
                    value={draft.npcPersonas[draft.questNpcId] ?? ''}
                    onChange={(event) => setPersona(draft.questNpcId, event.target.value)}
                  />
                  <small>
                    这段只追加给**这一位** NPC（三人各写各的，互不串味）。留空 = 只用内置框架。
                    以前那一段全局补充不会被带进来，需要的话在这里按人重填。
                  </small>
                </label>
                <div className="field field--inline">
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => clearPersona(draft.questNpcId)}>
                    清空这一位的补充
                  </button>
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => setDraft(DEFAULT_SETTINGS)}>
                    恢复全部默认值
                  </button>
                </div>
              </>
            ) : (
              <>
                <label className="field">
                  <span>System Prompt</span>
                  <textarea
                    rows={8}
                    value={draft.systemPrompt}
                    onChange={(event) => set('systemPrompt', event.target.value)}
                  />
                  <small>整段直接作为 system 提示词发给模型。</small>
                </label>
                <div className="field field--inline">
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => set('systemPrompt', DEFAULT_SYSTEM_PROMPT)}
                  >
                    恢复默认人格
                  </button>
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => setDraft(DEFAULT_SETTINGS)}>
                    恢复全部默认值
                  </button>
                </div>
              </>
            )}
          </section>

          {status ? <div className={`notice notice--${status.kind}`}>{status.text}</div> : null}
          {pending ? <div className="notice notice--info">{pending}</div> : null}
        </div>

        <footer className="modal__footer">
          <button
            type="button"
            className="btn btn--ghost btn--danger-text"
            onClick={() => {
              if (window.confirm('将清空对话、任务与委托进度，但保留设置与 API Key。确定继续？')) {
                resetConversation();
                onClose();
              }
            }}
          >
            重置对话与进度
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--danger-text"
            onClick={() => {
              if (window.confirm('将清空设置、对话与任务三份本地数据，确定继续？')) {
                resetAll();
                onClose();
              }
            }}
          >
            清空全部本地数据
          </button>
          <span className="modal__footer-spacer" />
          <button type="button" className="btn btn--ghost" onClick={() => void doSaveAndTest()}>
            保存并测试对话
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => {
              updateSettings(draft);
              onClose();
            }}
          >
            保存
          </button>
        </footer>
      </div>
    </div>
  );
}
