/**
 * Pure board operations. No I/O, no sockets, no permissions: those live in Room.
 * Every function returns a NEW board (inputs are never mutated) so callers can safely compare or roll back.
 */
import { randomInt } from 'node:crypto';
import type { Deck, DeckRules, ErrorCode, BoardView } from '@shared/index';

export interface CardState {
  id: string;
  text: string;
  faceDown: boolean;
}
export interface PileState {
  id: string;
  label: string;
  cards: CardState[];
}
export interface BoardState {
  version: number;
  piles: PileState[];
}

export type Rng = (maxExclusive: number) => number;
export const secureRandomInt: Rng = (n) => randomInt(n);

export type EngineResult<T extends object = object> = ({ ok: true } & T) | { ok: false; code: ErrorCode; message: string };

/** Fisher-Yates shuffle (in place) driven by an injectable RNG. */
export function shuffleInPlace<T>(items: T[], rng: Rng = secureRandomInt): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = rng(i + 1);
    const tmp = items[i] as T;
    items[i] = items[j] as T;
    items[j] = tmp;
  }
  return items;
}

const clonePile = (p: PileState): PileState => ({ ...p, cards: p.cards.map((c) => ({ ...c })) });
export const cloneBoard = (b: BoardState): BoardState => ({ version: b.version, piles: b.piles.map(clonePile) });

export function createBoard(deck: Deck, rng: Rng = secureRandomInt): BoardState {
  const piles: PileState[] = deck.piles.map((p) => ({
    id: p.id,
    label: p.label,
    cards: p.cards.map((c) => ({ id: c.id, text: c.text, faceDown: c.faceDown ?? false })),
  }));
  if (deck.rules.initialShuffle) piles.forEach((p) => shuffleInPlace(p.cards, rng));
  return { version: 1, piles };
}

export function allCardIds(board: BoardState): string[] {
  return board.piles.flatMap((p) => p.cards.map((c) => c.id));
}

export function findCard(board: BoardState, cardId: string): { pileIndex: number; cardIndex: number; card: CardState } | null {
  for (let pi = 0; pi < board.piles.length; pi++) {
    const pile = board.piles[pi] as PileState;
    const ci = pile.cards.findIndex((c) => c.id === cardId);
    if (ci >= 0) return { pileIndex: pi, cardIndex: ci, card: pile.cards[ci] as CardState };
  }
  return null;
}

export const findPile = (board: BoardState, pileId: string): PileState | undefined => board.piles.find((p) => p.id === pileId);

export type MoveOk = { ok: true; board: BoardState; changed: boolean; affected: string[] };

export function moveCard(board: BoardState, rules: DeckRules, cardId: string, toPileId: string, toIndex: number): EngineResult<Omit<MoveOk, 'ok'>> {
  const from = findCard(board, cardId);
  if (!from) return { ok: false, code: 'CARD_NOT_FOUND', message: 'That card is not on the board.' };
  const destPileIdx = board.piles.findIndex((p) => p.id === toPileId);
  if (destPileIdx < 0) return { ok: false, code: 'PILE_NOT_FOUND', message: 'That pile does not exist.' };
  if (!Number.isInteger(toIndex) || toIndex < 0) return { ok: false, code: 'BAD_REQUEST', message: 'Invalid position.' };

  const samePile = from.pileIndex === destPileIdx;
  if (!samePile && !rules.allowCrossPileMoves) {
    return { ok: false, code: 'RULE_VIOLATION', message: 'This deck keeps cards in their own pile.' };
  }
  if (samePile && !rules.allowReorder) {
    return { ok: false, code: 'RULE_VIOLATION', message: 'This deck does not allow re-ordering within a pile.' };
  }

  const next = cloneBoard(board);
  const [moved] = (next.piles[from.pileIndex] as PileState).cards.splice(from.cardIndex, 1) as [CardState];
  const dest = next.piles[destPileIdx] as PileState;
  const index = Math.min(toIndex, dest.cards.length);
  if (samePile && index === from.cardIndex) {
    return { ok: true, board, changed: false, affected: [] };
  }
  dest.cards.splice(index, 0, moved);
  next.version = board.version + 1;
  return { ok: true, board: next, changed: true, affected: [cardId] };
}

export function flipCard(board: BoardState, rules: DeckRules, cardId: string): EngineResult<{ board: BoardState; affected: string[] }> {
  if (!rules.allowFlip) return { ok: false, code: 'RULE_VIOLATION', message: 'This deck does not use flipping.' };
  const found = findCard(board, cardId);
  if (!found) return { ok: false, code: 'CARD_NOT_FOUND', message: 'That card is not on the board.' };
  const next = cloneBoard(board);
  const card = (next.piles[found.pileIndex] as PileState).cards[found.cardIndex] as CardState;
  card.faceDown = !card.faceDown;
  next.version = board.version + 1;
  return { ok: true, board: next, affected: [cardId] };
}

export function shuffleBoard(board: BoardState, target: 'all' | string, rng: Rng = secureRandomInt): EngineResult<{ board: BoardState; affected: string[] }> {
  if (target !== 'all' && !findPile(board, target)) return { ok: false, code: 'PILE_NOT_FOUND', message: 'That pile does not exist.' };
  const next = cloneBoard(board);
  const affected: string[] = [];
  for (const pile of next.piles) {
    if (target === 'all' || pile.id === target) {
      shuffleInPlace(pile.cards, rng);
      affected.push(...pile.cards.map((c) => c.id));
    }
  }
  next.version = board.version + 1;
  return { ok: true, board: next, affected };
}

/** Restore an earlier arrangement under a fresh version number. */
export function restoreBoard(initial: BoardState, currentVersion: number): BoardState {
  const b = cloneBoard(initial);
  b.version = currentVersion + 1;
  return b;
}

/**
 * Serialise for a client. Viewers other than the host never receive the text of face-down cards,
 * so "reveal" really hides information (not just visually).
 */
export function toBoardView(board: BoardState, forHost: boolean): BoardView {
  return {
    version: board.version,
    piles: board.piles.map((p) => ({
      id: p.id,
      label: p.label,
      cards: p.cards.map((c) => ({ id: c.id, text: c.faceDown && !forHost ? null : c.text, faceDown: c.faceDown })),
    })),
  };
}
