/**
 * Draws the face of a card.
 *  - Plain decks (no formatting): the text in a tile, as before.
 *  - Designed decks: an SVG drawn from the deck's card formatting (font, colours, outline, border, corner marks, shape),
 *    using the same geometry as the original printable cards. All values come from validated deck data.
 */
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CARD_GEOMETRY, CORNER_NAMES, DEFAULT_ASPECT_RATIO, FONT_STACKS, resolveCardStyle, type CornerName, type DeckMeta, type FontId } from '@shared/index';

const fontReady = new Map<FontId, Promise<void>>();
function loadFont(fontId: FontId, weight: number): Promise<void> {
  if (fontId !== 'playwrite-co' || !document.fonts) return Promise.resolve();
  const key = fontId;
  if (!fontReady.has(key)) fontReady.set(key, document.fonts.load(`${weight} 100px PlaywriteCO`).then(() => document.fonts.ready).then(() => undefined).catch(() => undefined));
  return fontReady.get(key) as Promise<void>;
}
const scaleCache = new Map<string, number>();

const CORNER_POS: Record<CornerName, { x: number; y: number; anchor: 'start' | 'end'; bottom: boolean }> = {
  topLeft: { x: CARD_GEOMETRY.cornerInsetX, y: CARD_GEOMETRY.cornerTopBaseline, anchor: 'start', bottom: false },
  topRight: { x: 1 - CARD_GEOMETRY.cornerInsetX, y: CARD_GEOMETRY.cornerTopBaseline, anchor: 'end', bottom: false },
  bottomLeft: { x: CARD_GEOMETRY.cornerInsetX, y: CARD_GEOMETRY.cornerBottomBaseline, anchor: 'start', bottom: true },
  bottomRight: { x: 1 - CARD_GEOMETRY.cornerInsetX, y: CARD_GEOMETRY.cornerBottomBaseline, anchor: 'end', bottom: true },
};

function StyledFace({ text, deck, cardId }: { text: string; deck: DeckMeta; cardId: string }) {
  const st = resolveCardStyle(deck.cardStyle, deck.cardStyles[cardId]);
  const aspect = deck.aspectRatio ?? DEFAULT_ASPECT_RATIO;
  const W = CARD_GEOMETRY.viewWidth;
  const H = W / aspect;
  const fontPx = st.fontSize * H;
  const baseline = st.glyphY * H;
  const cacheKey = `${st.fontId}|${st.fontWeight}|${fontPx.toFixed(1)}|${text}`;
  const [scale, setScale] = useState<number>(scaleCache.get(cacheKey) ?? 1);
  const textRef = useRef<SVGTextElement>(null);

  // Long text (e.g. "str", "tch") shrinks to fit the card, once the font has loaded so the measurement is right.
  useLayoutEffect(() => {
    let cancelled = false;
    const cached = scaleCache.get(cacheKey);
    if (cached !== undefined) { setScale(cached); return; }
    void loadFont(st.fontId, st.fontWeight).then(() => {
      const el = textRef.current;
      if (cancelled || !el) return;
      try {
        const lw = el.getBBox().width + 2 * CARD_GEOMETRY.textPadding * (fontPx / 592);
        const s = Math.min(1, (W * CARD_GEOMETRY.maxTextWidth) / lw);
        scaleCache.set(cacheKey, s);
        setScale(s);
      } catch { /* not rendered yet */ }
    });
    return () => { cancelled = true; };
  }, [cacheKey, st.fontId, st.fontWeight, fontPx, W]);

  const bw = st.borderWidth * W;
  const pivotY = baseline - CARD_GEOMETRY.pivotAboveBaseline * fontPx;
  const outline = st.outlineColor || st.textColor;
  return (
    <svg className="face-svg" viewBox={`0 0 ${W} ${H}`} aria-hidden="true" focusable="false">
      <rect x={bw / 2} y={bw / 2} width={W - bw} height={H - bw} rx={st.cornerRadius * W} fill={st.background} stroke={st.borderColor} strokeWidth={bw} />
      <g transform={scale < 1 ? `translate(${W / 2} ${pivotY}) scale(${scale}) translate(${-W / 2} ${-pivotY})` : undefined}>
        <text
          ref={textRef} x={W / 2} y={baseline} textAnchor="middle" fontFamily={FONT_STACKS[st.fontId]} fontWeight={st.fontWeight} fontSize={fontPx}
          fill={st.textColor} stroke={st.outlineWidth > 0 ? outline : 'none'} strokeWidth={st.outlineWidth * fontPx} strokeLinejoin="round" paintOrder="stroke"
        >{text}</text>
      </g>
      {CORNER_NAMES.map((name) => {
        const c = st.corners[name];
        if (!c) return null;
        const pos = CORNER_POS[name];
        return (
          <text key={name} x={pos.x * W} y={pos.y * H} textAnchor={pos.anchor} fontFamily={FONT_STACKS[c.fontId ?? 'serif']} fontSize={(c.size ?? CARD_GEOMETRY.cornerSize) * H} fill={c.color ?? '#555555'}>{c.text}</text>
        );
      })}
    </svg>
  );
}

const plainScale = (text: string) => { const n = Array.from(text).length; return n <= 3 ? 1 : n === 4 ? 0.78 : n <= 6 ? 0.6 : 0.42; };

export const CardFace = memo(function CardFace({ text, faceDown, deck, cardId }: { text: string | null; faceDown: boolean; deck: DeckMeta; cardId: string }) {
  // Re-measure once web fonts finish loading (first paint may happen before they arrive).
  const [, force] = useState(0);
  useEffect(() => { if (deck.styled) void loadFont('playwrite-co', 400).then(() => force((n) => n + 1)); }, [deck.styled]);
  if (faceDown || text === null) return <span className="card-text" style={{ ['--scale' as string]: 1 }}>?</span>;
  if (!deck.styled) return <span className="card-text" style={{ ['--scale' as string]: plainScale(text) }}>{text}</span>;
  return <StyledFace text={text} deck={deck} cardId={cardId} />;
});
