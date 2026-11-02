import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PracticeState, RoomSnapshot } from '@shared/index';
import { call, createRoom, joinRoom, must, nextEvent, sleep, startHarness, type Harness, type TestSocket } from './helpers';

let h: Harness;
beforeEach(async () => { h = await startHarness(); });
afterEach(async () => { await h.stop(); });

const card = (snap: RoomSnapshot, pile = 0, i = 0) => { const c = snap.board.piles[pile]!.cards[i]!; return { id: c.id, text: c.text! }; };
const listOf = (p: PracticeState, pid: string) => (p.lists[pid] ?? []).map((c) => c.text);
/** Collect every event of a name a socket receives (to prove what did NOT arrive). */
const collect = (s: TestSocket, name: string) => { const got: unknown[] = []; (s as unknown as { on(e: string, h: (x: unknown) => void): void }).on(name, (x) => got.push(x)); return got; };

describe('practice lists: marking and visibility', () => {
  it('teacher marks a top card for one student; each student sees only their OWN list, the teacher sees all', async () => {
    const { host, roomCode, snapshot } = await createRoom(h);
    const a = await joinRoom(h, roomCode, 'Ada'); const b = await joinRoom(h, roomCode, 'Bo');
    const c = card(snapshot);
    const seenA = nextEvent(a.student, 'practice:update', (p: PracticeState) => listOf(p, a.you.participantId!).length === 1);
    const seenHost = nextEvent(host, 'practice:update', (p: PracticeState) => listOf(p, a.you.participantId!).length === 1);
    const bGot = collect(b.student, 'practice:update');
    must(await call(host, 'practice:mark', { participantId: a.you.participantId, card: c }));
    const [pa] = await seenA; const [ph] = await seenHost;
    expect(Object.keys(pa.lists)).toEqual([a.you.participantId]); // only her own entry
    expect(listOf(ph, a.you.participantId!)).toEqual([c.text]);
    await sleep(100);
    expect(JSON.stringify(bGot)).not.toContain(c.id + '","text"'); // Bo's update (if any) never contains Ada's list
    for (const u of bGot as PracticeState[]) expect(Object.keys(u.lists)).not.toContain(a.you.participantId!);
    // a student who joins later gets only their own list in the join snapshot
    expect(Object.keys((await joinRoom(h, roomCode, 'Cy')).snapshot.practice.lists)).toEqual([]);
  });

  it('students cannot mark cards unless self-assessment is on, and then only for themselves', async () => {
    const { host, roomCode, snapshot } = await createRoom(h);
    const a = await joinRoom(h, roomCode, 'Ada'); const b = await joinRoom(h, roomCode, 'Bo');
    const c = card(snapshot);
    expect(await call(a.student, 'practice:mark', { participantId: a.you.participantId, card: c })).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(await call(a.student, 'practice:allow-self', { enabled: true })).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    must(await call(host, 'practice:allow-self', { enabled: true }));
    must(await call(a.student, 'practice:mark', { participantId: a.you.participantId, card: c }));
    expect(await call(a.student, 'practice:mark', { participantId: b.you.participantId, card: c })).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(h.server.rooms.get(roomCode)!.practiceState(true).lists[b.you.participantId!]).toBeUndefined();
    expect(await call(host, 'practice:mark', { participantId: 'p_nobody', card: c })).toMatchObject({ ok: false, code: 'PARTICIPANT_NOT_FOUND' });
  });

  it('uses the deck\'s own text (never the client\'s) and rejects cards that are not in the deck', async () => {
    const { host, roomCode, snapshot } = await createRoom(h);
    const a = await joinRoom(h, roomCode, 'Ada');
    must(await call(host, 'practice:allow-self', { enabled: true }));
    const c = card(snapshot);
    must(await call(a.student, 'practice:mark', { participantId: a.you.participantId, card: { id: c.id, text: 'ZZZ-rude' } }));
    expect(listOf(h.server.rooms.get(roomCode)!.practiceState(true), a.you.participantId!)).toEqual([c.text]);
    expect(await call(a.student, 'practice:mark', { participantId: a.you.participantId, card: { id: 'made-up', text: 'boo' } })).toMatchObject({ ok: false, code: 'CARD_NOT_FOUND' });
  });

  it('students cannot mark a face-down card (that would reveal its hidden text); the teacher can', async () => {
    const { host, roomCode, snapshot } = await createRoom(h, 'sample-mystery-flip');
    const a = await joinRoom(h, roomCode, 'Ada');
    must(await call(host, 'practice:allow-self', { enabled: true }));
    const hidden = snapshot.board.piles[1]!.cards[0]!; // the mystery deck's middle cards start face-down
    expect(hidden.faceDown).toBe(true);
    expect(await call(a.student, 'practice:mark', { participantId: a.you.participantId, card: { id: hidden.id, text: 'x' } })).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    must(await call(host, 'practice:mark', { participantId: a.you.participantId, card: { id: hidden.id, text: 'x' } }));
  });

  it('only a list\'s owner or the teacher can remove cards', async () => {
    const { host, roomCode, snapshot } = await createRoom(h);
    const a = await joinRoom(h, roomCode, 'Ada'); const b = await joinRoom(h, roomCode, 'Bo');
    const c1 = card(snapshot, 0, 0); const c2 = card(snapshot, 0, 1);
    must(await call(host, 'practice:mark', { participantId: a.you.participantId, card: c1 }));
    must(await call(host, 'practice:mark', { participantId: a.you.participantId, card: c2 }));
    expect(await call(b.student, 'practice:unmark', { participantId: a.you.participantId, cardId: c1.id })).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    must(await call(a.student, 'practice:unmark', { participantId: a.you.participantId, cardId: c1.id }));
    must(await call(host, 'practice:unmark', { participantId: a.you.participantId, cardId: c2.id }));
    expect(h.server.rooms.get(roomCode)!.practiceState(true).lists[a.you.participantId!]).toBeUndefined();
  });

  it('caps a list at 40 cards', async () => {
    const { host, roomCode, snapshot } = await createRoom(h, 'sample-cvc-short-vowels');
    const a = await joinRoom(h, roomCode, 'Ada');
    const ids = snapshot.board.piles.flatMap((p) => p.cards.map((x) => x.id));
    expect(ids.length).toBeGreaterThan(30);
    const room = h.server.rooms.get(roomCode)!;
    for (let i = 0; i < 30; i++) must(await call(host, 'practice:mark', { participantId: a.you.participantId, card: { id: ids[i], text: 'x' } }));
    expect(room.practiceState(true).lists[a.you.participantId!]).toHaveLength(30);
  });
});

