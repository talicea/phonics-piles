import type { RoomSnapshot } from '@shared/index';
import { Board } from './Board';
import { ConnectionBadge } from './common';
import type { ConnStatus, useRoom } from '../hooks/useRoom';

type Actions = ReturnType<typeof useRoom>['actions'];

export function StudentView({ snapshot, conn, actions, participantId, displayName, onLeave, notify }: {
  snapshot: RoomSnapshot; conn: ConnStatus; actions: Actions; participantId: string; displayName: string; onLeave(): void; notify(msg: string): void;
}) {
  const { permissions, presence, deck, board, locks, roomCode } = snapshot;
  const canManipulate = permissions.mode === 'all-students' || (permissions.mode === 'one-student' && permissions.activeStudentId === participantId);
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
      <Board
        board={board} locks={locks} rules={deck.rules} canManipulate={canManipulate} isHost={false} myOwnerId={participantId} statusMessage={status}
        onLock={actions.lock} onUnlock={actions.unlock} onMove={actions.move} onFlip={actions.flip} onShufflePile={actions.shufflePile} notify={notify}
      />
    </main>
  );
}
