import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { io as ioClient } from 'socket.io-client';
import type { BoardView, CreateRoomResult, JoinResult, LockMap, Permissions, Presence, RoomSnapshot } from '@shared/index';
import { call, createRoom, firstCardId, joinRoom, must, nextEvent, sleep, startHarness, type Harness, type TestSocket } from './helpers';

let h: Harness;
beforeEach(async () => { h = await startHarness(); });
afterEach(async () => { await h.stop(); });

const cardIds = (b: BoardView, pile: number) => b.piles[pile]!.cards.map((c) => c.id);

describe('room creation and joining (requirements 1-4)', () => {
  it('1. creates a room with a valid code, a separate host token, and the initial board', async () => {
    const { roomCode, hostToken, snapshot, you } = await createRoom(h);
    expect(roomCode).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/);
    expect(hostToken.length).toBeGreaterThanOrEqual(32);
    expect(hostToken).not.toContain(roomCode);
    expect(you.role).toBe('host');
    expect(snapshot.board.piles).toHaveLength(3);
    expect(snapshot.permissions).toEqual({ mode: 'teacher-only', activeStudentId: null });
    const second = await createRoom(h);
    expect(second.roomCode).not.toBe(roomCode);
    expect(h.server.rooms.size).toBe(2);
  });

  it('2. lets a student join a valid room (any case / spacing) and updates the teacher\'s participant count', async () => {
    const { host, roomCode } = await createRoom(h);
    const presence = nextEvent(host, 'room:presence', (p: Presence) => p.participantCount === 1);
    const { you, snapshot, participantToken } = await joinRoom(h, ` ${roomCode.toLowerCase()} `, 'Ada');
    expect(you).toMatchObject({ role: 'student', displayName: 'Ada' });
    expect(participantToken).toBeTruthy();
    expect(snapshot.roomCode).toBe(roomCode);
    const [p] = await presence;
    expect(p.participants?.map((x) => x.name)).toEqual(['Ada']);
  });

  it('3. rejects unknown room codes with a helpful message', async () => {
    const s = await h.connect();
    const res = await call(s, 'room:join', { roomCode: 'ZZZZZ' });
    expect(res).toMatchObject({ ok: false, code: 'ROOM_NOT_FOUND' });
    expect(res.ok === false && res.message).toMatch(/check the code/i);
  });

  it('4. gives a newly joined student the CURRENT board, permissions and deck', async () => {
    const { host, roomCode, snapshot } = await createRoom(h);
    const card = firstCardId(snapshot, 0, 0);
    must(await call(host, 'board:move', { cardId: card, toPileId: snapshot.board.piles[2]!.id, toIndex: 0 }));
    must(await call(host, 'host:set-permissions', { mode: 'all-students' }));
    const { snapshot: s } = await joinRoom(h, roomCode);
    expect(cardIds(s.board, 2)[0]).toBe(card);
    expect(cardIds(s.board, 0)).not.toContain(card);
    expect(s.permissions.mode).toBe('all-students');
    expect(s.deck.id).toBe('sample-cvc-short-vowels');
  });

  it('never exposes host secrets to students', async () => {
    const { roomCode, hostToken, host } = await createRoom(h);
    const { student, snapshot, participantToken } = await joinRoom(h, roomCode);
    const seen: unknown[] = [];
    student.onAny((_e, ...args) => seen.push(args));
    must(await call(host, 'board:shuffle', { scope: 'all' }));
    await sleep(100);
    const blob = JSON.stringify([snapshot, seen]);
    expect(blob).not.toContain(hostToken);
    expect(participantToken && blob.includes(participantToken)).toBe(false);
  });
});

