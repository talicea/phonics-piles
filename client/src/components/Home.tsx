import { useState, type FormEvent } from 'react';
import { normalizeRoomCode } from '@shared/index';
import { roomCodeFromUrl } from '../hooks/useRoom';

export function Home({ joinRoom, onTeacher, offline }: { joinRoom(code: string, name: string): Promise<{ ok: boolean; message?: string }>; onTeacher(): void; offline: boolean }) {
  const [code, setCode] = useState(() => normalizeRoomCode(roomCodeFromUrl()).slice(0, 8));
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const clean = normalizeRoomCode(code);
    if (clean.length < 4) { setError('Enter the room code from your teacher’s screen.'); return; }
    setBusy(true); setError(null);
    const res = await joinRoom(clean, name);
    setBusy(false);
    if (!res.ok) setError(res.message ?? 'Could not join.');
  };

  return (
    <main className="home">
      <h1 className="brand">Phonics Piles</h1>
      <p className="tagline">Build nonsense words together with three piles of sound cards.</p>
      <div className="home-grid">
        <section className="panel" aria-labelledby="join-h">
          <h2 id="join-h">Students: join a game</h2>
          <form onSubmit={(e) => void submit(e)} noValidate>
            <label htmlFor="code">Room code</label>
            <input
              id="code" className="code-input" value={code} onChange={(e) => setCode(normalizeRoomCode(e.target.value).slice(0, 8))}
              autoCapitalize="characters" autoComplete="off" autoCorrect="off" spellCheck={false} inputMode="text" maxLength={12}
              aria-describedby={error ? 'join-error' : undefined} aria-invalid={error ? true : undefined} placeholder="ABCDE"
            />
            <label htmlFor="name">Your name <span className="muted">(optional)</span></label>
            <input id="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={24} autoComplete="off" placeholder="First name or nickname" />
            {error && <p id="join-error" className="error" role="alert">{error}</p>}
            <button type="submit" className="btn primary big" disabled={busy || offline}>{busy ? 'Joining…' : 'Join game'}</button>
            {offline && <p className="muted small">Waiting for the connection to the server…</p>}
          </form>
          <p className="muted small">No account or email needed. Only the name you type is shared with your class.</p>
        </section>
        <section className="panel" aria-labelledby="teach-h">
          <h2 id="teach-h">Teachers: host a game</h2>
          <p>Pick a deck, share the room code, and move the cards on a shared board. You decide when students can move cards too.</p>
          <button type="button" className="btn primary big" onClick={onTeacher}>Create a game</button>
        </section>
      </div>
    </main>
  );
}
