import { isStyledDeck, type Deck } from './deck';
import type { DeckMeta } from './types';

/** What clients need to know about a deck to draw its cards. Used by the server (room snapshots) and by the deck preview. */
export function buildDeckMeta(deck: Deck): DeckMeta {
  const { id, name, description, version, rules, cardStyle, cardAspectRatio } = deck;
  const cardStyles: DeckMeta['cardStyles'] = {};
  for (const pile of deck.piles) for (const c of pile.cards) if (c.style) cardStyles[c.id] = c.style;
  return {
    id, name, description, version, rules, styled: isStyledDeck(deck), cardStyles,
    ...(cardAspectRatio !== undefined ? { aspectRatio: cardAspectRatio } : {}),
    ...(cardStyle ? { cardStyle } : {}),
  };
}