describe('broadcast and isolation (requirements 5-6)', () => {
  it('5. broadcasts teacher actions (move, flip, shuffle, reset) to every participant in the room', async () => {
    const { host, roomCode, snapshot } = await createRoom(h, 'sample-mystery-flip');
    const a = await joinRoom(h, roomCode, 'A'); const b = await joinRoom(h, roomCode, 'B');
    const card = firstCardId(snapshot, 0, 0);
    const toPile = snapshot.board.piles[1]!.id;

    const updA = nextEvent(a.student, 'board:update', (bd: BoardView) => cardIds(bd, 1)[0] === card);
    const updB = nextEvent(b.student, 'board:update', (bd: BoardView) => cardIds(bd, 1)[0] === card);
    must(await call(host, 'board:move', { cardId: card, toPileId: toPile, toIndex: 0 }));
    const [ba] = await updA; const [bb] = await updB;
    expect(ba).toEqual(bb);

    const flipped = nextEvent(a.student, 'board:update', (bd: BoardView) => bd.piles.some((p) => p.cards.some((c) => c.id === card && c.faceDown)));
    must(await call(host, 'board:flip', { cardId: card }));
    const [fb] = await flipped;
    // face-down cards are redacted for students
    expect(fb.piles[1]!.cards[0]).toEqual({ id: card, text: null, faceDown: true });

    const shuffled = nextEvent(b.student, 'board:update', (bd: BoardView) => bd.version > fb.version);
    must(await call(host, 'board:shuffle', { scope: 'pile', pileId: toPile }));
    await shuffled;

    const resetP = nextEvent(a.student, 'board:update', (bd: BoardView) => cardIds(bd, 0)[0] === snapshot.board.piles[0]!.cards[0]!.id && bd.version > fb.version + 1);
    must(await call(host, 'board:reset'));
    await resetP;
  });

  it('6. never leaks events or changes into another room', async () => {
    const r1 = await createRoom(h); const r2 = await createRoom(h);
    const s1 = await joinRoom(h, r1.roomCode); const s2 = await joinRoom(h, r2.roomCode);
    const heard: string[] = [];
    for (const s of [r2.host, s2.student]) s.onAny((e) => heard.push(e));
    const before = JSON.stringify(h.server.rooms.get(r2.roomCode)!.board);

    must(await call(r1.host, 'host:set-permissions', { mode: 'all-students' }));
    must(await call(s1.student, 'board:move', { cardId: firstCardId(r1.snapshot, 0, 0), toPileId: r1.snapshot.board.piles[1]!.id, toIndex: 0 }));
    must(await call(r1.host, 'board:shuffle', { scope: 'all' }));
    must(await call(r1.host, 'board:reset'));
    must(await call(r1.host, 'host:end'));
    await sleep(150);

    expect(heard).toEqual([]);
    expect(JSON.stringify(h.server.rooms.get(r2.roomCode)!.board)).toBe(before);
    expect(h.server.rooms.get(r2.roomCode)).toBeDefined();
  });

  it('a card id from another room cannot be used (cards are scoped to the room board)', async () => {
    const r1 = await createRoom(h, 'sample-cvc-short-vowels');
    const r2 = await createRoom(h, 'sample-phonograms');
    const foreign = firstCardId(r2.snapshot, 0, 0); // "b-sh" exists only in room 2
    const res = await call(r1.host, 'board:move', { cardId: foreign, toPileId: r1.snapshot.board.piles[0]!.id, toIndex: 0 });
    expect(res).toMatchObject({ ok: false, code: 'CARD_NOT_FOUND' });
  });
});

