import { describe, expect, it } from 'vitest';
import { buildDeckMeta, isStyledDeck, resolveCardStyle, validateDeck, CardStyleSchema } from '@shared/index';

const base = () => ({
  schemaVersion: 1, id: 'styled', name: 'Styled', version: '1',
  piles: [
    { id: 'a', label: 'A', cards: [{ id: 'a1', text: 'sh', style: { textColor: '#990000', corners: { topLeft: { text: '2', color: '#990000' } } } }, { id: 'a2', text: 't' }] },
    { id: 'b', label: 'B', cards: [{ id: 'b1', text: 'a' }] },
    { id: 'c', label: 'C', cards: [{ id: 'c1', text: 'ck' }] },
  ],
  cardStyle: { fontId: 'playwrite-co', textColor: '#000', outlineWidth: 0.017 },
  cardAspectRatio: 0.6662,
});

describe('card formatting schema', () => {
  it('accepts a formatted deck and still accepts decks without formatting', () => {
    const r = validateDeck(base());
    expect(r.ok).toBe(true);
    const plain = base() as Record<string, unknown>;
    delete plain.cardStyle; delete plain.cardAspectRatio;
    (plain.piles as { cards: { style?: unknown }[] }[])[0]!.cards[0]!.style = undefined;
    const p = validateDeck(plain);
    expect(p.ok && isStyledDeck(p.deck)).toBe(false);
    expect(r.ok && isStyledDeck(r.deck)).toBe(true);
  });

  it('rejects anything that could smuggle CSS or markup into a style', () => {
    const attempts: unknown[] = [
      { textColor: 'red' }, { textColor: 'red; background:url(//evil)' }, { textColor: 'url(javascript:alert(1))' }, { textColor: '#12' },
      { textColor: '#gggggg' }, { background: 'expression(alert(1))' }, { fontId: 'Comic Sans; x:y' }, { fontId: 'arial' },
      { corners: { topLeft: { text: '<img src=x onerror=1>1234567' } } }, { corners: { topLeft: { text: '' } } }, { corners: { middle: { text: '1' } } },
      { fontWeight: 1000 }, { fontWeight: 400.5 }, { fontSize: 5 }, { outlineWidth: -1 }, { borderWidth: 2 }, { cornerRadius: 0.9 }, { glyphY: 'center' }, { unknownKey: 1 },
    ];
    for (const style of attempts) {
      expect(CardStyleSchema.safeParse(style).success, JSON.stringify(style)).toBe(false);
      const d = base(); (d.piles[0]!.cards[1] as { style?: unknown }).style = style;
      expect(validateDeck(d).ok, JSON.stringify(style)).toBe(false);
    }
    const d = base(); (d as Record<string, unknown>).cardAspectRatio = 9;
    expect(validateDeck(d).ok).toBe(false);
  });

  it('names the exact place of a formatting error', () => {
    const d = base(); (d.piles[1]!.cards[0] as { style?: unknown }).style = { textColor: 'blue' };
    const r = validateDeck(d);
    expect(!r.ok && r.errors[0]).toMatch(/^piles\[2\]\.cards\[1\]\.style\.textColor: Colours must be hex/);
  });

  it('merges renderer defaults < deck style < card style', () => {
    const d = base(); const r = validateDeck(d); if (!r.ok) throw new Error();
    const plain = resolveCardStyle(r.deck.cardStyle, r.deck.piles[0]!.cards[1]!.style);
    const red = resolveCardStyle(r.deck.cardStyle, r.deck.piles[0]!.cards[0]!.style);
    expect(plain.textColor).toBe('#000'); expect(red.textColor).toBe('#990000');
    expect(plain.fontId).toBe('playwrite-co'); expect(plain.fontWeight).toBe(400); // playwrite default weight
    expect(plain.background).toBe('#ffffff'); // untouched renderer default
    expect(red.corners.topLeft?.text).toBe('2'); expect(plain.corners.topLeft).toBeUndefined();
    expect(resolveCardStyle(undefined, undefined).fontId).toBe('default');
  });

  it('builds client metadata with only the per-card overrides', () => {
    const r = validateDeck(base()); if (!r.ok) throw new Error();
    const m = buildDeckMeta(r.deck);
    expect(m.styled).toBe(true); expect(m.aspectRatio).toBe(0.6662);
    expect(Object.keys(m.cardStyles)).toEqual(['a1']);
    expect(m.cardStyle?.fontId).toBe('playwrite-co');
  });
});
