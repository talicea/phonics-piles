import type { RoomSnapshot } from '@shared/index';
import { useState } from 'react';
import { Board } from './Board';
import { Table } from './Table';
import { TracingCanvas } from './TracingCanvas';
import { ConnectionBadge, ViewToggle, type BoardViewMode } from './common';
import type { ConnStatus, useRoom } from '../hooks/useRoom';
import { downloadPracticeFile } from '../practiceFile';

type Actions = ReturnType<typeof useRoom>['actions'];

export function StudentView({ snapshot, conn, actions, participantId, displayName, onLeave, notify }: {
  snapshot: RoomSnapshot; conn: ConnStatus; actions: Actions; participantId: string; displayName: string; onLeave(): void; notify(msg: string): void;
}) {
  const { permissions, presence, deck, board, locks, roomCode, practice } = snapshot;
  const classicLink = new URLSearchParams(window.location.search).get('view') === 'arrange';
  const [view, setView] = useState<BoardViewMode>(classicLink ? 'arrange' : 'table');
  const canManipulate = permissions.mode === 'all-students' || (permissions.mode === 'one-student' && permissions.activeStudentId === participantId);
  const myPractice = practice?.lists?.[participantId] ?? [];
  const [tracingCardId, setTracingCardId] = useState<string | null>(null);
  const tracingCard = myPractice.find((c) => c.id === tracingCardId) ?? null;
  const status =
    permissions.mode === 'all-students' ? 'You can move cards.'
    : permissions.mode === 'one-student' ? (canManipulate ? 'It’s your turn to move cards.' : 'Another student is moving cards. Watch the board.')
    : 'Your teacher is moving the cards. Watch the board.';

  return (
    <main className="student">
      <header className="topbar">
        <h1 className="brand small">Phonics Piles</h1>
        <span className="who">Room <strong data-testid="room-code">{roomCode}</strong> · {displayName}</span>
        <ConnectionBadge status={conn} />
        <button type="button" className="btn" onClick={onLeave}>Leave</button>
      </header>
      {!presence.hostConnected && <p className="banner" role="status">Your teacher’s screen is reconnecting…</p>}
      <p className={`banner ${canManipulate ? 'go' : ''}`} role="status" data-testid="student-status">{canManipulate ? '✋ ' : '👀 '}{status}</p>
      <div className="view-row">
        {canManipulate && <ViewToggle mode={view} onChange={setView} />}
      </div>

      {myPractice.length > 0 && (
        <section className="panel practice-panel" aria-label="Your tracing practice">
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: '.4rem' }}>
            <h2 className="small" style={{ margin: 0 }}>✏️ Your practice list ({myPractice.length})</h2>
            <button type="button" className="btn small" onClick={() => downloadPracticeFile(displayName || 'student', myPractice)}>
              Save JSON
            </button>
          </div>
          <div className="practice-chips">
            {myPractice.map((c) => (
              <button key={c.id} type="button"
                className={`chip practice-chip${tracingCardId === c.id ? ' on' : ''}`}
                onClick={() => setTracingCardId((id) => id === c.id ? null : c.id)}>
                {c.text}
              </button>
            ))}
          </div>
          {tracingCard && (
            <div style={{ marginTop: '.6rem' }}>
              <TracingCanvas
                card={{ text: tracingCard.text, cat: tracingCard.cat, count: tracingCard.count, lesson: tracingCard.lesson }}
                vibrate
                onStreamStart={() => { void actions.practiceStart({ text: tracingCard.text, cat: tracingCard.cat, count: tracingCard.count, lesson: tracingCard.lesson }); }}
                onStreamPoints={(pts) => { void actions.practicePoints(pts); }}
                onStreamEnd={() => { void actions.practiceEnd(); }}
                onSuccess={() => notify(`Nice work on “${tracingCard.text}”!`)}
              />
              <div className="row" style={{ marginTop: '.4rem' }}>
                <button type="button" className="btn small" onClick={() => setTracingCardId(null)}>Close</button>
                <button type="button" className="btn small"
                  onClick={() => { void actions.practiceUnmark(participantId, tracingCard.id); setTracingCardId(null); }}>
                  Remove from my list
                </button>
              </div>
            </div>
          )}
        </section>
      )}
      {!classicLink && (!canManipulate || view === 'table') ? (
        <Table board={board} deck={deck} canManipulate={canManipulate} statusMessage=""
          onDraw={actions.draw} onUndo={actions.undo} onRecycle={actions.recycle} onShuffle={actions.shufflePile}
          onFlip={actions.flip} notify={notify} />
      ) : (
        <Board
          board={board} locks={locks} deck={deck} canManipulate={canManipulate} isHost={false} myOwnerId={participantId} statusMessage={status}
          onLock={actions.lock} onUnlock={actions.unlock} onMove={actions.move} onFlip={actions.flip} onShufflePile={actions.shufflePile} notify={notify}
        />
      )}
    </main>
  );
}