describe('permissions (requirements 7-9)', () => {
  it('7. rejects student actions when manipulation is disabled, even if submitted manually', async () => {
    const { host, roomCode, snapshot } = await createRoom(h, 'sample-mystery-flip');
    const { student } = await joinRoom(h, roomCode);
    const card = firstCardId(snapshot, 0, 0);
    const heard: string[] = [];
    host.onAny((e) => heard.push(e));
    for (const [event, payload] of [
      ['card:lock', { cardId: card }],
      ['board:move', { cardId: card, toPileId: snapshot.board.piles[1]!.id, toIndex: 0 }],
      ['board:flip', { cardId: card }],
      ['board:shuffle', { scope: 'all' }],
    ] as const) {
      expect(await call(student, event, payload), event).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    }
    expect(h.server.rooms.get(roomCode)!.board.version).toBe(snapshot.board.version);
    expect(heard.filter((e) => e === 'board:update')).toEqual([]);
  });

  it('students can never use teacher-only events', async () => {
    const { host, roomCode } = await createRoom(h);
    const { student } = await joinRoom(h, roomCode);
    for (const [event, payload] of [
      ['board:reset', {}], ['host:end', {}], ['host:set-permissions', { mode: 'all-students' }], ['host:load-deck', { deckId: 'sample-phonograms' }],
    ] as const) {
      expect(await call(student, event, payload), event).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    }
    expect(h.server.rooms.get(roomCode)!.permissions.mode).toBe('teacher-only');
    expect(host.connected).toBe(true);
  });

  it('a connection that never joined a room can do nothing', async () => {
    const { roomCode } = await createRoom(h);
    const stranger = await h.connect();
    for (const [event, payload] of [['board:reset', {}], ['host:end', {}], ['board:shuffle', { scope: 'all' }]] as const) {
      expect(await call(stranger, event, payload)).toMatchObject({ ok: false, code: 'NOT_IN_ROOM' });
    }
    expect(h.server.rooms.get(roomCode)).toBeDefined();
  });

  it('host:resume requires the real token (the room code alone is not enough)', async () => {
    const { roomCode, hostToken } = await createRoom(h);
    const impostor = await h.connect();
    expect(await call(impostor, 'host:resume', { roomCode, hostToken: 'x'.repeat(43) })).toMatchObject({ ok: false, code: 'UNAUTHORIZED' });
    expect(await call(impostor, 'host:resume', { roomCode, hostToken: roomCode })).toMatchObject({ ok: false });
    expect(await call(impostor, 'board:reset')).toMatchObject({ ok: false });
    const real = await h.connect();
    expect(await call(real, 'host:resume', { roomCode, hostToken })).toMatchObject({ ok: true });
  });

  it('8. accepts student actions when all-students mode is on, and broadcasts them', async () => {
    const { host, roomCode, snapshot } = await createRoom(h);
    const a = await joinRoom(h, roomCode, 'A'); const b = await joinRoom(h, roomCode, 'B');
    const perm = nextEvent(a.student, 'room:permissions', (p: Permissions) => p.mode === 'all-students');
    must(await call(host, 'host:set-permissions', { mode: 'all-students' }));
    await perm;
    const card = firstCardId(snapshot, 0, 1);
    const toPile = snapshot.board.piles[2]!.id;
    const seenByHost = nextEvent(host, 'board:update', (bd: BoardView) => cardIds(bd, 2)[0] === card);
    const seenByB = nextEvent(b.student, 'board:update', (bd: BoardView) => cardIds(bd, 2)[0] === card);
    must(await call(a.student, 'board:move', { cardId: card, toPileId: toPile, toIndex: 0 }));
    await Promise.all([seenByHost, seenByB]);
    must(await call(b.student, 'board:shuffle', { scope: 'pile', pileId: toPile }));
  });

  it('9. one-student-at-a-time lets only the designated student act, and changes apply live', async () => {
    const { host, roomCode, snapshot } = await createRoom(h);
    const a = await joinRoom(h, roomCode, 'A'); const b = await joinRoom(h, roomCode, 'B');
    const card = firstCardId(snapshot, 0, 0);
    const move = (s: TestSocket, idx: number) => call(s, 'board:move', { cardId: card, toPileId: snapshot.board.piles[1]!.id, toIndex: idx });

    must(await call(host, 'host:set-permissions', { mode: 'one-student', activeStudentId: null }));
    expect(await move(a.student, 0)).toMatchObject({ ok: false, code: 'FORBIDDEN' }); // nobody yet

    const permB = nextEvent(b.student, 'room:permissions', (p: Permissions) => p.activeStudentId === a.you.participantId);
    must(await call(host, 'host:set-permissions', { mode: 'one-student', activeStudentId: a.you.participantId }));
    expect((await permB)[0].mode).toBe('one-student');
    expect(await move(b.student, 0)).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    must(await move(a.student, 0));

    must(await call(host, 'host:set-permissions', { mode: 'one-student', activeStudentId: b.you.participantId }));
    expect(await move(a.student, 1)).toMatchObject({ ok: false, code: 'FORBIDDEN' }); // A lost control immediately
    must(await move(b.student, 1));

    expect(await call(host, 'host:set-permissions', { mode: 'one-student', activeStudentId: 'p_doesnotexist' })).toMatchObject({ ok: false, code: 'PARTICIPANT_NOT_FOUND' });
    must(await call(host, 'host:set-permissions', { mode: 'teacher-only' }));
    expect(await move(b.student, 0)).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    must(await call(host, 'board:move', { cardId: card, toPileId: snapshot.board.piles[0]!.id, toIndex: 0 })); // teacher always can
  });
});

