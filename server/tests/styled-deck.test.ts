import { afterEach, beforeEach, expect, it } from 'vitest';
import type { CreateRoomResult } from '@shared/index';
import { call, joinRoom, must, startHarness, type Harness } from './helpers';

let h: Harness;
beforeEach(async () => { h = await startHarness(); });
afterEach(async () => { await h.stop(); });

const deck = {
  schemaVersion: 1, id: 'styled', name: 'Styled', version: '1',
  piles: [
    { id: 'a', label: 'A', cards: [{ id: 'a1', text: 'sh', style: { textColor: '#990000', corners: { topLeft: { text: '2' } } } }, { id: 'a2', text: 't' }] },
    { id: 'b', label: 'B', cards: [{ id: 'b1', text: 'a' }] },
    { id: 'c', label: 'C', cards: [{ id: 'c1', text: 'ck' }] },
  ],
  cardStyle: { fontId: 'playwrite-co', outlineWidth: 0.017 }, cardAspectRatio: 0.6662,
};

it('sends a deck\'s formatting to teacher and students, and rejects malicious styles on the server', async () => {
  const host = await h.connect();
  const bad = await call(host, 'room:create', { deck: { ...deck, cardStyle: { textColor: 'red;}</style><script>alert(1)</script>' } } });
  expect(bad).toMatchObject({ ok: false, code: 'INVALID_DECK' });

  const created = must<CreateRoomResult>(await call<CreateRoomResult>(host, 'room:create', { deck }));
  expect(created.snapshot.deck).toMatchObject({ styled: true, aspectRatio: 0.6662, cardStyle: { fontId: 'playwrite-co' } });
  expect(created.snapshot.deck.cardStyles).toEqual({ a1: { textColor: '#990000', corners: { topLeft: { text: '2' } } } });

  const { snapshot } = await joinRoom(h, created.roomCode);
  expect(snapshot.deck.styled).toBe(true);
  expect(snapshot.deck.cardStyles.a1?.textColor).toBe('#990000');

  // built-in plain decks are unaffected
  const plain = await h.connect();
  const p = must<CreateRoomResult>(await call<CreateRoomResult>(plain, 'room:create', { deckId: 'sample-phonograms' }));
  expect(p.snapshot.deck).toMatchObject({ styled: false, cardStyles: {} });
});
