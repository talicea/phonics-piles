/**
 * Deck schema (version 1) and validation.
 *
 * A deck is plain JSON describing exactly three piles of cards plus a few interaction rules.
 * It is DATA ONLY: nothing in a deck is ever executed or rendered as HTML.
 * The deck system is deliberately independent of the game engine; the engine consumes a validated `Deck`.
 *
 * See docs/DECK_SCHEMA.md for the human-readable description.
 */
import { z } from 'zod';

export const DECK_SCHEMA_VERSION = 1 as const;

/** Hard limits applied to every deck (built-in or uploaded). */
export const DECK_LIMITS = {
  pileCount: 3,
  maxCardsPerPile: 60,
  maxTotalCards: 150,
  maxCardTextLength: 16,
  maxLabelLength: 40,
  maxNameLength: 80,
  maxDescriptionLength: 300,
  maxTags: 10,
  maxCardTags: 8,
  maxTagLength: 32,
  defaultMaxBytes: 100 * 1024,
} as const;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

const idString = (what: string) =>
  z
    .string({ error: `${what} must be a string.` })
    .regex(ID_PATTERN, `${what} must be 1-64 characters: letters, digits, "-" or "_" (and start with a letter or digit).`);

const tagString = z
  .string({ error: 'Tags must be strings.' })
  .min(1, 'Tags must not be empty.')
  .max(DECK_LIMITS.maxTagLength, `Tags must be at most ${DECK_LIMITS.maxTagLength} characters.`)
  .refine((s) => !CONTROL_CHARS.test(s), 'Tags must not contain control characters.');

export const CardSchema = z
  .object({
    id: idString('Card id'),
    // Card text is preserved exactly as supplied (case and inner whitespace untouched).
    text: z
      .string({ error: 'Card text must be a string.' })
      .min(1, 'Card text must not be empty.')
      .max(DECK_LIMITS.maxCardTextLength, `Card text must be at most ${DECK_LIMITS.maxCardTextLength} characters.`)
      .refine((s) => s.trim().length > 0, 'Card text must contain a visible character.')
      .refine((s) => !CONTROL_CHARS.test(s), 'Card text must not contain control characters.'),
    /** Start face-down (only meaningful when rules.allowFlip is true, but harmless otherwise). */
    faceDown: z.boolean({ error: '"faceDown" must be true or false.' }).optional(),
    tags: z.array(tagString).max(DECK_LIMITS.maxCardTags, `A card may have at most ${DECK_LIMITS.maxCardTags} tags.`).optional(),
  })
  .strict();

export const PileSchema = z
  .object({
    id: idString('Pile id'),
    label: z
      .string({ error: 'Pile label must be a string.' })
      .min(1, 'Pile label must not be empty.')
      .max(DECK_LIMITS.maxLabelLength, `Pile label must be at most ${DECK_LIMITS.maxLabelLength} characters.`)
      .refine((s) => s.trim().length > 0 && !CONTROL_CHARS.test(s), 'Pile label must be visible text without control characters.'),
    cards: z
      .array(CardSchema, { error: 'Pile "cards" must be an array.' })
      .min(1, 'Each pile needs at least one card.')
      .max(DECK_LIMITS.maxCardsPerPile, `A pile may have at most ${DECK_LIMITS.maxCardsPerPile} cards.`),
  })
  .strict();

export const RulesSchema = z
  .object({
    /** Cards may be dragged from one pile into another. */
    allowCrossPileMoves: z.boolean().default(true),
    /** Cards may be re-ordered within their own pile. */
    allowReorder: z.boolean().default(true),
    /** Cards may be flipped face-down / face-up. Students do not receive the text of face-down cards. */
    allowFlip: z.boolean().default(false),
    /** Shuffle every pile when the board is first created. */
    initialShuffle: z.boolean().default(false),
  })
  .strict();