describe('validation (requirements 10-12)', () => {
  it('10. rejects invalid card ids and malformed payloads', async () => {
    const { host, snapshot } = await createRoom(h);
    const pile = snapshot.board.piles[0]!.id;
    const version = h.server.rooms.get(snapshot.roomCode)!.board.version;
    const bad: Array<[Parameters<typeof call>[1], unknown, string]> = [
      ['board:move', { cardId: 'does-not-exist', toPileId: pile, toIndex: 0 }, 'CARD_NOT_FOUND'],
      ['board:move', { cardId: firstCardId(snapshot), toPileId: 'nope', toIndex: 0 }, 'PILE_NOT_FOUND'],
      ['board:move', { cardId: firstCardId(snapshot), toPileId: pile, toIndex: -1 }, 'BAD_REQUEST'],
      ['board:move', { cardId: firstCardId(snapshot), toPileId: pile, toIndex: 1.5 }, 'BAD_REQUEST'],
      ['board:move', { cardId: firstCardId(snapshot), toPileId: pile, toIndex: '0' }, 'BAD_REQUEST'],
      ['board:move', { cardId: 123, toPileId: pile, toIndex: 0 }, 'BAD_REQUEST'],
      ['board:move', { toPileId: pile, toIndex: 0 }, 'BAD_REQUEST'],
      ['board:move', { cardId: firstCardId(snapshot), toPileId: pile, toIndex: 0, role: 'host' }, 'BAD_REQUEST'],
      ['board:move', null, 'BAD_REQUEST'],
      ['board:move', 'hello', 'BAD_REQUEST'],
      ['board:flip', { cardId: 'x'.repeat(500) }, 'BAD_REQUEST'],
      ['board:flip', { cardId: firstCardId(snapshot) }, 'RULE_VIOLATION'], // this deck does not allow flipping
      ['board:shuffle', { scope: 'pile' }, 'BAD_REQUEST'],
      ['board:shuffle', { scope: 'pile', pileId: 'nope' }, 'PILE_NOT_FOUND'],
      ['board:shuffle', { scope: 'everything' }, 'BAD_REQUEST'],
      ['card:lock', {}, 'BAD_REQUEST'],
      ['card:lock', { cardId: 'ghost' }, 'CARD_NOT_FOUND'],
      ['host:set-permissions', { mode: 'admin' }, 'BAD_REQUEST'],
      ['host:set-permissions', { mode: 'all-students', isHost: true }, 'BAD_REQUEST'],
    ];
    for (const [event, payload, code] of bad) {
      const res = await call(host, event, payload);
      expect(res, `${String(event)} ${JSON.stringify(payload)}`).toMatchObject({ ok: false, code });
    }
    expect(h.server.rooms.get(snapshot.roomCode)!.board.version).toBe(version);
    // a missing ack callback must not crash the server
    (host as unknown as { emit(e: string, p: unknown): void }).emit('board:move', { garbage: true });
    await sleep(50);
    expect(await call(host, 'card:lock', { cardId: firstCardId(snapshot) })).toMatchObject({ ok: true });
  });

  it('11. validates uploaded decks on the server (create and load-deck)', async () => {
    const host = await h.connect();
    const good = {
      schemaVersion: 1, id: 'upl', name: 'Uploaded', version: '1',
      piles: [
        { id: 'a', label: 'A', cards: [{ id: 'a1', text: 'sh' }] },
        { id: 'b', label: 'B', cards: [{ id: 'b1', text: 'ee' }] },
        { id: 'c', label: 'C', cards: [{ id: 'c1', text: 'tch' }] },
      ],
    };
    const bad = await call(host, 'room:create', { deck: { ...good, piles: good.piles.slice(0, 2) } });
    expect(bad).toMatchObject({ ok: false, code: 'INVALID_DECK' });
    expect(bad.ok === false && bad.details?.join(' ')).toMatch(/exactly 3 piles/);
    expect(await call(host, 'room:create', { deck: { ...good, name: '' } })).toMatchObject({ ok: false, code: 'INVALID_DECK' });
    expect(await call(host, 'room:create', { deck: 'DROP TABLE' })).toMatchObject({ ok: false, code: 'INVALID_DECK' });
    expect(await call(host, 'room:create', { deckId: 'not-a-deck' })).toMatchObject({ ok: false, code: 'DECK_NOT_FOUND' });
    expect(await call(host, 'room:create', {})).toMatchObject({ ok: false, code: 'BAD_REQUEST' });
    expect(await call(host, 'room:create', { deckId: 'sample-cvc-short-vowels', deck: good })).toMatchObject({ ok: false, code: 'BAD_REQUEST' });
    expect(h.server.rooms.size).toBe(0);

    const big = { ...good, description: 'x'.repeat(200) };
    const tinyServer = await startHarness({ maxDeckBytes: 1024 });
    try {
      const s = await tinyServer.connect();
      const padded = { ...big, piles: [{ id: 'a', label: 'A', cards: Array.from({ length: 60 }, (_, i) => ({ id: `a${i}`, text: 'sh' })) }, good.piles[1], good.piles[2]] };
      expect(await call(s, 'room:create', { deck: padded })).toMatchObject({ ok: false, code: 'INVALID_DECK' });
    } finally { await tinyServer.stop(); }

    const created = must(await call<CreateRoomResult>(host, 'room:create', { deck: good }));
    expect(created.snapshot.deck.name).toBe('Uploaded');
    expect(created.snapshot.board.piles.map((p) => p.cards[0]!.text)).toEqual(['sh', 'ee', 'tch']);

    const student = await joinRoom(h, created.roomCode);
    const reload = nextEvent(student.student, 'room:snapshot', (s: RoomSnapshot) => s.deck.id === 'sample-phonograms');
    expect(await call(host, 'host:load-deck', { deck: { ...good, piles: [] } })).toMatchObject({ ok: false, code: 'INVALID_DECK' });
    must(await call(host, 'host:load-deck', { deckId: 'sample-phonograms' }));
    const [snap] = await reload;
    expect(snap.board.piles[0]!.label).toBe('Beginning');
  });

  it('12. keeps duplicate card text distinct end-to-end', async () => {
    const host = await h.connect();
    const dup = {
      schemaVersion: 1, id: 'dup', name: 'Dup', version: '1',
      piles: [
        { id: 'a', label: 'A', cards: [{ id: 'x1', text: 't' }, { id: 'x2', text: 't' }, { id: 'x3', text: 't' }] },
        { id: 'b', label: 'B', cards: [{ id: 'y1', text: 'a' }] },
        { id: 'c', label: 'C', cards: [{ id: 'z1', text: 't' }] },
      ],
    };
    const { roomCode } = must(await call<CreateRoomResult>(host, 'room:create', { deck: dup }));
    must(await call(host, 'board:move', { cardId: 'x2', toPileId: 'c', toIndex: 0 }));
    const room = h.server.rooms.get(roomCode)!;
    expect(room.board.piles[0]!.cards.map((c) => c.id)).toEqual(['x1', 'x3']);
    expect(room.board.piles[2]!.cards.map((c) => c.id)).toEqual(['x2', 'z1']);
    // two cards with identical text in the same pile remain individually addressable
    must(await call(host, 'board:move', { cardId: 'x3', toPileId: 'a', toIndex: 0 }));
    expect(room.board.piles[0]!.cards.map((c) => c.id)).toEqual(['x3', 'x1']);
  });
});

