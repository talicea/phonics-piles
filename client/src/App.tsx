import { useCallback, useRef, useState } from 'react';
import { Home } from './components/Home';
import { DeckPicker, type DeckChoice } from './components/DeckPicker';
import { StudentView } from './components/StudentView';
import { TeacherView } from './components/TeacherView';
import { ConnectionBadge, Toasts } from './components/common';
import { useRoom, type EndedReason } from './hooks/useRoom';

const ENDED_TEXT: Record<EndedReason, { title: string; body: string }> = {
  'host-ended': { title: 'The game has ended', body: 'Your teacher ended this game. Thanks for playing!' },
  expired: { title: 'This game timed out', body: 'The room was open for too long or was left idle. Ask your teacher for a new code.' },
  'server-restart': { title: 'The server restarted', body: 'The game server was restarted, so this session is gone. Ask your teacher for a new room code.' },
  lost: { title: 'This game is no longer available', body: 'The room could not be found. It may have ended, expired, or the server may have restarted. Ask your teacher for a new room code.' },
  replaced: { title: 'Opened somewhere else', body: 'You joined this game from another tab or device, so this tab was disconnected.' },
};

export function App() {
  const room = useRoom();
  const { state } = room;
  const [setup, setSetup] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toasts, setToasts] = useState<{ id: number; text: string }[]>([]);
  const nextId = useRef(1);

  const notify = useCallback((text: string) => {
    const id = nextId.current++;
    setToasts((t) => [...t.slice(-2), { id, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);
  const dismiss = (id: number) => setToasts((t) => t.filter((x) => x.id !== id));

  const create = async (choice: DeckChoice) => {
    setBusy(true);
    const res = await room.createRoom(choice);
    setBusy(false);
    if (res.ok) setSetup(false);
    else notify(res.details?.length ? `${res.message} ${res.details[0]}` : res.message);
  };

  let screen;
  const { snapshot, session } = state;
  if (state.phase === 'active' && snapshot && session) {
    screen = session.role === 'host'
      ? <TeacherView snapshot={snapshot} conn={state.conn} actions={room.actions} endGame={room.endGame} notify={notify} />
      : <StudentView snapshot={snapshot} conn={state.conn} actions={room.actions} participantId={session.you.participantId ?? ''} displayName={session.you.displayName} onLeave={room.leave} notify={notify} />;
  } else if (state.phase === 'resuming') {
    screen = (
      <main className="center-screen">
        <h1 className="brand">Phonics Piles</h1>
        <p role="status" aria-busy="true">Reconnecting to your game…</p>
        <ConnectionBadge status={state.conn} />
      </main>
    );
  } else if (state.phase === 'ended' && state.ended) {
    const t = ENDED_TEXT[state.ended];
    screen = (
      <main className="center-screen" role="alert">
        <h1 className="brand">{t.title}</h1>
        <p>{t.body}</p>
        <button type="button" className="btn primary big" onClick={() => { room.dismissEnded(); setSetup(false); }}>Back to start</button>
      </main>
    );
  } else if (setup) {
    screen = (
      <main className="setup">
        <header className="topbar"><h1 className="brand small">Phonics Piles <span className="muted">· New game</span></h1><ConnectionBadge status={state.conn} /></header>
        <div className="panel"><DeckPicker confirmLabel="Start game" busy={busy} offline={state.conn !== 'online'} onChoose={(c) => void create(c)} onCancel={() => setSetup(false)} /></div>
      </main>
    );
  } else {
    screen = (
      <>
        <Home joinRoom={room.joinRoom} onTeacher={() => setSetup(true)} offline={state.conn !== 'online'} />
        <footer className="foot"><ConnectionBadge status={state.conn} /></footer>
      </>
    );
  }
  return <>{screen}<Toasts items={toasts} onDismiss={dismiss} /></>;
}
