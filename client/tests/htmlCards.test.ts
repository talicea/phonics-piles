import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseHTML } from 'linkedom';
import { DECK_LIMITS, parseDeckJson } from '@shared/index';
import { buildDecks, colorGroups, formatLessons, normalizeHex, parseCardsHtml, suggestPlacements, type ParsedFile } from '../src/import/htmlCards';

const parse = (html: string, name: string) => parseCardsHtml(parseHTML(html).document as unknown as Document, name);
const fixture = (n: number) => parse(fs.readFileSync(path.resolve(import.meta.dirname, `fixtures/skills_${n}.html`), 'utf8'), `skills_${n}.html`);
const LABELS: [string, string, string] = ['Beginning sound', 'Middle sound', 'Ending sound'];

const card = (inner: string, extra = '') => `<section class="card"><svg viewBox="0 0 896 1345"><rect x="1" y="1" width="894" height="1343" rx="58.24" fill="#fff" stroke="#666" stroke-width="2"/>${extra}<text class="glyph" x="448" y="721" text-anchor="middle" font-family="PlaywriteCO, cursive" font-weight="400" font-size="592" fill="#990000" stroke="#990000" stroke-width="10.064">${inner}</text></svg></section>`;

describe('parsing the real card sheets', () => {
  it('reads cards, text, lesson and every formatting detail from skills_1', () => {
    const f = fixture(1);
    expect(f.cards.map((c) => c.text)).toEqual(['a', 't', 's', 'm', 'b', 'c', 'f']);
    expect(f.lesson).toBe(1);
    expect(f.warnings).toEqual([]);
    const a = f.cards[0]!; const t = f.cards[1]!;
    expect(a.style).toMatchObject({ fontId: 'playwrite-co', fontWeight: 400, textColor: '#990000', outlineWidth: 0.017, background: '#ffffff', borderColor: '#666666', cornerRadius: 0.065 });
    expect(a.style.outlineColor).toBeUndefined(); // same as the text colour
    expect(a.style.fontSize).toBeCloseTo(0.44015, 4); expect(a.style.glyphY).toBeCloseTo(0.53606, 4);
    expect(a.style.corners?.topLeft).toMatchObject({ text: '2', color: '#990000', fontId: 'serif' });
    expect(a.style.corners?.bottomRight).toMatchObject({ text: '1', color: '#555555' });
    expect(t.style.textColor).toBe('#000000'); expect(t.style.corners?.topLeft).toBeUndefined();
    expect(a.aspect).toBeCloseTo(896 / 1345, 4);
  });

  it('reads the navy digraph cards and detects the lesson number', () => {
    const f5 = fixture(5); const f8 = fixture(8);
    expect(f5.cards.map((c) => [c.text, c.style.textColor])).toEqual([['k', '#000000'], ['ck', '#0b1a6b']]);
    expect(f5.lesson).toBe(5); expect(f8.lesson).toBe(8);
    expect(f8.cards.map((c) => c.text)).toEqual(['ff', 'll', 'ss', 'zz']);
  });
});

describe('robustness', () => {
  it('normalises colours', () => {
    expect(normalizeHex('#FFF')).toBe('#ffffff'); expect(normalizeHex('#0B1A6B')).toBe('#0b1a6b');
    for (const bad of ['red', 'rgb(1,2,3)', 'none', '', null, undefined, '#12345']) expect(normalizeHex(bad)).toBeNull();
  });

  it('warns about things it cannot carry over instead of dropping them silently', () => {
    const f = parse(`<html><body>${card('x', '<line class="rule" x1="0" y1="1" x2="9" y2="1" stroke="#000"/><circle r="3"/>').replace('PlaywriteCO, cursive', 'Comic Sans')}</body></html>`, 'weird_3.html');
    expect(f.cards).toHaveLength(1);
    expect(f.warnings.join('\n')).toMatch(/Font "Comic Sans" is not bundled/);
    expect(f.warnings.join('\n')).toMatch(/<line> element .* left out/);
    expect(f.warnings.join('\n')).toMatch(/<circle>/);
    expect(f.lesson).toBe(3); // from the file name
  });

  it('skips broken cards with a message and handles empty files', () => {
    const f = parse('<html><body><section class="card"><svg viewBox="bad"></svg></section><section class="card"><svg viewBox="0 0 10 10"></svg></section></body></html>', 'x.html');
    expect(f.cards).toEqual([]);
    expect(f.warnings.join('\n')).toMatch(/invalid viewBox/); expect(f.warnings.join('\n')).toMatch(/No cards were found/);
    expect(parse('<html></html>', 'empty.html').cards).toEqual([]);
  });

  it('treats the file strictly as data: scripts inside it are never run, markup in text stays text', () => {
    (globalThis as Record<string, unknown>).__pwned = false;
    const html = `<html><head><script>globalThis.__pwned = true</script></head><body>${card('&lt;b&gt;x')}<img src=x onerror="globalThis.__pwned=true"></body></html>`;
    const f = parse(html, 'evil.html');
    expect((globalThis as Record<string, unknown>).__pwned).toBe(false);
    expect(f.cards[0]!.text).toBe('<b>x');
  });
});

