import { useState, type KeyboardEvent } from 'react';
import { useStore } from '../state/store.tsx';

/** 输入区（FR-001 / FR-013）。 */
export function Composer() {
  const { state, send, stop, configured } = useStore();
  const [text, setText] = useState('');
  const busy = state.busy;

  const submit = () => {
    const value = text.trim();
    if (!value || busy) return;
    setText('');
    void send(value);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    // 中文输入法组词中，回车用于选词，不发送
    if (event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  };

  return (
    <div className="composer">
      <textarea
        className="composer__input"
        value={text}
        rows={3}
        placeholder={configured ? '说点什么…（Enter 发送，Shift+Enter 换行）' : '还没配置 API Key，请先点右上角「设置」'}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        aria-label="输入消息"
      />
      <div className="composer__actions">
        <span className="composer__hint">
          {busy ? '凡尘正在落笔…' : `共 ${state.messages.length} 条消息`}
        </span>
        {busy ? (
          <button type="button" className="btn btn--danger" onClick={stop}>
            停止
          </button>
        ) : (
          <button type="button" className="btn btn--primary" onClick={submit} disabled={!text.trim()}>
            发送
          </button>
        )}
      </div>
    </div>
  );
}
