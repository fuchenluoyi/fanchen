import { Composer } from './Composer.tsx';
import { MessageList } from './MessageList.tsx';
import { useStore } from '../state/store.tsx';
import { CHAT_MODE_LABEL } from '../lib/labels.ts';
import { NPC_SEEDS, getNpc, progressToNextStage } from '../lib/quest/index.ts';
import { threadMessageCounts } from '../lib/threads.ts';

/** 一格很轻的进度条（不引 CSS，用字符画） */
const PROGRESS_CELLS = 5;

function progressBar(ratio: number): string {
  const filled = Math.min(PROGRESS_CELLS, Math.max(0, Math.round(ratio * PROGRESS_CELLS)));
  return `${'▮'.repeat(filled)}${'▯'.repeat(PROGRESS_CELLS - filled)}`;
}

/**
 * 左栏：对话区。
 *
 * 顶部写明「正在与谁交谈」+ 你们的关系阶段，并给出 NPC 切换下拉 —— **切人即切会话**：
 * 每个 NPC 一条独立线索，各自的历史、人设、委托互不污染（用户明确要求）。
 */
export function ChatPanel() {
  const { state, updateSettings } = useStore();
  const npcMode = state.settings.chatMode === 'npc';
  const npc = getNpc(state.world, state.settings.questNpcId);
  const counts = threadMessageCounts(state.messages);
  // 关系阶段（单向不回落：传 stagePeak 进去）
  const progress = npc
    ? progressToNextStage(
        state.world.player.affinity[npc.id] ?? 0,
        state.world.player.stagePeak[npc.id],
      )
    : null;

  return (
    <section className="panel chat-panel" aria-label="对话区">
      {/* 复用任务面板那份头栏样式，避免为此新增 CSS */}
      <div className="task-panel__candidates-head">
        <span>
          {npcMode ? (
            npc ? (
              <>
                正在与 <b>{npc.name}</b> · {npc.title} 交谈
              </>
            ) : (
              <>选中的 NPC 不在世界里，去「设置 → 对话模式」换一位</>
            )
          ) : (
            <>需求台 · 说书人「凡尘」</>
          )}
          <span className="badge badge--muted">{CHAT_MODE_LABEL[state.settings.chatMode]}</span>
          {npcMode && npc && progress ? (
            <span
              className="badge badge--muted"
              title={
                progress.nextThreshold === null
                  ? `你们的关系：${progress.label}（好感度 ${progress.affinity}，已经到顶）`
                  : `你们的关系：${progress.label}（好感度 ${progress.affinity}，距下一阶段还差 ${progress.toNext}）`
              }
            >
              关系 {progress.label} {progressBar(progress.ratio)}
            </span>
          ) : null}
        </span>

        {npcMode ? (
          <select
            className="btn btn--tiny"
            value={state.settings.questNpcId}
            aria-label="切换 NPC（每位 NPC 一条独立会话）"
            title="切换 NPC 会切到对应会话，互不影响"
            onChange={(event) => updateSettings({ questNpcId: event.target.value })}
          >
            {NPC_SEEDS.map((seed) => (
              <option key={seed.id} value={seed.id}>
                {seed.name}（{seed.title}）{counts[seed.id] ? ` · ${counts[seed.id]} 条` : ''}
              </option>
            ))}
          </select>
        ) : null}
      </div>

      <MessageList />
      <Composer />
    </section>
  );
}
