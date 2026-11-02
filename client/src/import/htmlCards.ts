/**
 * Import printable card sheets (HTML files containing one <svg> per card, e.g. "skills_1.html") as Phonics Piles decks.
 *
 * Works on a standard DOM `Document`, so the same code runs in the browser (DOMParser) and in tests / scripts (linkedom).
 * The HTML is only ever READ as data: scripts in the file are never run (DOMParser documents are inert), and nothing is injected.
 *
 * What is captured per card: the text, its colour/outline, font (mapped to a bundled font id), weight and size, baseline position,
 * background, border (colour, width, rounding), corner marks (text, colour, size), card shape (aspect ratio) and lesson number.
 * Anything it cannot carry over is reported as a warning instead of being dropped silently.
 */
import { CARD_GEOMETRY, DECK_LIMITS, validateDeck, type CardStyle, type Corner, type CornerName, type Deck, type DeckCard, type FontId } from '@shared/index';

export interface ParsedCard {
  text: string;
  lesson: number | null;
  /** Complete style as read from the file (before deck-wide defaults are factored out). */
  style: CardStyle;
  aspect: number;
  fileName: string;
}
export interface ParsedFile {
  fileName: string;
  title: string;
  lesson: number | null;
  cards: ParsedCard[];
  warnings: string[];
}