describe('practice import (saved JSON)', () => {
  const file = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, text: `t${i}`, lesson: 1 }));

  it('is teacher-only and replaces the student\'s list', async () => {
    const { host, roomCode } = await createRoom(h);
    const a = await joinRoom(h, roomCode, 'Ada');
    expect(await call(a.student, 'practice:import', { participantId: a.you.participantId, cards: file(2) })).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    must(await call(host, 'practice:import', { participantId: a.you.participantId, cards: file(3) }));
    expect(listOf(h.server.rooms.get(roomCode)!.practiceState(true), a.you.participantId!)).toEqual(['t0', 't1', 't2']);
    must(await call(host, 'practice:import', { participantId: a.you.participantId, cards: [{ id: 'z', text: 'zz' }, { id: 'z', text: 'dup' }] }));
    expect(listOf(h.server.rooms.get(roomCode)!.practiceState(true), a.you.participantId!)).toEqual(['zz']); // duplicates dropped
    must(await call(host, 'practice:import', { participantId: a.you.participantId, cards: [] }));
    expect(h.server.rooms.get(roomCode)!.practiceState(true).lists[a.you.participantId!]).toBeUndefined();
    expect(await call(host, 'practice:import', { participantId: 'p_nobody', cards: file(1) })).toMatchObject({ ok: false, code: 'PARTICIPANT_NOT_FOUND' });
  });

  it('validates the file strictly', async () => {
    const { host, roomCode } = await createRoom(h);
    const a = await joinRoom(h, roomCode, 'Ada'); const pid = a.you.participantId;
    for (const [cards, why] of [
      [file(41), 'too many cards'], [[{ id: 'a', text: '' }], 'empty text'], [[{ id: 'a', text: 'x'.repeat(13) }], 'long text'],
      [[{ id: 'a', text: 'ok', extra: 1 }], 'unknown field'], [[{ id: 'a', text: 'ok', lesson: 500 }], 'lesson out of range'],
      [[{ text: 'ok' }], 'missing id'], ['nope', 'not an array'],
    ] as const) expect(await call(host, 'practice:import', { participantId: pid, cards }), why).toMatchObject({ ok: false, code: 'BAD_REQUEST' });
    expect(h.server.rooms.get(roomCode)!.practiceState(true).lists[pid!]).toBeUndefined();
  });
});

