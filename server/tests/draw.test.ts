import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BoardView } from '@shared/index';
import { createBoard, drawTop, recycleDiscard, undoDraw, type BoardState } from '../src/game/engine';
import { validateDeck } from '@shared/index';
import { call, createRoom, joinRoom, must, nextEvent, startHarness, type Harness } from './helpers';

const deck = () => {
  const r = validateDeck({
    schemaVersion: 1, id: 'd', name: 'D', version: '1',
    piles: [
      { id: 'p1', label: 'One', cards: [{ id: 'c1', text: 'b' }, { id: 'c2', text: 'c' }, { id: 'c3', text: 'd' }] },
      { id: 'p2', label: 'Two', cards: [{ id: 'c4', text: 'a' }] },
      { id: 'p3', label: 'Three', cards: [{ id: 'c5', text: 't' }, { id: 'c6', text: 'n', faceDown: true }] },
    ],
    rules: { allowFlip: true },
  });
  if (!r.ok) throw new Error(r.errors.join());
  return r.deck;
};
const ids = (b: BoardState, i: number, which: 'cards' | 'discard' = 'cards') => b.piles[i]![which].map((c) => c.id);
const everyCard = (b: BoardState) => b.piles.flatMap((p) => [...p.cards, ...p.discard].map((c) => c.id)).sort();

describe('engine: draw / undo / recycle', () => {
  it('draws the top card onto the discard and reveals the next, without losing or duplicating cards', () => {
    const b0 = createBoard(deck());
    const r1 = drawTop(b0, 'p1'); if (!r1.ok) throw new Error();
    expect(ids(r1.board, 0)).toEqual(['c2', 'c3']); expect(ids(r1.board, 0, 'discard')).toEqual(['c1']);
    const r2 = drawTop(r1.board, 'p1'); if (!r2.ok) throw new Error();
    expect(ids(r2.board, 0)).toEqual(['c3']); expect(ids(r2.board, 0, 'discard')).toEqual(['c2', 'c1']); // newest first
    expect(everyCard(r2.board)).toEqual(everyCard(b0));
    expect(r2.board.version).toBe(b0.version + 2);
    expect(ids(b0, 0)).toEqual(['c1', 'c2', 'c3']); // input untouched
  });

  it('rejects an empty pile, an unknown pile, and a stale expectation', () => {
    const b = createBoard(deck());
    expect(drawTop(b, 'nope')).toMatchObject({ ok: false, code: 'PILE_NOT_FOUND' });
    expect(drawTop(b, 'p1', 'c2')).toMatchObject({ ok: false, code: 'STALE' });
    const d = drawTop(b, 'p2'); if (!d.ok) throw new Error();
    expect(drawTop(d.board, 'p2')).toMatchObject({ ok: false, code: 'RULE_VIOLATION' });
  });

  it('undo puts the last drawn card back on top; nothing to undo is an error', () => {
    const b = createBoard(deck());
    expect(undoDraw(b, 'p1')).toMatchObject({ ok: false, code: 'RULE_VIOLATION' });
    const d1 = drawTop(b, 'p1'); const d2 = d1.ok ? drawTop(d1.board, 'p1') : d1; if (!d2.ok) throw new Error();
    const u = undoDraw(d2.board, 'p1'); if (!u.ok) throw new Error();
    expect(ids(u.board, 0)).toEqual(['c2', 'c3']); expect(ids(u.board, 0, 'discard')).toEqual(['c1']);
  });

  it('recycle restores the original order without shuffle, and keeps every card with shuffle', () => {
    let b = createBoard(deck());
    for (let i = 0; i < 3; i++) { const r = drawTop(b, 'p1'); if (!r.ok) throw new Error(); b = r.board; }
    expect(ids(b, 0)).toEqual([]);
    const plain = recycleDiscard(b, 'p1', false); if (!plain.ok) throw new Error();
    expect(ids(plain.board, 0)).toEqual(['c1', 'c2', 'c3']); expect(ids(plain.board, 0, 'discard')).toEqual([]);
    const shuffled = recycleDiscard(b, 'p1', true, (n) => n - 1); if (!shuffled.ok) throw new Error();
    expect([...ids(shuffled.board, 0)].sort()).toEqual(['c1', 'c2', 'c3']);
    expect(recycleDiscard(plain.board, 'p1', true)).toMatchObject({ ok: false, code: 'RULE_VIOLATION' }); // nothing to recycle
  });

  it('recycling while cards remain puts the discards underneath', () => {
    const b = createBoard(deck());
    const d = drawTop(b, 'p1'); if (!d.ok) throw new Error();
    const r = recycleDiscard(d.board, 'p1', false); if (!r.ok) throw new Error();
    expect(ids(r.board, 0)).toEqual(['c2', 'c3', 'c1']);
  });
});

let h: Harness;
beforeEach(async () => { h = await startHarness(); });
afterEach(async () => { await h.stop(); });
const pile = (b: BoardView, i: number) => b.piles[i]!;

