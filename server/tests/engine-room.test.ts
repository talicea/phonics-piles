import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { validateDeck, type Deck } from '@shared/index';
import { createBoard, flipCard, moveCard, shuffleBoard, shuffleInPlace, toBoardView, type Rng } from '../src/game/engine';
import { Room } from '../src/rooms/room';
import { RoomManager } from '../src/rooms/roomManager';
import { loadConfig } from '../src/config';

const deckFrom = (extra: Record<string, unknown> = {}): Deck => {
  const r = validateDeck({
    schemaVersion: 1, id: 'd', name: 'D', version: '1',
    piles: [
      { id: 'p1', label: 'One', cards: [{ id: 'c1', text: 'sh' }, { id: 'c2', text: 'sh' }, { id: 'c3', text: 'b' }] },
      { id: 'p2', label: 'Two', cards: [{ id: 'c4', text: 'a' }, { id: 'c5', text: 'e', faceDown: true }] },
      { id: 'p3', label: 'Three', cards: [{ id: 'c6', text: 'ck' }] },
    ],
    rules: { allowFlip: true },
    ...extra,
  });
  if (!r.ok) throw new Error(r.errors.join(';'));
  return r.deck;
};
const ids = (b: ReturnType<typeof createBoard>, pile: number) => b.piles[pile]!.cards.map((c) => c.id);
const seqRng = (): Rng => { let i = 0; return (n) => (i++ * 7 + 3) % n; };

describe('engine', () => {
  it('creates a board with stable ids and keeps duplicate text distinct (requirement 12)', () => {
    const b = createBoard(deckFrom());
    expect(ids(b, 0)).toEqual(['c1', 'c2', 'c3']);
    expect(b.piles[0]!.cards[0]!.text).toBe(b.piles[0]!.cards[1]!.text);
    const moved = moveCard(b, deckFrom().rules, 'c2', 'p3', 0);
    expect(moved.ok && ids(moved.board, 0)).toEqual(['c1', 'c3']); // the OTHER "sh" is untouched
    expect(moved.ok && ids(moved.board, 2)).toEqual(['c2', 'c6']);
  });

  it('moves within and across piles, clamps the index and never mutates the input', () => {
    const b = createBoard(deckFrom());
    const before = JSON.stringify(b);
    const r1 = moveCard(b, deckFrom().rules, 'c1', 'p1', 99);
    expect(r1.ok && ids(r1.board, 0)).toEqual(['c2', 'c3', 'c1']);
    expect(JSON.stringify(b)).toBe(before);
    const r2 = moveCard(b, deckFrom().rules, 'c1', 'p1', 0);
    expect(r2.ok && r2.changed).toBe(false);
    expect(r2.ok && r2.board.version).toBe(b.version);
  });

  it('rejects unknown cards/piles and rule violations', () => {
    const b = createBoard(deckFrom());
    const rules = deckFrom().rules;
    expect(moveCard(b, rules, 'nope', 'p1', 0)).toMatchObject({ ok: false, code: 'CARD_NOT_FOUND' });
    expect(moveCard(b, rules, 'c1', 'nope', 0)).toMatchObject({ ok: false, code: 'PILE_NOT_FOUND' });
    expect(moveCard(b, rules, 'c1', 'p1', -1)).toMatchObject({ ok: false });
    expect(moveCard(b, rules, 'c1', 'p1', 1.5)).toMatchObject({ ok: false });
    expect(moveCard(b, { ...rules, allowCrossPileMoves: false }, 'c1', 'p2', 0)).toMatchObject({ ok: false, code: 'RULE_VIOLATION' });
    expect(moveCard(b, { ...rules, allowReorder: false }, 'c1', 'p1', 2)).toMatchObject({ ok: false, code: 'RULE_VIOLATION' });
    expect(flipCard(b, { ...rules, allowFlip: false }, 'c1')).toMatchObject({ ok: false, code: 'RULE_VIOLATION' });
  });

  it('shuffles one pile or all piles, preserving the card set', () => {
    const b = createBoard(deckFrom());
    const one = shuffleBoard(b, 'p1', seqRng());
    expect(one.ok && [...ids(one.board, 0)].sort()).toEqual(['c1', 'c2', 'c3']);
    expect(one.ok && ids(one.board, 1)).toEqual(['c4', 'c5']); // other piles untouched
    const all = shuffleBoard(b, 'all');
    expect(all.ok && all.board.version).toBe(b.version + 1);
    expect(shuffleBoard(b, 'zzz')).toMatchObject({ ok: false, code: 'PILE_NOT_FOUND' });
    const arr = [1, 2, 3, 4, 5, 6];
    expect(shuffleInPlace([...arr]).sort()).toEqual(arr);
  });

  it('hides the text of face-down cards from non-host views', () => {
    const b = createBoard(deckFrom());
    expect(toBoardView(b, false).piles[1]!.cards[1]).toEqual({ id: 'c5', text: null, faceDown: true });
    expect(toBoardView(b, true).piles[1]!.cards[1]).toEqual({ id: 'c5', text: 'e', faceDown: true });
  });
});

