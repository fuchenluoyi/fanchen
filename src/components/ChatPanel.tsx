import { Composer } from './Composer.tsx';
import { MessageList } from './MessageList.tsx';

/** 左栏：对话区。 */
export function ChatPanel() {
  return (
    <section className="panel chat-panel" aria-label="对话区">
      <MessageList />
      <Composer />
    </section>
  );
}