const r5 = (n: number) => Math.round(n * 1e5) / 1e5;
const num = (v: string | null | undefined): number | null => {
  if (v === null || v === undefined) return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

/** '#fff' / '#FF0000' → '#ffffff' / '#ff0000'. Anything else (named colours, rgb(), none) → null. */
export function normalizeHex(c: string | null | undefined): string | null {
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec((c ?? '').trim());
  if (!m) return null;
  let h = (m[1] as string).toLowerCase();
  if (h.length === 3) h = h.split('').map((x) => x + x).join('');
  return `#${h}`;
}

function fontIdFor(family: string | null): FontId | null {
  const f = (family ?? '').toLowerCase();
  if (f.includes('playwrite')) return 'playwrite-co';
  if (f.includes('times') || f.includes('serif')) return f.includes('sans') ? 'default' : 'serif';
  return null;
}

const KNOWN_TAGS = new Set(['svg', 'rect', 'g', 'text']);

export function parseCardsHtml(doc: Document, fileName: string): ParsedFile {
  const warnings: string[] = [];
  const title = (doc.querySelector('title')?.textContent ?? '').trim() || fileName.replace(/\.[^.]+$/, '');
  const sections = Array.from(doc.querySelectorAll('section.card'));
  const svgs = sections.length ? sections.map((s) => s.querySelector('svg')) : Array.from(doc.querySelectorAll('svg'));
  const cards: ParsedCard[] = [];
  const ignored = new Map<string, number>();
  const note = (msg: string) => { if (!warnings.includes(msg)) warnings.push(msg); };

  svgs.forEach((svg, idx) => {
    const n = idx + 1;
    if (!svg) { note(`Card ${n}: no drawing found; skipped.`); return; }
    const vb = (svg.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
    const [, , W, H] = vb;
    if (vb.length !== 4 || !W || !H || !Number.isFinite(W) || !Number.isFinite(H)) { note(`Card ${n}: missing or invalid viewBox; skipped.`); return; }

    const texts = Array.from(svg.querySelectorAll('text'));
    const glyphEl = svg.querySelector('text.glyph') ?? [...texts].sort((a, b) => (num(b.getAttribute('font-size')) ?? 0) - (num(a.getAttribute('font-size')) ?? 0))[0];
    const glyphText = (glyphEl?.textContent ?? '').trim();
    if (!glyphEl || !glyphText) { note(`Card ${n}: no main text found; skipped.`); return; }

    // anything we do not understand is counted and reported
    for (const el of Array.from(svg.querySelectorAll('*'))) {
      const tag = el.tagName.toLowerCase();
      if (!KNOWN_TAGS.has(tag)) ignored.set(tag, (ignored.get(tag) ?? 0) + 1);
    }
    const rects = Array.from(svg.querySelectorAll('rect'));
    if (rects.length > 1) ignored.set('rect (extra)', (ignored.get('rect (extra)') ?? 0) + rects.length - 1);
    const border = rects[0];

    // ---- main text
    const style: CardStyle = {};
    const fam = glyphEl.getAttribute('font-family');
    const fontId = fontIdFor(fam);
    if (fontId) style.fontId = fontId;
    else if (fam) note(`Font "${fam}" is not bundled with the app; the default font is used instead.`);
    const weight = num(glyphEl.getAttribute('font-weight'));
    if (weight !== null) style.fontWeight = Math.min(900, Math.max(100, Math.round(weight)));
    const fs = num(glyphEl.getAttribute('font-size'));
    if (fs !== null) style.fontSize = r5(fs / H);
    const gy = num(glyphEl.getAttribute('y'));
    if (gy !== null) style.glyphY = r5(gy / H);
    const fill = normalizeHex(glyphEl.getAttribute('fill'));
    if (fill) style.textColor = fill;
    else if (glyphEl.getAttribute('fill')) note(`Text colour "${glyphEl.getAttribute('fill')}" is not a hex colour; black is used instead.`);
    const stroke = normalizeHex(glyphEl.getAttribute('stroke'));
    if (stroke && stroke !== fill) style.outlineColor = stroke;
    const sw = num(glyphEl.getAttribute('stroke-width'));
    style.outlineWidth = stroke && sw !== null && fs ? r5(sw / fs) : 0;

    // ---- card face
    if (border) {
      const bg = normalizeHex(border.getAttribute('fill'));
      if (bg) style.background = bg;
      const bc = normalizeHex(border.getAttribute('stroke'));
      if (bc) style.borderColor = bc;
      const bw = num(border.getAttribute('stroke-width'));
      if (bw !== null) style.borderWidth = Math.min(0.05, r5(bw / W));
      const rx = num(border.getAttribute('rx'));
      if (rx !== null) style.cornerRadius = Math.min(0.5, r5(rx / W));
    }

    // ---- corner marks: every other text element
    const corners: Partial<Record<CornerName, Corner>> = {};
    let lesson: number | null = null;
    for (const t of texts) {
      if (t === glyphEl) continue;
      const text = (t.textContent ?? '').trim();
      if (!text) continue;
      const x = num(t.getAttribute('x')) ?? 0;
      const y = num(t.getAttribute('y')) ?? 0;
      const right = t.getAttribute('text-anchor') === 'end' || (t.getAttribute('text-anchor') !== 'start' && x > W / 2);
      const bottom = y > H / 2;
      const name: CornerName = `${bottom ? 'bottom' : 'top'}${right ? 'Right' : 'Left'}`;
      if (corners[name]) { note(`Card ${n}: more than one text in the ${name} corner; only the first is kept.`); continue; }
      const corner: Corner = { text: text.slice(0, 6) };
      if (text.length > 6) note(`Card ${n}: corner text "${text}" was cut to 6 characters.`);
      const c = normalizeHex(t.getAttribute('fill'));
      if (c) corner.color = c;
      const cf = fontIdFor(t.getAttribute('font-family'));
      if (cf) corner.fontId = cf;
      const cs = num(t.getAttribute('font-size'));
      if (cs !== null) corner.size = Math.min(0.2, Math.max(0.02, r5(cs / H)));
      corners[name] = corner;
      if (name === 'bottomRight' && /^\d{1,3}$/.test(text)) lesson = parseInt(text, 10);
    }
    if (Object.keys(corners).length) style.corners = corners;

    cards.push({ text: glyphText, lesson, style, aspect: r5(W / H), fileName });
  });

  for (const [tag, count] of ignored) note(`${count} <${tag}> element${count === 1 ? '' : 's'} (for example writing lines) can't be imported and ${count === 1 ? 'was' : 'were'} left out.`);

  // file-level lesson: most common card number, else a number in the file name or title
  const counts = new Map<number, number>();
  for (const c of cards) if (c.lesson !== null) counts.set(c.lesson, (counts.get(c.lesson) ?? 0) + 1);
  let lesson: number | null = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  if (lesson === null) {
    const m = /(\d{1,3})(?!.*\d)/.exec(fileName.replace(/\.[^.]+$/, '')) ?? /(\d{1,3})(?!.*\d)/.exec(title);
    if (m) lesson = parseInt(m[1] as string, 10);
  }
  for (const c of cards) c.lesson = lesson;
  if (cards.length === 0) warnings.push('No cards were found in this file.');
  return { fileName, title, lesson, cards, warnings };
}

// ------------------------------------------------------------------------------------------------ building decks
export type Placement = 'be' | 'b' | 'm' | 'e' | 'bme' | 'skip';
export const PLACEMENT_LABELS: Record<Placement, string> = {
  be: 'Beginning + Ending piles',
  b: 'Beginning pile only',
  m: 'Middle pile only',
  e: 'Ending pile only',
  bme: 'All three piles',
  skip: 'Leave these cards out',
};
const PILE_IDS = ['beginning', 'middle', 'ending'] as const;
const PLACEMENT_PILES: Record<Exclude<Placement, 'skip'>, number[]> = { be: [0, 2], b: [0], m: [1], e: [2], bme: [0, 1, 2] };

export interface ColorGroup { color: string; texts: string[] }

export const cardColor = (c: ParsedCard): string => c.style.textColor ?? '#000000';

export function colorGroups(files: ParsedFile[]): ColorGroup[] {
  const groups = new Map<string, string[]>();
  for (const f of files) for (const c of f.cards) {
    const k = cardColor(c);
    const list = groups.get(k) ?? [];
    if (!list.includes(c.text)) list.push(c.text);
    groups.set(k, list);
  }
  return [...groups.entries()].map(([color, texts]) => ({ color, texts }));
}

/** Spellings that normally only END a word. Used only to suggest a default; the teacher can change it. */
const ENDING_ONLY = new Set(['ck', 'ff', 'll', 'ss', 'zz', 'tch', 'dge', 'ng', 'nk']);

/** A starting guess for each colour group. It is shown to the teacher to review, never applied silently. */
export function suggestPlacements(files: ParsedFile[]): Record<string, Placement> {
  const out: Record<string, Placement> = {};
  for (const g of colorGroups(files)) {
    const cards = files.flatMap((f) => f.cards).filter((c) => cardColor(c) === g.color);
    const marks = new Set(cards.map((c) => c.style.corners?.topLeft?.text));
    const mark = marks.size === 1 ? [...marks][0] : undefined; // e.g. every red card has a "2" in the top-left corner
    if (mark === '1') out[g.color] = 'b';
    else if (mark === '2') out[g.color] = 'm';
    else if (mark === '3') out[g.color] = 'e';
    else if (g.texts.every((t) => ENDING_ONLY.has(t.toLowerCase()))) out[g.color] = 'e';
    else out[g.color] = 'be';
  }
  return out;
}

export interface BuildOptions {
  pileLabels: [string, string, string];
  placement: Record<string, Placement>;
  /** One deck per lesson containing that lesson and every earlier one, instead of a single deck with everything. */
  cumulative: boolean;
}
export interface BuildResult { decks: Deck[]; skipped: { name: string; reasons: string[] }[]; notes: string[] }

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const idPart = (text: string) => Array.from(text).map((ch) => (/[a-z0-9]/.test(ch) ? ch : /[A-Z]/.test(ch) ? ch.toLowerCase() : `u${ch.codePointAt(0)!.toString(16)}`)).join('');

export function formatLessons(nums: number[]): string {
  const s = [...new Set(nums)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < s.length;) {
    let j = i;
    while (j + 1 < s.length && (s[j + 1] as number) === (s[j] as number) + 1) j++;
    parts.push(j > i ? `${s[i]}–${s[j]}` : `${s[i]}`);
    i = j + 1;
  }
  return parts.join(', ');
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const mode = <T,>(values: T[]): T | undefined => {
  const m = new Map<string, { v: T; n: number }>();
  for (const v of values) { const k = JSON.stringify(v); const e = m.get(k); if (e) e.n++; else m.set(k, { v, n: 1 }); }
  return [...m.values()].sort((a, b) => b.n - a.n)[0]?.v;
};

export function buildDecks(files: ParsedFile[], opts: BuildOptions): BuildResult {
  const notes: string[] = [];
  const all = files.flatMap((f, fi) => f.cards.map((c, ci) => ({ card: c, order: fi * 1000 + ci, lesson: c.lesson ?? fi + 1 })));
  if (all.length === 0) return { decks: [], skipped: [], notes: ['There are no cards to import.'] };
  all.sort((a, b) => a.lesson - b.lesson || a.order - b.order);

  // ---- deck-wide defaults: the most common value of each field, so per-card styles only hold differences
  const fields = ['fontId', 'fontWeight', 'fontSize', 'glyphY', 'textColor', 'outlineColor', 'outlineWidth', 'background', 'borderColor', 'borderWidth', 'cornerRadius'] as const;
  const cardStyle: CardStyle = {};
  for (const f of fields) {
    const v = mode(all.filter((x) => x.card.style[f] !== undefined).map((x) => x.card.style[f]));
    if (v !== undefined) (cardStyle as Record<string, unknown>)[f] = v;
  }
  const aspect = mode(all.map((x) => x.card.aspect));
  const diff = (s: CardStyle): CardStyle | undefined => {
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      const v = s[f];
      if (v !== undefined && !same(v, (cardStyle as Record<string, unknown>)[f])) out[f] = v;
    }
    // a card with no outline colour of its own, inside a deck whose default has one, must say "same as text" explicitly
    if (s.outlineColor === undefined && cardStyle.outlineColor !== undefined) out.outlineColor = s.textColor ?? cardStyle.textColor ?? '#000000';
    if (s.corners && Object.keys(s.corners).length) out.corners = s.corners;
    return Object.keys(out).length ? (out as CardStyle) : undefined;
  };

  const prefixRaw = (files[0]?.title ?? 'Imported').replace(/[\s_-]*\d+\s*$/, '').trim() || 'Imported';
  const prefix = prefixRaw.charAt(0).toUpperCase() + prefixRaw.slice(1);
  const idPrefix = slug(prefixRaw) || 'imported';
  const lessons = [...new Set(all.map((x) => x.lesson))].sort((a, b) => a - b);
  const sets = opts.cumulative ? lessons.map((_, i) => lessons.slice(0, i + 1)) : [lessons];

  const decks: Deck[] = [];
  const skipped: BuildResult['skipped'] = [];
  const sources = files.map((f) => f.fileName).join(', ');

  for (const set of sets) {
    const upto = set[set.length - 1] as number;
    const name = `${prefix} · lesson${set.length > 1 ? 's' : ''} ${formatLessons(set)}`.slice(0, DECK_LIMITS.maxNameLength);
    const used = new Map<string, number>();
    const piles: { id: string; label: string; cards: DeckCard[] }[] = PILE_IDS.map((id, i) => ({ id, label: opts.pileLabels[i] as string, cards: [] }));
    for (const x of all) {
      if (!set.includes(x.lesson)) continue;
      const placement = opts.placement[cardColor(x.card)] ?? 'be';
      if (placement === 'skip') continue;
      for (const pi of PLACEMENT_PILES[placement]) {
        const base = `${PILE_IDS[pi]}-${idPart(x.card.text)}`;
        const k = (used.get(base) ?? 0) + 1;
        used.set(base, k);
        const st = diff(x.card.style);
        piles[pi]!.cards.push({ id: k === 1 ? base : `${base}-${k}`, text: x.card.text, tags: [`lesson-${x.lesson}`], ...(st ? { style: st } : {}) });
      }
    }
    const deckId = `${idPrefix}-${opts.cumulative ? `upto-${upto}` : 'all'}`.slice(0, 64);
    const candidate = {
      schemaVersion: 1, id: deckId, name,
      description: `Imported from ${sources}. Cards were placed in piles by colour; please check them before class.`.slice(0, DECK_LIMITS.maxDescriptionLength),
      version: '1.0.0',
      piles,
      rules: { allowCrossPileMoves: true, allowReorder: true, allowFlip: false, initialShuffle: false },
      tags: ['imported'],
      cardStyle,
      ...(aspect !== undefined ? { cardAspectRatio: aspect } : {}),
    };
    const v = validateDeck(candidate);
    if (v.ok) decks.push(v.deck);
    else skipped.push({ name, reasons: v.errors.map((e) => (/Each pile needs at least one card/.test(e) ? `${e} (nothing was assigned to that pile)` : e)) });
  }
  if (sets.length > 1 && decks.length) notes.push(`Each deck includes its lesson and all earlier lessons (so lesson ${lessons[1] ?? ''} also has lesson ${lessons[0]}'s cards).`.replace(' (so lesson  also has lesson', ' (so later decks also have'));
  return { decks, skipped, notes };
}