const mkRoom = (now = 0, rng?: Rng) => new Room({ code: 'ABCDE', hostToken: 'host-secret-token-123456', deck: deckFrom(), now, lockTtlMs: 8000, maxParticipants: 3, ...(rng ? { rng } : {}) });
const HOST = { role: 'host' } as const;

describe('room: permissions and conflicts (requirements 7-9, 15)', () => {
  it('only lets the host manipulate by default and honours each mode', () => {
    const room = mkRoom();
    const a = room.addStudent('Ann', 's1'); const b = room.addStudent('Bo', 's2');
    if (!a.ok || !b.ok) throw new Error('join failed');
    const A = { role: 'student', participantId: a.participant.id } as const;
    const B = { role: 'student', participantId: b.participant.id } as const;
    expect(room.canManipulate(HOST)).toBe(true);
    expect(room.canManipulate(A)).toBe(false);
    expect(room.moveCard(A, { cardId: 'c1', toPileId: 'p2', toIndex: 0 }, 0)).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    room.setPermissions(HOST, 'all-students', null);
    expect(room.canManipulate(A) && room.canManipulate(B)).toBe(true);
    room.setPermissions(HOST, 'one-student', a.participant.id);
    expect(room.canManipulate(A)).toBe(true);
    expect(room.canManipulate(B)).toBe(false);
    expect(room.setPermissions(HOST, 'one-student', 'p_missing')).toMatchObject({ ok: false, code: 'PARTICIPANT_NOT_FOUND' });
    expect(room.setPermissions(A, 'all-students', null)).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(room.reset(A)).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(room.loadDeck(A, deckFrom())).toMatchObject({ ok: false, code: 'FORBIDDEN' });
  });

  it('enforces the participant cap and de-duplicates display names', () => {
    const room = mkRoom();
    const a = room.addStudent('Sam', 's1'); const b = room.addStudent('sam', 's2'); room.addStudent(undefined, 's3');
    expect(a.ok && a.participant.name).toBe('Sam');
    expect(b.ok && b.participant.name).toBe('sam (2)');
    expect(room.addStudent('x', 's4')).toMatchObject({ ok: false, code: 'ROOM_FULL' });
  });

  it('first locker wins; the host overrides; locks expire', () => {
    const room = mkRoom();
    const a = room.addStudent('Ann', 's1'); const b = room.addStudent('Bo', 's2');
    if (!a.ok || !b.ok) throw new Error();
    const A = { role: 'student', participantId: a.participant.id } as const;
    const B = { role: 'student', participantId: b.participant.id } as const;
    room.setPermissions(HOST, 'all-students', null);
    expect(room.lockCard(A, 'c1', 0)).toMatchObject({ ok: true });
    expect(room.lockCard(B, 'c1', 10)).toMatchObject({ ok: false, code: 'CARD_LOCKED' });
    expect(room.moveCard(B, { cardId: 'c1', toPileId: 'p2', toIndex: 0 }, 10)).toMatchObject({ ok: false, code: 'CARD_LOCKED' });
    expect(room.flipCard(B, { cardId: 'c1' }, 10)).toMatchObject({ ok: false, code: 'CARD_LOCKED' });
    expect(room.lockMap().c1).toEqual({ by: a.participant.id, byName: 'Ann' });
    // the abandoned lock times out (8 s)
    expect(room.lockCard(B, 'c1', 8001)).toMatchObject({ ok: true });
    // host steals it and moves the card
    expect(room.moveCard(HOST, { cardId: 'c1', toPileId: 'p3', toIndex: 0 }, 8100)).toMatchObject({ ok: true });
    expect(room.lockMap().c1).toBeUndefined();
  });

  it('a lock holder can move their own card, and the move releases the lock', () => {
    const room = mkRoom();
    const a = room.addStudent('Ann', 's1'); if (!a.ok) throw new Error();
    const A = { role: 'student', participantId: a.participant.id } as const;
    room.setPermissions(HOST, 'all-students', null);
    room.lockCard(A, 'c1', 0);
    const r = room.moveCard(A, { cardId: 'c1', toPileId: 'p2', toIndex: 1 }, 100);
    expect(r).toMatchObject({ ok: true, changes: ['board', 'locks'] });
    expect(room.lockMap()).toEqual({});
  });

  it('one lock per participant: locking a second card releases the first', () => {
    const room = mkRoom();
    room.lockCard(HOST, 'c1', 0); room.lockCard(HOST, 'c2', 1);
    expect(Object.keys(room.lockMap())).toEqual(['c2']);
  });

  it('rejects stale moves of a card that changed since the client saw it, but not unrelated cards', () => {
    const room = mkRoom();
    room.setPermissions(HOST, 'all-students', null);
    const seen = room.board.version;
    expect(room.moveCard(HOST, { cardId: 'c1', toPileId: 'p2', toIndex: 0 }, 0)).toMatchObject({ ok: true });
    expect(room.moveCard(HOST, { cardId: 'c1', toPileId: 'p3', toIndex: 0, baseVersion: seen }, 1)).toMatchObject({ ok: false, code: 'STALE' });
    expect(room.moveCard(HOST, { cardId: 'c3', toPileId: 'p3', toIndex: 0, baseVersion: seen }, 2)).toMatchObject({ ok: true });
  });

  it('shuffle invalidates in-flight moves; students cannot shuffle a pile with someone else\'s locked card', () => {
    const room = mkRoom();
    const a = room.addStudent('Ann', 's1'); const b = room.addStudent('Bo', 's2');
    if (!a.ok || !b.ok) throw new Error();
    const A = { role: 'student', participantId: a.participant.id } as const;
    const B = { role: 'student', participantId: b.participant.id } as const;
    room.setPermissions(HOST, 'all-students', null);
    room.lockCard(A, 'c1', 0);
    expect(room.shuffle(B, 'p1', 1)).toMatchObject({ ok: false, code: 'CARD_LOCKED' });
    expect(room.shuffle(B, 'p2', 1)).toMatchObject({ ok: true });
    const seen = room.board.version - 1;
    expect(room.shuffle(HOST, 'p1', 2)).toMatchObject({ ok: true }); // host override clears the lock
    expect(room.lockMap()).toEqual({});
    expect(room.moveCard(A, { cardId: 'c1', toPileId: 'p2', toIndex: 0, baseVersion: seen }, 3)).toMatchObject({ ok: false, code: 'STALE' });
  });

  it('losing permission releases locks immediately', () => {
    const room = mkRoom();
    const a = room.addStudent('Ann', 's1'); if (!a.ok) throw new Error();
    const A = { role: 'student', participantId: a.participant.id } as const;
    room.setPermissions(HOST, 'all-students', null);
    room.lockCard(A, 'c1', 0);
    const r = room.setPermissions(HOST, 'teacher-only', null);
    expect(r).toMatchObject({ ok: true, changes: ['permissions', 'locks'] });
    expect(room.lockMap()).toEqual({});
  });

  it('reset restores the initial arrangement; loadDeck replaces the board and bumps the version', () => {
    const room = mkRoom();
    const v0 = room.board.version;
    room.moveCard(HOST, { cardId: 'c1', toPileId: 'p3', toIndex: 0 }, 0);
    room.flipCard(HOST, { cardId: 'c1' }, 0);
    expect(room.reset(HOST)).toMatchObject({ ok: true });
    expect(room.board.piles[0]!.cards.map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
    expect(room.board.piles[0]!.cards[0]!.faceDown).toBe(false);
    expect(room.board.version).toBeGreaterThan(v0 + 2);
    expect(room.loadDeck(HOST, deckFrom({ id: 'other' }))).toMatchObject({ ok: true, changes: ['snapshot'] });
    expect(room.deck.id).toBe('other');
  });

  it('students disconnect/reconnect with their token; absent students are removed after the grace period', () => {
    const room = mkRoom();
    const a = room.addStudent('Ann', 's1'); if (!a.ok) throw new Error();
    room.setPermissions(HOST, 'one-student', a.participant.id);
    room.unbindStudent(a.participant.id, 's1', 1000);
    expect(room.presence(false).participantCount).toBe(0);
    expect(room.rebindStudent('wrong-token-value', 's9')).toMatchObject({ ok: false });
    const back = room.rebindStudent(a.token, 's2');
    expect(back).toMatchObject({ ok: true, participant: { id: a.participant.id } });
    room.unbindStudent(a.participant.id, 's2', 2000);
    // a stale socket's disconnect must not mark the new connection offline
    room.rebindStudent(a.token, 's3');
    expect(room.unbindStudent(a.participant.id, 's2', 2500)).toEqual([]);
    room.unbindStudent(a.participant.id, 's3', 3000);
    expect(room.sweep(3000 + 299_999, 300_000)).toEqual([]);
    expect(room.sweep(3000 + 300_000, 300_000).sort()).toEqual(['permissions', 'presence']);
    expect(room.permissions.activeStudentId).toBeNull();
    expect(room.hasStudent(a.participant.id)).toBe(false);
  });

  it('only the real host token verifies, and it is never part of a snapshot', () => {
    const room = mkRoom();
    expect(room.verifyHostToken('host-secret-token-123456')).toBe(true);
    expect(room.verifyHostToken('host-secret-token-123457')).toBe(false);
    expect(JSON.stringify(room.snapshot(true))).not.toContain('host-secret-token');
  });
});

describe('room manager (requirement 1)', () => {
  it('generates valid, unique codes among active rooms and never reuses a live code', () => {
    const config = loadConfig({}, { roomCodeLength: 4, maxRooms: 2000 });
    const mgr = new RoomManager(config);
    const deck = deckFrom();
    const codes = new Set<string>();
    for (let i = 0; i < 1500; i++) {
      const created = mgr.create(deck, 0);
      expect(created).not.toBeNull();
      const code = created!.room.code;
      expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/);
      expect(codes.has(code)).toBe(false);
      codes.add(code);
    }
    expect(mgr.size).toBe(1500);
  });

  it('refuses new rooms at capacity, and expires abandoned or over-age rooms', () => {
    const config = loadConfig({}, { maxRooms: 2, roomIdleTtlMs: 1000, roomMaxAgeMs: 5000, participantGraceMs: 0 });
    const mgr = new RoomManager(config);
    const r1 = mgr.create(deckFrom(), 0)!; const r2 = mgr.create(deckFrom(), 0)!;
    expect(mgr.create(deckFrom(), 0)).toBeNull();
    r1.room.bindHost('h1'); // r1 stays connected; r2 never had a connection after creation
    expect(mgr.sweep(1000).expired.map((r) => r.code)).toEqual([r2.room.code]);
    expect(mgr.get(r1.room.code)).toBeDefined();
    r1.room.unbindHost('h1', 2000);
    expect(mgr.sweep(2999).expired).toHaveLength(0);
    expect(mgr.sweep(3000).expired).toHaveLength(1);
    expect(mgr.size).toBe(0);
  });
});

it('built-in deck files exist', () => {
  expect(fs.readdirSync('decks').length).toBeGreaterThan(2);
});
