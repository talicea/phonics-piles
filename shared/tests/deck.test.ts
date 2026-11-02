import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DECK_LIMITS, parseDeckJson, validateDeck, sanitizeDisplayName, normalizeRoomCode } from '@shared/index';

const minimal = () => ({
  schemaVersion: 1, id: 'test-deck', name: 'Test', version: '1.0.0',
  piles: [
    { id: 'a', label: 'A', cards: [{ id: 'a1', text: 'sh' }, { id: 'a2', text: 'sh' }] },
    { id: 'b', label: 'B', cards: [{ id: 'b1', text: 'a' }] },
    { id: 'c', label: 'C', cards: [{ id: 'c1', text: 'ck' }] },
  ],
});

describe('deck validation (requirement 11)', () => {
  it('accepts a minimal deck and fills in defaults', () => {
    const r = validateDeck(minimal());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.deck.rules).toEqual({ allowCrossPileMoves: true, allowReorder: true, allowFlip: false, initialShuffle: false });
      expect(r.deck.description).toBe('');
    }
  });

  it('accepts every built-in deck on disk', () => {
    const dir = path.resolve(process.cwd(), 'decks');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const f of files) {
      const r = parseDeckJson(fs.readFileSync(path.join(dir, f), 'utf8'));
      expect(r.ok, `${f}: ${r.ok ? '' : r.errors.join('; ')}`).toBe(true);
    }
    expect(parseDeckJson(fs.readFileSync(path.resolve('client/public/sample-deck.json'), 'utf8')).ok).toBe(true);
  });

  it('rejects invalid JSON with a clear message', () => {
    const r = parseDeckJson('{ not json');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/not valid JSON/);
  });

  it('rejects non-object top levels', () => {
    for (const text of ['[]', '42', 'null', '"x"']) expect(parseDeckJson(text).ok).toBe(false);
  });

  it('rejects files over the size limit before parsing', () => {
    const r = parseDeckJson(JSON.stringify(minimal()), 50);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/too large/);
  });

  it('rejects missing required properties', () => {
    const d: Record<string, unknown> = minimal();
    delete d.name;
    delete d.piles;
    const r = validateDeck(d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join('\n')).toMatch(/name|piles/);
  });

  it('requires exactly three piles', () => {
    const d = minimal();
    d.piles.pop();
    expect(validateDeck(d).ok).toBe(false);
  });

  it('rejects duplicate pile ids', () => {
    const d = minimal();
    d.piles[1]!.id = 'a';
    const r = validateDeck(d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join('\n')).toMatch(/Duplicate pile id "a"/);
  });

  it('rejects duplicate card ids (even across piles) but allows duplicate visible text', () => {
    const d = minimal();
    d.piles[2]!.cards[0]!.id = 'a1';
    const r = validateDeck(d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join('\n')).toMatch(/Duplicate card id "a1"/);
    expect(validateDeck(minimal()).ok).toBe(true); // two "sh" cards with different ids
  });

  it('rejects empty, whitespace-only, over-long and control-character card text', () => {
    for (const text of ['', '   ', 'x'.repeat(DECK_LIMITS.maxCardTextLength + 1), 'a\u0000b', 'a\nb', 123 as unknown as string]) {
      const d = minimal();
      d.piles[0]!.cards[0]!.text = text;
      expect(validateDeck(d).ok, JSON.stringify(text)).toBe(false);
    }
  });

  it('preserves capitalisation and spacing of card text exactly', () => {
    const d = minimal();
    d.piles[0]!.cards[0]!.text = 'Sh';
    d.piles[0]!.cards[1]!.text = ' a b';
    const r = validateDeck(d);
    expect(r.ok && r.deck.piles[0]!.cards.map((c) => c.text)).toEqual(['Sh', ' a b']);
  });

  it('rejects bad ids, unsupported rule values and unknown properties', () => {
    const bad1 = minimal(); bad1.id = 'has spaces!';
    expect(validateDeck(bad1).ok).toBe(false);
    const bad2 = { ...minimal(), rules: { allowFlip: 'yes' } };
    expect(validateDeck(bad2).ok).toBe(false);
    const bad3 = { ...minimal(), rules: { runScript: true } };
    expect(validateDeck(bad3).ok).toBe(false);
    const bad4 = { ...minimal(), onLoad: 'alert(1)' };
    const r = validateDeck(bad4);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join('\n')).toMatch(/Unknown property: "onLoad"/);
    const bad5 = { ...minimal(), schemaVersion: 2 };
    expect(validateDeck(bad5).ok).toBe(false);
  });

  it('enforces card count limits', () => {
    const d = minimal();
    d.piles[0]!.cards = Array.from({ length: DECK_LIMITS.maxCardsPerPile + 1 }, (_, i) => ({ id: `x${i}`, text: 'a' }));
    expect(validateDeck(d).ok).toBe(false);
    d.piles[0]!.cards = [];
    expect(validateDeck(d).ok).toBe(false);
  });

  it('treats markup as inert text (it is stored verbatim; React escapes it when rendered)', () => {
    const d = minimal();
    d.piles[0]!.cards[0]!.text = '<b>x</b>';
    const r = validateDeck(d);
    expect(r.ok && r.deck.piles[0]!.cards[0]!.text).toBe('<b>x</b>');
  });
});

describe('input helpers', () => {
  it('sanitises display names', () => {
    expect(sanitizeDisplayName('  Sam \n  Lee ')).toBe('Sam Lee');
    expect(sanitizeDisplayName('x'.repeat(100)).length).toBe(24);
    expect(sanitizeDisplayName(undefined)).toBe('');
    expect(sanitizeDisplayName('\u0000\u0007')).toBe('');
  });
  it('normalises room codes', () => {
    expect(normalizeRoomCode(' ab-c 2 ')).toBe('ABC2');
  });
});
