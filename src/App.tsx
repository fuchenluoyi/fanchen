import { useState } from 'react';
import { StoreProvider, useStore } from './state/store.tsx';
import { StatusBar } from './components/StatusBar.tsx';
import { ChatPanel } from './components/ChatPanel.tsx';
import { TaskPanel } from './components/TaskPanel.tsx';
import { SettingsDialog } from './components/SettingsDialog.tsx';

function Shell() {
  const { state } = useStore();
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <div className="app">
      <StatusBar onOpenSettings={() => setSettingsOpen(true)} />
      <main className="app__main">
        <ChatPanel />
        <TaskPanel />
      </main>
      {state.toast ? (
        <div className="toast" role="status">
          {state.toast}
        </div>
      ) : null}
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}

export default function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  );
}