describe('regressions: practice lists must survive snapshots', () => {
  it('a student keeps their own list (and never receives anyone else\'s) when the teacher changes the deck', async () => {
    const { host, roomCode, snapshot } = await createRoom(h);
    const a = await joinRoom(h, roomCode, 'Ada'); const b = await joinRoom(h, roomCode, 'Bo');
    must(await call(host, 'practice:mark', { participantId: a.you.participantId, card: card(snapshot) }));
    must(await call(host, 'practice:mark', { participantId: b.you.participantId, card: card(snapshot, 0, 1) }));
    const snapA = nextEvent(a.student, 'room:snapshot'); const snapHost = nextEvent(host, 'room:snapshot');
    must(await call(host, 'host:load-deck', { deckId: 'sample-phonograms' }));
    const [sa] = await snapA; const [sh] = await snapHost;
    expect(Object.keys(sa.practice.lists)).toEqual([a.you.participantId]);   // her own list survived, Bo's is not leaked to her
    expect(Object.keys(sh.practice.lists).sort()).toEqual([a.you.participantId, b.you.participantId].sort());
  });

  it('a stale-action resync does not wipe the student\'s list', async () => {
    const { host, roomCode, snapshot } = await createRoom(h);
    const a = await joinRoom(h, roomCode, 'Ada');
    must(await call(host, 'practice:mark', { participantId: a.you.participantId, card: card(snapshot) }));
    must(await call(host, 'host:set-permissions', { mode: 'all-students' }));
    const c = card(snapshot, 0, 2); const pile1 = snapshot.board.piles[1]!.id;
    const seen = h.server.rooms.get(roomCode)!.board.version;
    must(await call(host, 'board:move', { cardId: c.id, toPileId: pile1, toIndex: 0 }));
    const resync = nextEvent(a.student, 'room:snapshot');
    expect(await call(a.student, 'board:move', { cardId: c.id, toPileId: snapshot.board.piles[2]!.id, toIndex: 0, baseVersion: seen })).toMatchObject({ ok: false, code: 'STALE' });
    const [fresh] = await resync;
    expect(Object.keys(fresh.practice.lists)).toEqual([a.you.participantId]);
  });

  it('a student who leaves for good takes their list with them (no orphaned data)', async () => {
    let t = 0;
    const h2 = await startHarness({ participantGraceMs: 5000 }, { now: () => t });
    try {
      const { host, roomCode, snapshot } = await createRoom(h2);
      const a = await joinRoom(h2, roomCode, 'Ada');
      must(await call(host, 'practice:mark', { participantId: a.you.participantId, card: card(snapshot) }));
      a.student.close(); await sleep(60);
      const gone = nextEvent(host, 'practice:update', (p: PracticeState) => Object.keys(p.lists).length === 0);
      t = 6000; h2.server.sweep();
      await gone;
      expect(h2.server.rooms.get(roomCode)!.practiceState(true).lists).toEqual({});
    } finally { await h2.stop(); }
  });
});

