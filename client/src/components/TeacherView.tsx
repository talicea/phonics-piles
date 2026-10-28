import { useState } from 'react';
import type { CreateRoomPayload, ControlMode, RoomSnapshot } from '@shared/index';
import { Board } from './Board';
import { ConfirmDialog, ConnectionBadge, CopyButton, Modal } from './common';
import { DeckPicker, type DeckChoice } from './DeckPicker';
import type { ConnStatus, useRoom } from '../hooks/useRoom';

type Actions = ReturnType<typeof useRoom>['actions'];

const MODES: { value: ControlMode; label: string; help: string }[] = [
  { value: 'teacher-only', label: 'Teacher only', help: 'Students watch.' },
  { value: 'all-students', label: 'All students', help: 'Anyone can move cards.' },
  { value: 'one-student', label: 'One student at a time', help: 'You pick whose turn it is.' },
];

export function TeacherView({ snapshot, conn, actions, endGame, notify }: {
  snapshot: RoomSnapshot; conn: ConnStatus; actions: Actions; endGame(): Promise<{ ok: boolean }>; notify(msg: string): void;
}) {
  const { roomCode, permissions, presence, deck, board, locks } = snapshot;
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [changeDeck, setChangeDeck] = useState(false);
  const [busy, setBusy] = useState(false);
  // Show the teacher's click immediately; the server's answer (already broadcast by the time the ack arrives) replaces it.
  const [pending, setPending] = useState<{ mode: ControlMode; active: string | null } | null>(null);
  const shownMode = pending?.mode ?? permissions.mode;
  const shownActive = pending ? pending.active : permissions.activeStudentId;
  const students = presence.participants ?? [];
  const joinUrl = `${window.location.origin}/?join=${roomCode}`;
  const run = async (p: Promise<{ ok: boolean } & { message?: string }>) => { const r = await p; if (!r.ok && r.message) notify(r.message); return r; };

  const applyPermissions = (mode: ControlMode, active: string | null) => {
    setPending({ mode, active });
    void run(actions.setPermissions(mode, active)).finally(() => setPending(null));
  };
  const setMode = (mode: ControlMode) => applyPermissions(mode, mode === 'one-student' ? permissions.activeStudentId : null);
  const setActive = (id: string) => applyPermissions('one-student', id || null);

  const load = async (choice: DeckChoice) => {
    setBusy(true);
    const payload: CreateRoomPayload = choice;
    const r = await actions.loadDeck(payload);
    setBusy(false);
    if (r.ok) { setChangeDeck(false); notify('Deck changed for everyone.'); }
    else notify(r.ok === false && r.details?.length ? `${r.message} ${r.details[0]}` : r.message);
  };

  return (
    <main className="teacher">
      <header className="topbar">
        <h1 className="brand small">Phonics Piles <span className="muted">· Teacher</span></h1>
        <ConnectionBadge status={conn} />
        <button type="button" className="btn danger" onClick={() => setConfirmEnd(true)}>End game</button>
      </header>

      <section className="roomcode" aria-label="Room code">
        <div>
          <p className="join-help">Students go to <strong>{window.location.host}</strong> and enter this code:</p>
          <div className="code-display" aria-label={`Room code ${roomCode.split('').join(' ')}`} data-testid="room-code">{roomCode}</div>
        </div>
        <div className="code-side">
          <div className="row">
            <CopyButton text={roomCode} label="Copy code" onCopied={notify} />
            <CopyButton text={joinUrl} label="Copy join link" onCopied={notify} />
          </div>
          <p className="count-big" data-testid="student-count" aria-live="polite"><strong>{presence.participantCount}</strong> student{presence.participantCount === 1 ? '' : 's'} connected</p>
          {!presence.hostConnected && <p className="error">Reconnecting as host…</p>}
        </div>
      </section>

      <section className="controls panel" aria-label="Game controls">
        <fieldset className="modes">
          <legend>Who can move cards?</legend>
          {MODES.map((m) => (
            <label key={m.value} className={`mode${shownMode === m.value ? ' chosen' : ''}`}>
              <input type="radio" name="mode" value={m.value} checked={shownMode === m.value} onChange={() => setMode(m.value)} />
              <span><strong>{m.label}</strong><span className="muted small"> {m.help}</span></span>
            </label>
          ))}
          {shownMode === 'one-student' && (
            <div className="active-student">
              <label htmlFor="active">Student in control</label>
              <select id="active" value={shownActive ?? ''} onChange={(e) => setActive(e.target.value)}>
                <option value="">— nobody yet —</option>
                {students.map((s) => <option key={s.id} value={s.id}>{s.name}{s.connected ? '' : ' (offline)'}</option>)}
              </select>
            </div>
          )}
        </fieldset>
        <div className="actions">
          <button type="button" className="btn" onClick={() => void run(actions.shuffleAll())}>🔀 Shuffle all piles</button>
          <button type="button" className="btn" onClick={() => setConfirmReset(true)}>↺ Reset board</button>
          <button type="button" className="btn" onClick={() => setChangeDeck(true)}>🃏 Change deck</button>
        </div>
        <p className="muted small deck-line">Deck: <strong>{deck.name}</strong></p>
      </section>

      <Board
        board={board} locks={locks} rules={deck.rules} canManipulate isHost myOwnerId="host"
        statusMessage={permissions.mode === 'teacher-only' ? 'Only you can move cards.' : permissions.mode === 'all-students' ? 'You and all students can move cards.' : 'You and the chosen student can move cards.'}
        onLock={actions.lock} onUnlock={actions.unlock} onMove={actions.move} onFlip={actions.flip} onShufflePile={actions.shufflePile} notify={notify}
      />

      <details className="panel students">
        <summary>Students ({students.length})</summary>
        {students.length === 0 ? <p className="muted">Nobody has joined yet.</p> : (
          <ul>{students.map((s) => <li key={s.id}>{s.name} <span className="muted small">{s.connected ? '● online' : '○ offline'}</span>{permissions.mode === 'one-student' && permissions.activeStudentId === s.id ? <strong> · in control</strong> : null}</li>)}</ul>
        )}
      </details>

      {confirmEnd && (
        <ConfirmDialog title="End this game?" message="Students will be disconnected and the room code will stop working. This cannot be undone." confirmLabel="End game" danger busy={busy}
          onCancel={() => setConfirmEnd(false)} onConfirm={() => { setBusy(true); void endGame().then((r) => { setBusy(false); if (!r.ok) notify('Could not end the game. Try again.'); }); }} />
      )}
      {confirmReset && (
        <ConfirmDialog title="Reset the board?" message="All cards return to their starting arrangement for everyone." confirmLabel="Reset board"
          onCancel={() => setConfirmReset(false)} onConfirm={() => { setConfirmReset(false); void run(actions.reset()); }} />
      )}
      {changeDeck && (
        <Modal title="Change deck" wide onClose={() => setChangeDeck(false)}>
          <p className="muted">This replaces the board for everyone in the room.</p>
          <DeckPicker confirmLabel="Use this deck" busy={busy} offline={conn !== 'online'} onChoose={(c) => void load(c)} onCancel={() => setChangeDeck(false)} />
        </Modal>
      )}
    </main>
  );
}