describe('reconnection, ending, conflicts (requirements 13-15)', () => {
  it('13. a reconnecting student (token) and teacher (host token) both receive the latest state', async () => {
    const { host, roomCode, hostToken, snapshot } = await createRoom(h);
    const a = await joinRoom(h, roomCode, 'Ada');
    const goneP = nextEvent(host, 'room:presence', (p: Presence) => p.participantCount === 0);
    a.student.close();
    await goneP;

    // while Ada is offline the board changes
    const card = firstCardId(snapshot, 0, 2);
    must(await call(host, 'board:move', { cardId: card, toPileId: snapshot.board.piles[1]!.id, toIndex: 0 }));
    must(await call(host, 'host:set-permissions', { mode: 'all-students' }));

    const back = await h.connect();
    const res = must<JoinResult>(await call<JoinResult>(back, 'room:join', { roomCode, participantToken: a.participantToken }));
    expect(res.you.participantId).toBe(a.you.participantId); // same seat
    expect(res.you.displayName).toBe('Ada');
    expect(res.participantToken).toBeUndefined();
    expect(cardIds(res.snapshot.board, 1)[0]).toBe(card);
    expect(res.snapshot.permissions.mode).toBe('all-students');
    expect(res.snapshot.presence.participantCount).toBe(1);

    // the teacher refreshes their browser: resume with the host token and get the same state, with participants
    host.close();
    const host2 = await h.connect();
    const hres = must<JoinResult>(await call<JoinResult>(host2, 'host:resume', { roomCode, hostToken }));
    expect(cardIds(hres.snapshot.board, 1)[0]).toBe(card);
    expect(hres.snapshot.presence.participants?.map((p) => p.name)).toEqual(['Ada']);
    expect(hres.snapshot.presence.hostConnected).toBe(true);
    // and still has full powers
    must(await call(host2, 'board:reset'));
  });

  it('a stale token falls back to a fresh seat; a second tab replaces the first', async () => {
    const { roomCode } = await createRoom(h);
    const s = await h.connect();
    const fresh = must<JoinResult>(await call<JoinResult>(s, 'room:join', { roomCode, displayName: 'Zed', participantToken: 'not-a-real-token-at-all' }));
    expect(fresh.participantToken).toBeTruthy();

    const a = await joinRoom(h, roomCode, 'Amy');
    const replaced = nextEvent(a.student, 'session:replaced');
    const tab2 = await h.connect();
    must(await call(tab2, 'room:join', { roomCode, participantToken: a.participantToken }));
    await replaced;
    expect(h.server.rooms.get(roomCode)!.presence(true).participantCount).toBe(2); // Zed + Amy (not 3)
  });

  it('14. ending a room notifies students, invalidates the code and the host token, and removes the data', async () => {
    const { host, roomCode, hostToken } = await createRoom(h);
    const a = await joinRoom(h, roomCode); const b = await joinRoom(h, roomCode);
    const endedA = nextEvent(a.student, 'room:ended'); const endedB = nextEvent(b.student, 'room:ended');
    must(await call(host, 'host:end'));
    expect((await endedA)[0]).toEqual({ reason: 'host-ended' });
    await endedB;
    expect(h.server.rooms.get(roomCode)).toBeUndefined();
    const late = await h.connect();
    expect(await call(late, 'room:join', { roomCode })).toMatchObject({ ok: false, code: 'ROOM_NOT_FOUND' });
    expect(await call(late, 'host:resume', { roomCode, hostToken })).toMatchObject({ ok: false, code: 'ROOM_NOT_FOUND' });
    // old sockets are detached: they can no longer act
    expect(await call(a.student, 'card:lock', { cardId: 'x' })).toMatchObject({ ok: false, code: 'NOT_IN_ROOM' });
    expect(await call(host, 'board:reset')).toMatchObject({ ok: false, code: 'NOT_IN_ROOM' });
  });

  it('15. resolves simultaneous conflicting drags predictably (lock, stale, host override)', async () => {
    const { host, roomCode, snapshot } = await createRoom(h);
    const a = await joinRoom(h, roomCode, 'A'); const b = await joinRoom(h, roomCode, 'B');
    must(await call(host, 'host:set-permissions', { mode: 'all-students' }));
    const card = firstCardId(snapshot, 0, 0);
    const other = firstCardId(snapshot, 0, 1);
    const pileB = snapshot.board.piles[1]!.id; const pileC = snapshot.board.piles[2]!.id;

    // both grab the same card at the same instant: exactly one wins
    const [ra, rb] = await Promise.all([call(a.student, 'card:lock', { cardId: card }), call(b.student, 'card:lock', { cardId: card })]);
    const winner = ra.ok ? a : b; const loser = ra.ok ? b : a;
    expect([ra.ok, rb.ok].filter(Boolean)).toHaveLength(1);
    expect(ra.ok ? rb : ra).toMatchObject({ ok: false, code: 'CARD_LOCKED' });

    // the loser can neither move nor flip it; the winner can
    expect(await call(loser.student, 'board:move', { cardId: card, toPileId: pileB, toIndex: 0 })).toMatchObject({ ok: false, code: 'CARD_LOCKED' });
    // everyone sees who holds the lock
    const locks = nextEvent(host, 'board:locks', (l: LockMap) => l[card]?.by === 'host');
    // the teacher always wins
    must(await call(host, 'card:lock', { cardId: card }));
    expect((await locks)[0][card]!.byName).toBe('Teacher');
    expect(await call(winner.student, 'board:move', { cardId: card, toPileId: pileB, toIndex: 0 })).toMatchObject({ ok: false, code: 'CARD_LOCKED' });
    must(await call(host, 'card:unlock', { cardId: card }));

    // stale: A and B both look at version v; A moves `card`, then B (who only saw v) tries to move it too
    const seen = h.server.rooms.get(roomCode)!.board.version;
    must(await call(a.student, 'board:move', { cardId: card, toPileId: pileB, toIndex: 0, baseVersion: seen }));
    const resync = nextEvent(b.student, 'room:snapshot');
    expect(await call(b.student, 'board:move', { cardId: card, toPileId: pileC, toIndex: 0, baseVersion: seen })).toMatchObject({ ok: false, code: 'STALE' });
    const [fresh] = await resync; // the loser is re-synchronised automatically
    expect(cardIds(fresh.board, 1)[0]).toBe(card);
    // ...but an unrelated card with the same old baseVersion is fine (conflicts are per card)
    must(await call(b.student, 'board:move', { cardId: other, toPileId: pileC, toIndex: 0, baseVersion: seen }));
  });

  it('releases a student\'s locks when they disconnect, and broadcasts the change', async () => {
    const { host, roomCode, snapshot } = await createRoom(h);
    const a = await joinRoom(h, roomCode);
    must(await call(host, 'host:set-permissions', { mode: 'all-students' }));
    const card = firstCardId(snapshot);
    must(await call(a.student, 'card:lock', { cardId: card }));
    const cleared = nextEvent(host, 'board:locks', (l: LockMap) => Object.keys(l).length === 0);
    a.student.close();
    await cleared;
  });

  it('expired locks are swept and broadcast', async () => {
    let t = 1_000_000;
    const h2 = await startHarness({ lockTtlMs: 5000 }, { now: () => t });
    try {
      const { host, snapshot } = await createRoom(h2);
      must(await call(host, 'card:lock', { cardId: firstCardId(snapshot) }));
      const cleared = nextEvent(host, 'board:locks', (l: LockMap) => Object.keys(l).length === 0);
      t += 5001;
      h2.server.sweep();
      await cleared;
    } finally { await h2.stop(); }
  });
});