export const DeckSchema = z
  .object({
    schemaVersion: z.literal(DECK_SCHEMA_VERSION, { error: `"schemaVersion" must be ${DECK_SCHEMA_VERSION}.` }),
    id: idString('Deck id'),
    name: z
      .string({ error: 'Deck name must be a string.' })
      .min(1, 'Deck name must not be empty.')
      .max(DECK_LIMITS.maxNameLength, `Deck name must be at most ${DECK_LIMITS.maxNameLength} characters.`)
      .refine((s) => s.trim().length > 0 && !CONTROL_CHARS.test(s), 'Deck name must be visible text without control characters.'),
    description: z
      .string({ error: 'Deck description must be a string.' })
      .max(DECK_LIMITS.maxDescriptionLength, `Deck description must be at most ${DECK_LIMITS.maxDescriptionLength} characters.`)
      .default(''),
    version: z
      .string({ error: 'Deck "version" must be a string such as "1.0.0".' })
      .min(1, 'Deck version must not be empty.')
      .max(20, 'Deck version must be at most 20 characters.'),
    piles: z
      .array(PileSchema, { error: '"piles" must be an array.' })
      .length(DECK_LIMITS.pileCount, `A deck must define exactly ${DECK_LIMITS.pileCount} piles (beginning, middle, ending).`),
    rules: RulesSchema.default({ allowCrossPileMoves: true, allowReorder: true, allowFlip: false, initialShuffle: false }),
    tags: z.array(tagString).max(DECK_LIMITS.maxTags, `A deck may have at most ${DECK_LIMITS.maxTags} tags.`).optional(),
  })
  .strict()
  .superRefine((deck, ctx) => {
    const pileIds = new Set<string>();
    const cardIds = new Set<string>();
    let total = 0;
    deck.piles.forEach((pile, pi) => {
      if (pileIds.has(pile.id)) {
        ctx.addIssue({ code: 'custom', path: ['piles', pi, 'id'], message: `Duplicate pile id "${pile.id}". Pile ids must be unique.` });
      }
      pileIds.add(pile.id);
      pile.cards.forEach((card, ci) => {
        total++;
        // Card ids are unique across the WHOLE deck because cards may move between piles.
        if (cardIds.has(card.id)) {
          ctx.addIssue({
            code: 'custom',
            path: ['piles', pi, 'cards', ci, 'id'],
            message: `Duplicate card id "${card.id}". Card ids must be unique across the whole deck (visible text may repeat).`,
          });
        }
        cardIds.add(card.id);
      });
    });
    if (total > DECK_LIMITS.maxTotalCards) {
      ctx.addIssue({ code: 'custom', path: ['piles'], message: `A deck may have at most ${DECK_LIMITS.maxTotalCards} cards in total (found ${total}).` });
    }
  });

export type Deck = z.infer<typeof DeckSchema>;
export type DeckCard = z.infer<typeof CardSchema>;
export type DeckPile = z.infer<typeof PileSchema>;
export type DeckRules = z.infer<typeof RulesSchema>;

/** Light-weight description used in deck lists. */
export interface DeckSummary {
  id: string;
  name: string;
  description: string;
  version: string;
  pileLabels: string[];
  cardCount: number;
  rules: DeckRules;
  tags: string[];
}

export function summarizeDeck(deck: Deck): DeckSummary {
  return {
    id: deck.id,
    name: deck.name,
    description: deck.description,
    version: deck.version,
    pileLabels: deck.piles.map((p) => p.label),
    cardCount: deck.piles.reduce((n, p) => n + p.cards.length, 0),
    rules: deck.rules,
    tags: deck.tags ?? [],
  };
}

export type DeckValidation = { ok: true; deck: Deck } | { ok: false; errors: string[] };

/** Turn a Zod issue path like ['piles', 1, 'cards', 3, 'text'] into `piles[1].cards[3].text` (1-based for humans). */
function formatPath(path: ReadonlyArray<PropertyKey>): string {
  let out = '';
  for (const part of path) {
    if (typeof part === 'number') out += `[${part + 1}]`;
    else out += out ? `.${String(part)}` : String(part);
  }
  return out;
}

export function formatIssues(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string; code?: string; keys?: string[] }>): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const issue of issues) {
    let message = issue.message;
    if (issue.code === 'unrecognized_keys' && issue.keys) {
      message = `Unknown ${issue.keys.length === 1 ? 'property' : 'properties'}: ${issue.keys.map((k) => `"${k}"`).join(', ')}.`;
    }
    const where = formatPath(issue.path);
    const line = where ? `${where}: ${message}` : message;
    if (!seen.has(line)) {
      seen.add(line);
      lines.push(line);
    }
    if (lines.length >= 25) {
      lines.push('…and more problems (fix the ones above first).');
      break;
    }
  }
  return lines;
}

/** Validate an already-parsed value (e.g. a deck received over the socket). */
export function validateDeck(value: unknown): DeckValidation {
  const result = DeckSchema.safeParse(value);
  if (result.success) return { ok: true, deck: result.data };
  return { ok: false, errors: formatIssues(result.error.issues) };
}

/** Parse + validate uploaded JSON text, enforcing a byte-size limit first. */
export function parseDeckJson(text: string, maxBytes: number = DECK_LIMITS.defaultMaxBytes): DeckValidation {
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > maxBytes) {
    return { ok: false, errors: [`File is too large (${(bytes / 1024).toFixed(1)} KB). The limit is ${(maxBytes / 1024).toFixed(0)} KB.`] };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'unknown error';
    return { ok: false, errors: [`This is not valid JSON (${detail}).`] };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, errors: ['The top level of a deck file must be a JSON object.'] };
  }
  return validateDeck(value);
}