describe('draw over the wire', () => {
  it('teacher taps a pile: every screen shows the card moving to the discard and the next one appearing', async () => {
    const { host, roomCode, snapshot } = await createRoom(h);
    const a = await joinRoom(h, roomCode); const b = await joinRoom(h, roomCode);
    const top = pile(snapshot.board, 0).cards[0]!.id; const next = pile(snapshot.board, 0).cards[1]!.id;
    const seenA = nextEvent(a.student, 'board:update', (bd: BoardView) => pile(bd, 0).discard[0]?.id === top);
    const seenB = nextEvent(b.student, 'board:update', (bd: BoardView) => pile(bd, 0).discard[0]?.id === top);
    must(await call(host, 'pile:draw', { pileId: pile(snapshot.board, 0).id, expectedCardId: top }));
    const [ba] = await seenA; await seenB;
    expect(pile(ba, 0).cards[0]!.id).toBe(next);
    expect(pile(ba, 0).cards).toHaveLength(pile(snapshot.board, 0).cards.length - 1);
    // a student who joins later sees the discard too
    const late = await joinRoom(h, roomCode);
    expect(pile(late.snapshot.board, 0).discard.map((c) => c.id)).toEqual([top]);
  });

  it('a double tap draws exactly once (the second request is stale), and the loser is re-synced', async () => {
    const { host, snapshot } = await createRoom(h);
    const p = pile(snapshot.board, 1); const top = p.cards[0]!.id;
    const resync = nextEvent(host, 'room:snapshot');
    const [r1, r2] = await Promise.all([
      call(host, 'pile:draw', { pileId: p.id, expectedCardId: top }),
      call(host, 'pile:draw', { pileId: p.id, expectedCardId: top }),
    ]);
    expect([r1.ok, r2.ok].filter(Boolean)).toHaveLength(1);
    expect(r1.ok ? r2 : r1).toMatchObject({ ok: false, code: 'STALE' });
    const [fresh] = await resync;
    expect(pile(fresh.board, 1).discard).toHaveLength(1);
    expect(h.server.rooms.get(snapshot.roomCode)!.board.piles[1]!.discard).toHaveLength(1);
  });

  it('students can draw only when permitted; one-student mode honours the designated student', async () => {
    const { host, roomCode, snapshot } = await createRoom(h);
    const a = await joinRoom(h, roomCode, 'A'); const b = await joinRoom(h, roomCode, 'B');
    const p = pile(snapshot.board, 0);
    for (const ev of ['pile:draw', 'pile:undo', 'pile:recycle'] as const) {
      expect(await call(a.student, ev, { pileId: p.id }), ev).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    }
    expect(h.server.rooms.get(roomCode)!.board.version).toBe(snapshot.board.version);
    must(await call(host, 'host:set-permissions', { mode: 'one-student', activeStudentId: a.you.participantId }));
    expect(await call(b.student, 'pile:draw', { pileId: p.id })).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    must(await call(a.student, 'pile:draw', { pileId: p.id }));
    must(await call(host, 'host:set-permissions', { mode: 'all-students' }));
    must(await call(b.student, 'pile:undo', { pileId: p.id }));
    expect(h.server.rooms.get(roomCode)!.board.piles[0]!.discard).toHaveLength(0);
  });

  it('validates payloads and unknown piles', async () => {
    const { host } = await createRoom(h);
    for (const [ev, payload, code] of [
      ['pile:draw', {}, 'BAD_REQUEST'], ['pile:draw', { pileId: 5 }, 'BAD_REQUEST'], ['pile:draw', { pileId: 'x', extra: 1 }, 'BAD_REQUEST'],
      ['pile:draw', { pileId: 'nope' }, 'PILE_NOT_FOUND'], ['pile:undo', { pileId: 'nope' }, 'PILE_NOT_FOUND'],
      ['pile:recycle', { pileId: 'nope', shuffle: 'yes' }, 'BAD_REQUEST'], ['pile:recycle', { pileId: 'nope' }, 'PILE_NOT_FOUND'],
    ] as const) expect(await call(host, ev, payload), `${ev} ${JSON.stringify(payload)}`).toMatchObject({ ok: false, code });
  });

  it('draw → recycle round trip keeps every card, and reset / change deck clear the discards', async () => {
    const { host, roomCode, snapshot } = await createRoom(h);
    const p = pile(snapshot.board, 2); const n = p.cards.length;
    for (let i = 0; i < n; i++) must(await call(host, 'pile:draw', { pileId: p.id }));
    expect(await call(host, 'pile:draw', { pileId: p.id })).toMatchObject({ ok: false, code: 'RULE_VIOLATION' }); // empty
    must(await call(host, 'pile:recycle', { pileId: p.id }));
    const room = h.server.rooms.get(roomCode)!;
    expect(room.board.piles[2]!.cards.map((c) => c.id).sort()).toEqual(p.cards.map((c) => c.id).sort());
    expect(room.board.piles[2]!.discard).toEqual([]);
    must(await call(host, 'pile:draw', { pileId: p.id })); must(await call(host, 'pile:draw', { pileId: pile(snapshot.board, 0).id }));
    must(await call(host, 'board:reset'));
    expect(room.board.piles.map((x) => x.discard.length)).toEqual([0, 0, 0]);
    expect(room.board.piles[2]!.cards.map((c) => c.id)).toEqual(p.cards.map((c) => c.id)); // back to the starting order
    must(await call(host, 'pile:draw', { pileId: p.id }));
    must(await call(host, 'host:load-deck', { deckId: 'sample-phonograms' }));
    expect(room.board.piles.every((x) => x.discard.length === 0)).toBe(true);
  });

  it('hides the text of face-down discards from students', async () => {
    const { host, roomCode, snapshot } = await createRoom(h, 'sample-mystery-flip');
    const s = await joinRoom(h, roomCode);
    const mid = pile(snapshot.board, 1);
    const seen = nextEvent(s.student, 'board:update', (bd: BoardView) => pile(bd, 1).discard.length === 1);
    must(await call(host, 'pile:draw', { pileId: mid.id }));
    const [bd] = await seen;
    expect(pile(bd, 1).discard[0]).toMatchObject({ faceDown: true, text: null }); // the mystery deck's middle cards start face-down
  });
});