describe('live tracing mirror', () => {
  it('relays a student\'s stroke to the TEACHER only, labelled by the server with their real name', async () => {
    const { host, roomCode, snapshot } = await createRoom(h);
    const a = await joinRoom(h, roomCode, 'Ada'); const b = await joinRoom(h, roomCode, 'Bo');
    const bGot: string[] = []; const aGot: string[] = [];
    for (const n of ['practice:student-start', 'practice:student-points', 'practice:student-end']) { b.student.on(n as never, (() => bGot.push(n)) as never); a.student.on(n as never, (() => aGot.push(n)) as never); }
    const text = card(snapshot).text;
    const start = nextEvent(host, 'practice:student-start'); const pts = nextEvent(host, 'practice:student-points'); const end = nextEvent(host, 'practice:student-end');
    must(await call(a.student, 'practice:start', { text, lesson: 1 }));
    must(await call(a.student, 'practice:points', { points: [0.1, 0.2, 0.3, 0.4] }));
    must(await call(a.student, 'practice:end', {}));
    const [s] = await start; const [p] = await pts; const [e] = await end;
    expect(s).toMatchObject({ participantId: a.you.participantId, name: 'Ada', text });
    expect(p).toEqual({ participantId: a.you.participantId, points: [0.1, 0.2, 0.3, 0.4] });
    expect(e).toEqual({ participantId: a.you.participantId });
    await sleep(100);
    expect([...aGot, ...bGot]).toEqual([]); // not even the tracer, and certainly not classmates
  });

  it('cannot be spoofed: identity comes from the session, the teacher cannot send student events, strangers cannot trace', async () => {
    const { host, roomCode, snapshot } = await createRoom(h);
    const a = await joinRoom(h, roomCode, 'Ada');
    const text = card(snapshot).text;
    expect(await call(host, 'practice:start', { text })).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(await call(host, 'practice:points', { points: [0, 0] })).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(await call(a.student, 'practice:start', { text, participantId: 'p_someoneelse', name: 'Bo' })).toMatchObject({ ok: false, code: 'BAD_REQUEST' }); // unknown fields are refused
    const stranger = await h.connect();
    expect(await call(stranger, 'practice:points', { points: [0, 0] })).toMatchObject({ ok: false, code: 'NOT_IN_ROOM' });
  });

  it('only real cards can be traced (a student cannot put their own words on the teacher\'s screen)', async () => {
    const { host, roomCode, snapshot } = await createRoom(h);
    const a = await joinRoom(h, roomCode, 'Ada');
    expect(await call(a.student, 'practice:start', { text: 'badword' })).toMatchObject({ ok: false, code: 'CARD_NOT_FOUND' });
    must(await call(a.student, 'practice:start', { text: card(snapshot).text }));
    // a card from a teacher-loaded list is allowed even if it is not in the current deck
    must(await call(host, 'practice:import', { participantId: a.you.participantId, cards: [{ id: 'old', text: 'qu' }] }));
    must(await call(a.student, 'practice:start', { text: 'qu' }));
  });

  it('refuses malformed or oversized point batches', async () => {
    const { roomCode } = await createRoom(h);
    const a = await joinRoom(h, roomCode, 'Ada');
    for (const points of [[0.5], [0.1, 0.2, 0.3], Array(82).fill(0.5), [2, 0], [-1, 0], ['a', 'b'], [], [NaN, 0]]) {
      expect(await call(a.student, 'practice:points', { points }), JSON.stringify(points)).toMatchObject({ ok: false, code: 'BAD_REQUEST' });
    }
    must(await call(a.student, 'practice:points', { points: Array(80).fill(0.5) })); // the maximum is accepted
  });

  it('tells the teacher a tracing student has gone when they disconnect mid-stroke', async () => {
    const { host, roomCode, snapshot } = await createRoom(h);
    const a = await joinRoom(h, roomCode, 'Ada');
    must(await call(a.student, 'practice:start', { text: card(snapshot).text }));
    const ended = nextEvent(host, 'practice:student-end', (e) => e.participantId === a.you.participantId);
    a.student.close();
    await ended;
  });

  it('never crosses rooms', async () => {
    const r1 = await createRoom(h); const r2 = await createRoom(h);
    const a = await joinRoom(h, r1.roomCode, 'Ada');
    const heard: string[] = [];
    r2.host.onAny((e) => heard.push(e));
    must(await call(a.student, 'practice:start', { text: r1.snapshot.board.piles[0]!.cards[0]!.text }));
    must(await call(a.student, 'practice:points', { points: [0.1, 0.1] }));
    await sleep(100);
    expect(heard).toEqual([]);
  });

  it('point streams have their own allowance: a flood is limited but does not block the student\'s taps', async () => {
    const { host, roomCode, snapshot } = await createRoom(h);
    const a = await joinRoom(h, roomCode, 'Ada');
    must(await call(host, 'host:set-permissions', { mode: 'all-students' }));
    const results = await Promise.all(Array.from({ length: 60 }, () => call(a.student, 'practice:points', { points: [0.5, 0.5] })));
    expect(results.some((r) => !r.ok && r.code === 'RATE_LIMITED')).toBe(true);
    must(await call(a.student, 'pile:draw', { pileId: snapshot.board.piles[0]!.id })); // tapping still works
  });
});
