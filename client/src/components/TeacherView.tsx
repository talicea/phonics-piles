import { useEffect, useState } from 'react';
import type { CreateRoomPayload, ControlMode, RoomSnapshot } from '@shared/index';
import { Board } from './Board';
import { LiveTraceMirror, type LiveTraceSession } from './LiveTraceMirror';
import { Table } from './Table';
import { ConfirmDialog, ConnectionBadge, CopyButton, Modal, ViewToggle, type BoardViewMode } from './common';
import { DeckPicker, type DeckChoice } from './DeckPicker';
import { setPracticeHandlers, type ConnStatus, type useRoom } from '../hooks/useRoom';
import { downloadPracticeFile, readPracticeFileFromInput } from '../practiceFile';

type Actions = ReturnType<typeof useRoom>['actions'];

const MODES: { value: ControlMode; label: string; help: string }[] = [
  { value: 'teacher-only', label: 'Teacher only', help: 'Students watch.' },
  { value: 'all-students', label: 'All students', help: 'Anyone can move cards.' },
  { value: 'one-student', label: 'One student at a time', help: 'You pick whose turn it is.' },
];

export function TeacherView({ snapshot, conn, actions, endGame, notify }: {
  snapshot: RoomSnapshot; conn: ConnStatus; actions: Actions; endGame(): Promise<{ ok: boolean }>; notify(msg: string): void;
}) {
  const { roomCode, permissions, presence, deck, board, locks, practice } = snapshot;
  const practiceLists = practice?.lists ?? {};
  const allowSelf = practice?.allowSelfAssessment ?? false;
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [changeDeck, setChangeDeck] = useState(false);
  const [busy, setBusy] = useState(false);
  // `?view=arrange` opens the classic drag-to-arrange board first (handy for bookmarks and the classic end-to-end test).
  const [view, setView] = useState<BoardViewMode>(new URLSearchParams(window.location.search).get('view') === 'arrange' ? 'arrange' : 'table');
  const [projector, setProjector] = useState(false);
  const [liveTraces, setLiveTraces] = useState<Record<string, LiveTraceSession>>({});
  const [practiceStudent, setPracticeStudent] = useState<string>('');
  // Show the teacher's click immediately; the server's answer (already broadcast by the time the ack arrives) replaces it.
  const [pending, setPending] = useState<{ mode: ControlMode; active: string | null } | null>(null);
  const shownMode = pending?.mode ?? permissions.mode;
  const shownActive = pending ? pending.active : permissions.activeStudentId;
  const students = presence.participants ?? [];
  const statusText = permissions.mode === 'teacher-only' ? 'Only you can move cards.' : permissions.mode === 'all-students' ? 'You and all students can move cards.' : 'You and the chosen student can move cards.';
  const joinUrl = `${window.location.origin}/?join=${roomCode}`;
  const run = async (p: Promise<{ ok: boolean } & { message?: string }>) => { const r = await p; if (!r.ok && r.message) notify(r.message); return r; };

  const applyPermissions = (mode: ControlMode, active: string | null) => {
    setPending({ mode, active });
    void run(actions.setPermissions(mode, active)).finally(() => setPending(null));
  };
  const setMode = (mode: ControlMode) => applyPermissions(mode, mode === 'one-student' ? permissions.activeStudentId : null);
  const setActive = (id: string) => applyPermissions('one-student', id || null);

  useEffect(() => {
    setPracticeHandlers({
      onStart: (info) => {
        setLiveTraces((prev) => ({
          ...prev,
          [info.participantId]: {
            participantId: info.participantId,
            name: info.name,
            text: info.text,
            cat: info.cat,
            count: info.count,
            lesson: info.lesson,
            points: [],
          },
        }));
      },
      onPoints: (info) => {
        setLiveTraces((prev) => {
          const cur = prev[info.participantId];
          if (!cur) return prev;
          // Cap stored points so a long session does not grow without bound.
          const merged = cur.points.concat(info.points);
          const points = merged.length > 600 ? merged.slice(merged.length - 600) : merged;
          return { ...prev, [info.participantId]: { ...cur, points } };
        });
      },
      onEnd: (info) => {
        setLiveTraces((prev) => {
          const next = { ...prev };
          delete next[info.participantId];
          return next;
        });
      },
    });
    return () => setPracticeHandlers({});
  }, []);

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
        <button type="button" className="btn danger small" onClick={() => setConfirmEnd(true)}>End game</button>
      </header>

      <section className="roomcode compact" aria-label="Room code">
        <div className="code-main">
          <div className="code-display" aria-label={`Room code ${roomCode.split('').join(' ')}`} data-testid="room-code">{roomCode}</div>
          <p className="join-help small">Students: <strong>{window.location.host}</strong></p>
        </div>
        <div className="code-side">
          <div className="row">
            <CopyButton text={roomCode} label="Copy code" onCopied={notify} />
            <CopyButton text={joinUrl} label="Copy join link" onCopied={notify} />
          </div>
          <p className="count-big" data-testid="student-count" aria-live="polite"><strong>{presence.participantCount}</strong> student{presence.participantCount === 1 ? '' : 's'}</p>
          {!presence.hostConnected && <p className="error">Reconnecting as host…</p>}
        </div>
      </section>

      <details className="controls panel compact-controls" open>
        <summary className="controls-summary">
          <span className="who-summary">{statusText}</span>
          <span className="muted small deck-line">Deck: <strong>{deck.name}</strong></span>
        </summary>
        <div className="controls-body">
          <fieldset className="modes">
            <legend className="sr-only">Who can move cards?</legend>
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
            <button type="button" className="btn small" onClick={() => void run(actions.shuffleAll())}>🔀 Shuffle all</button>
            <button type="button" className="btn small" onClick={() => setConfirmReset(true)}>↺ Reset board</button>
            <button type="button" className="btn small" onClick={() => setChangeDeck(true)}>🃏 Change deck</button>
          </div>
        </div>
      </details>

      {Object.keys(liveTraces).length > 0 && (
        <section className="live-traces panel" aria-label="Students tracing">
          <h2 className="small" style={{ margin: '0 0 .5rem' }}>Live tracing</h2>
          <div className="live-traces-grid">
            {Object.values(liveTraces).map((s) => <LiveTraceMirror key={s.participantId} session={s} />)}
          </div>
        </section>
      )}

      <details className="panel practice-panel">
        <summary>Tracing practice lists</summary>
        <div className="practice-body">
          <label className="trace-vibrate">
            <input type="checkbox" checked={allowSelf}
              onChange={(e) => void run(actions.practiceAllowSelf(e.target.checked))} />
            Allow students to mark cards themselves
          </label>
          {students.length === 0 ? (
            <p className="muted small">No students connected yet.</p>
          ) : (
            <>
              <div className="active-student" style={{ marginTop: '.5rem' }}>
                <label htmlFor="practice-student">Mark top cards for</label>
                <select id="practice-student" value={practiceStudent || students[0]?.id || ''}
                  onChange={(e) => setPracticeStudent(e.target.value)}>
                  {students.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <div className="row" style={{ marginTop: '.4rem' }}>
                {board.piles.map((pile) => {
                  const top = pile.cards[0];
                  if (!top || top.text === null) return null;
                  const targetId = practiceStudent || students[0]?.id;
                  if (!targetId) return null;
                  return (
                    <button key={pile.id} type="button" className="btn small"
                      onClick={() => void run(actions.practiceMark(targetId, {
                        id: top.id, text: top.text!, sourceDeckId: deck.id,
                      }))}>
                      Mark “{top.text}” ({pile.label})
                    </button>
                  );
                })}
              </div>
              <ul className="practice-lists">
                {students.map((s) => {
                  const cards = practiceLists[s.id] ?? [];
                  return (
                    <li key={s.id}>
                      <strong>{s.name}</strong>
                      {cards.length === 0 ? <span className="muted"> — no cards yet</span> : (
                        <span className="practice-chips">
                          {cards.map((c) => (
                            <button key={c.id} type="button" className="chip practice-chip"
                              title="Remove from practice list"
                              onClick={() => void run(actions.practiceUnmark(s.id, c.id))}>
                              {c.text} ×
                            </button>
                          ))}
                        </span>
                      )}
                      <button type="button" className="btn small" disabled={cards.length === 0}
                        onClick={() => downloadPracticeFile(s.name, cards)}
                        title="Save this student's practice list as a JSON file">
                        Save JSON
                      </button>
                    </li>
                  );
                })}
              </ul>
              <div className="practice-import">
                <p className="muted small" style={{ margin: '.6rem 0 .3rem' }}>
                  Load a previously saved practice file onto a student (matched by who you select above):
                </p>
                <label className="btn small file-btn">
                  Load practice JSON
                  <input type="file" accept="application/json,.json" onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = '';
                    if (!f) return;
                    const targetId = practiceStudent || students[0]?.id;
                    if (!targetId) { notify('Pick a student first.'); return; }
                    void readPracticeFileFromInput(f).then(async (parsed) => {
                      if (!parsed.ok) { notify(parsed.message); return; }
                      const r = await actions.practiceImport(targetId, parsed.file.cards);
                      if (r.ok) notify(`Loaded ${parsed.file.cards.length} card(s) from “${parsed.file.studentName}” for the selected student.`);
                      else notify(r.message ?? 'Could not import.');
                    });
                  }} />
                </label>
              </div>
            </>
          )}
        </div>
      </details>

      <div className="view-row">
        <ViewToggle mode={view} onChange={setView} />
        {view === 'table' && (
          <button type="button" className={`btn small${projector ? ' on' : ''}`}
            aria-pressed={projector}
            onClick={() => setProjector((v) => !v)}
            title="Larger cards and labels for a projector">
            {projector ? '🖥 Projector on' : '🖥 Projector'}
          </button>
        )}
      </div>
      {view === 'table' ? (
        <Table board={board} deck={deck} canManipulate statusMessage={statusText} projector={projector}
          onDraw={actions.draw} onUndo={actions.undo} onRecycle={actions.recycle} onShuffle={actions.shufflePile}
          onFlip={actions.flip} notify={notify} />
      ) : (
        <Board
          board={board} locks={locks} deck={deck} canManipulate isHost myOwnerId="host" statusMessage={statusText}
          onLock={actions.lock} onUnlock={actions.unlock} onMove={actions.move} onFlip={actions.flip} onShufflePile={actions.shufflePile} notify={notify}
        />
      )}

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