describe('abuse protection and lifecycle', () => {
  it('rate-limits floods of state-changing events per connection', async () => {
    const h2 = await startHarness({ actionBurst: 5, actionRefillPerSec: 1 });
    try {
      const { host, snapshot } = await createRoom(h2);
      const card = firstCardId(snapshot);
      const results = await Promise.all(Array.from({ length: 20 }, () => call(host, 'card:lock', { cardId: card })));
      expect(results.some((r) => !r.ok && r.code === 'RATE_LIMITED')).toBe(true);
      expect(results.filter((r) => r.ok).length).toBeLessThanOrEqual(6);
    } finally { await h2.stop(); }
  });

  it('rate-limits room-code guessing and room creation per IP', async () => {
    const h2 = await startHarness({ joinPerMinute: 3, createPerMinute: 2 });
    try {
      const s = await h2.connect();
      const outcomes = [];
      for (let i = 0; i < 5; i++) outcomes.push(await call(s, 'room:join', { roomCode: 'ZZZZZ' }));
      expect(outcomes.map((o) => (o.ok ? 'ok' : o.code))).toEqual(['ROOM_NOT_FOUND', 'ROOM_NOT_FOUND', 'ROOM_NOT_FOUND', 'RATE_LIMITED', 'RATE_LIMITED']);
      const c = await h2.connect();
      const created = [];
      for (let i = 0; i < 3; i++) created.push(await call(c, 'room:create', { deckId: 'sample-cvc-short-vowels' }));
      // the 2nd create on one connection fails with BAD_REQUEST (already in a room), so use fresh sockets
      const creators = await Promise.all([h2.connect(), h2.connect(), h2.connect()]);
      const codes = [];
      for (const cs of creators) codes.push(await call(cs, 'room:create', { deckId: 'sample-cvc-short-vowels' }));
      expect(codes.some((r) => !r.ok && r.code === 'RATE_LIMITED')).toBe(true);
    } finally { await h2.stop(); }
  });

  it('refuses a connection that tries to join a second room', async () => {
    const r1 = await createRoom(h); const r2 = await createRoom(h);
    const s = await h.connect();
    must(await call(s, 'room:join', { roomCode: r1.roomCode }));
    expect(await call(s, 'room:join', { roomCode: r2.roomCode })).toMatchObject({ ok: false, code: 'BAD_REQUEST' });
  });

  it('enforces the participant cap and server capacity', async () => {
    const h2 = await startHarness({ maxParticipantsPerRoom: 2, maxRooms: 1 });
    try {
      const { roomCode } = await createRoom(h2);
      await joinRoom(h2, roomCode); await joinRoom(h2, roomCode);
      const s = await h2.connect();
      expect(await call(s, 'room:join', { roomCode })).toMatchObject({ ok: false, code: 'ROOM_FULL' });
      const c = await h2.connect();
      expect(await call(c, 'room:create', { deckId: 'sample-cvc-short-vowels' })).toMatchObject({ ok: false, code: 'SERVER_BUSY' });
    } finally { await h2.stop(); }
  });

  it('expires abandoned rooms and tells anyone still connected when the hard age limit hits', async () => {
    let t = 0;
    const h2 = await startHarness({ roomIdleTtlMs: 10_000, roomMaxAgeMs: 60_000, participantGraceMs: 5_000 }, { now: () => t });
    try {
      const abandoned = await createRoom(h2);
      const { host, roomCode } = await createRoom(h2);
      const a = await joinRoom(h2, roomCode);
      abandoned.host.close(); await sleep(50);
      t = 11_000; h2.server.sweep();
      expect(h2.server.rooms.get(abandoned.roomCode)).toBeUndefined(); // abandoned: gone
      expect(h2.server.rooms.get(roomCode)).toBeDefined(); // still connected: kept
      const ended = nextEvent(a.student, 'room:ended');
      t = 61_000; h2.server.sweep();
      expect((await ended)[0]).toEqual({ reason: 'expired' });
      expect(h2.server.rooms.size).toBe(0);
      void host;
    } finally { await h2.stop(); }
  });

  it('serves /healthz and the deck API; deck list is built from validated files', async () => {
    const health = await (await fetch(`${h.url}/healthz`)).json();
    expect(health).toMatchObject({ status: 'ok' });
    const { decks } = await (await fetch(`${h.url}/api/decks`)).json() as { decks: { id: string }[] };
    expect(decks.map((d) => d.id)).toContain('sample-phonograms');
    expect((await fetch(`${h.url}/api/decks/sample-phonograms`)).status).toBe(200);
    expect((await fetch(`${h.url}/api/decks/..%2Fpackage`)).status).toBe(404);
    expect((await fetch(`${h.url}/api/nope`)).status).toBe(404);
  });

  it('informs connected clients when the server shuts down', async () => {
    const { host } = await createRoom(h);
    const ended = nextEvent(host, 'room:ended');
    void h.server.shutdown('server-restart');
    expect((await ended)[0]).toEqual({ reason: 'server-restart' });
  });
});

void ioClient;