describe('building decks', () => {
  const files = () => [fixture(1), fixture(5), fixture(8)];

  it('suggests piles from the cards: red vowels with a "2" mark → Middle, navy endings → Ending only, others → Beginning + Ending', () => {
    const sug = suggestPlacements(files());
    expect(sug).toEqual({ '#990000': 'm', '#000000': 'be', '#0b1a6b': 'e' });
    expect(colorGroups(files()).map((g) => g.color).sort()).toEqual(['#000000', '#0b1a6b', '#990000']);
  });

  it('makes cumulative decks that all validate, with unique ids and no repeated formatting', () => {
    const fs_ = files();
    const { decks, skipped } = buildDecks(fs_, { pileLabels: LABELS, placement: suggestPlacements(fs_), cumulative: true });
    expect(skipped).toEqual([]);
    expect(decks.map((d) => d.name)).toEqual(['Skills · lesson 1', 'Skills · lessons 1, 5', 'Skills · lessons 1, 5, 8']);
    const last = decks[2]!;
    expect(last.piles.map((p) => p.cards.map((c) => c.text).join(' '))).toEqual(['t s m b c f k', 'a', 't s m b c f k ck ff ll ss zz']);
    const ids = last.piles.flatMap((p) => p.cards.map((c) => c.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(last.cardStyle).toMatchObject({ fontId: 'playwrite-co', textColor: '#000000', outlineWidth: 0.017 });
    expect(last.cardAspectRatio).toBeCloseTo(0.66617, 4);
    const vowel = last.piles[1]!.cards[0]!;
    expect(vowel.style?.textColor).toBe('#990000');                       // only the difference is stored
    expect(vowel.style?.fontId).toBeUndefined();
    expect(vowel.style?.corners?.topLeft?.text).toBe('2');
    expect(vowel.tags).toEqual(['lesson-1']);
    for (const d of decks) {
      const json = JSON.stringify(d, null, 2);
      expect(json.length).toBeLessThan(DECK_LIMITS.defaultMaxBytes);
      expect(parseDeckJson(json).ok).toBe(true); // survives being saved and uploaded again
    }
  });

  it('can make a single combined deck, and respects a teacher\'s pile choices', () => {
    const fs_ = files();
    const placement = { ...suggestPlacements(fs_), '#000000': 'b' as const, '#0b1a6b': 'bme' as const };
    const { decks } = buildDecks(fs_, { pileLabels: ['One', 'Two', 'Three'], placement, cumulative: false });
    expect(decks).toHaveLength(1);
    expect(decks[0]!.piles.map((p) => p.label)).toEqual(['One', 'Two', 'Three']);
    expect(decks[0]!.piles[0]!.cards.map((c) => c.text)).toEqual(['t', 's', 'm', 'b', 'c', 'f', 'k', 'ck', 'ff', 'll', 'ss', 'zz']);
    expect(decks[0]!.piles[1]!.cards.map((c) => c.id)).toEqual(['middle-a', 'middle-ck', 'middle-ff', 'middle-ll', 'middle-ss', 'middle-zz']);
  });

  it('explains why a deck cannot be made (empty pile) instead of failing silently', () => {
    const fs_ = files();
    const { decks, skipped } = buildDecks(fs_, { pileLabels: LABELS, placement: { ...suggestPlacements(fs_), '#990000': 'skip' }, cumulative: true });
    expect(decks).toEqual([]);
    expect(skipped).toHaveLength(3);
    expect(skipped[0]!.reasons.join(' ')).toMatch(/Each pile needs at least one card.*nothing was assigned/);
  });

  it('gives every card a unique id even for duplicate text across lessons', () => {
    const a = fixture(1); const b: ParsedFile = { ...fixture(1), fileName: 'skills_2.html', lesson: 2 };
    b.cards = b.cards.map((c) => ({ ...c, lesson: 2 }));
    const { decks } = buildDecks([a, b], { pileLabels: LABELS, placement: suggestPlacements([a]), cumulative: false });
    const ids = decks[0]!.piles.flatMap((p) => p.cards.map((c) => c.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('beginning-t-2');
  });

  it('formats lesson lists', () => {
    expect(formatLessons([1, 2, 3, 4, 5, 7, 8])).toBe('1–5, 7–8'); expect(formatLessons([3])).toBe('3'); expect(formatLessons([5, 1, 5])).toBe('1, 5');
  });
});
