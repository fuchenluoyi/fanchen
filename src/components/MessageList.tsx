import { useEffect, useRef } from 'react';
import { useStore } from '../state/store.tsx';
import { formatTime } from '../lib/labels.ts';
import type { ChatMessage } from '../types.ts';

const STATUS_TEXT: Record<NonNullable<ChatMessage['status']>, string> = {
  streaming: '正在书写…',
  done: '',
  aborted: '已中断',
  error: '失败',
};

function MessageRow({ message, highlighted }: { message: ChatMessage; highlighted: boolean }) {
  const { state } = useStore();
  const isUser = message.role === 'user';
  const statusText = message.status ? STATUS_TEXT[message.status] : '';

  return (
    <article
      id={`msg-${message.id}`}
      className={[
        'message',
        isUser ? 'message--user' : 'message--assistant',
        highlighted ? 'message--highlight' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="message__head">
        <span className="message__author">{isUser ? '你' : '凡尘'}</span>
        <span className="message__time">{formatTime(message.createdAt)}</span>
        {statusText ? (
          <span className={`message__status message__status--${message.status}`}>{statusText}</span>
        ) : null}
      </div>

      {state.settings.showReasoning && message.reasoning ? (
        <details className="message__reasoning">
          <summary>思维链（{message.reasoning.length} 字）</summary>
          <pre>{message.reasoning}</pre>
        </details>
      ) : null}

      <div className="message__body">
        {message.content ? message.content : message.status === 'streaming' ? '…' : ''}
        {message.status === 'streaming' && message.content ? <span className="caret" /> : null}
      </div>

      {message.errorText ? <div className="message__error">{message.errorText}</div> : null}
    </article>
  );
}

/** 对话流（FR-001）。 */
export function MessageList() {
  const { state } = useStore();
  const containerRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const lastLength = useRef(0);

  // 内容增长时自动贴底，但用户手动上滚后不再强制拉回（AC-1.4）
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const grew = state.messages.length !== lastLength.current;
    lastLength.current = state.messages.length;
    if (stickToBottom.current || grew) {
      container.scrollTop = container.scrollHeight;
    }
  }, [state.messages]);

  // 「查看原话」定位（AC-14.2）
  useEffect(() => {
    const id = state.highlightMessageId;
    if (!id) return;
    const element = document.getElementById(`msg-${id}`);
    if (element) {
      stickToBottom.current = false;
      element.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    const timer = window.setTimeout(() => {
      stickToBottom.current = true;
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [state.highlightMessageId]);

  return (
    <div
      className="message-list"
      ref={containerRef}
      aria-live="polite"
      aria-label="对话记录"
      onScroll={(event) => {
        const el = event.currentTarget;
        stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      {state.messages.length === 0 ? (
        <div className="empty-hint">
          <p>在下面说点什么吧。比如：</p>
          <p className="empty-hint__example">「我想做一个给团队用的值班排班工具，需要支持换班申请和自动提醒。」</p>
          <p className="empty-hint__note">凡尘听到需求后，会自己把任务记到右边。</p>
        </div>
      ) : (
        state.messages.map((message) => (
          <MessageRow
            key={message.id}
            message={message}
            highlighted={state.highlightMessageId === message.id}
          />
        ))
      )}
    </div>
  );
}
