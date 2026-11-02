/**
 * The "sandbox table": an eggshell surface with the three piles laid out as face-up stacks.
 *  - Tap a stack  → its top card moves to that pile's discard and the next card shows.
 *  - Tap a discard → the last drawn card goes back on top (undo).
 *  - Tap an empty stack → the discards are shuffled back in.
 * The three top cards sit side by side, so together they read as the current word.
 * The server is authoritative: a tap sends a request, and the cards move when the broadcast arrives.
 */
import { useRef } from 'react';
import { DEFAULT_ASPECT_RATIO, type AckResult, type BoardView, type CardView, type DeckMeta, type PileView } from '@shared/index';
import { CardFace } from './CardFace';

export interface TableProps {
  board: BoardView;
  deck: DeckMeta;
  canManipulate: boolean;
  statusMessage: string;
  /** Larger cards and labels for classroom projection. */
  projector?: boolean;
  onDraw(pileId: string, expectedCardId: string): Promise<AckResult>;
  onUndo(pileId: string): Promise<AckResult>;
  onRecycle(pileId: string): Promise<AckResult>;
  onShuffle(pileId: string): Promise<AckResult>;
  /** Flip the top card of a pile (only when deck.rules.allowFlip). */
  onFlip?(cardId: string, baseVersion: number): Promise<AckResult>;
  notify(message: string): void;
}

const label = (c: CardView | undefined) => (!c ? 'nothing' : c.faceDown || c.text === null ? 'a hidden card' : `"${c.text}"`);
/** A small, stable "tilt" per card so the discard pile looks hand-dropped rather than machine-aligned. */
const tiltFor = (id: string) => { let h = 0; for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 997; return ((h % 9) - 4) * 0.9; };

function Face({ card, deck }: { card: CardView; deck: DeckMeta }) {
  return (
    <span className={`face-wrap${deck.styled ? ' styled' : ' plain'}`}>
      <CardFace text={card.text} faceDown={card.faceDown} deck={deck} cardId={card.id} />
    </span>
  );
}

function Column({ pile, index, board, ...p }: { pile: PileView; index: number } & TableProps) {
  const { deck, canManipulate: can } = p;
  const busy = useRef(false);
  const top = pile.cards[0];
  const layers = Math.min(4, Math.max(0, pile.cards.length - 1));

  // One request at a time per pile: a second tap while the first is in flight is ignored (the server also rejects it as stale).
  const run = async (fn: () => Promise<AckResult>) => {
    if (busy.current) return;
    busy.current = true;
    try { const r = await fn(); if (!r.ok && r.code !== 'STALE') p.notify(r.message); } finally { busy.current = false; }
  };

  return (
    <section className="table-col" aria-label={`${pile.label} pile`}>
      <h2 className="table-label"><span className="pile-num" aria-hidden="true">{index + 1}</span> {pile.label}</h2>

      <div className="pair">
      <div className="pile-block">
      <div className="stack">
        {Array.from({ length: layers }, (_, k) => <div key={k} className="stack-layer" style={{ ['--k' as string]: layers - k }} aria-hidden="true" />)}
        {top ? (
          <button
            key={top.id} type="button" className={`stack-top${can ? ' tappable' : ''}`} aria-disabled={!can || undefined}
            aria-label={`${pile.label}: top card is ${label(top)}. ${pile.cards.length} card${pile.cards.length === 1 ? '' : 's'} in the pile.${can ? ' Press to draw it to the discard.' : ''}`}
            onClick={() => { if (can) void run(() => p.onDraw(pile.id, top.id)); }}
          >
            <Face card={top} deck={deck} />
          </button>
        ) : (
          <button type="button" className="stack-empty" disabled={!can || pile.discard.length === 0} onClick={() => void run(() => p.onRecycle(pile.id))}
            aria-label={pile.discard.length ? `${pile.label} pile is empty. Press to shuffle the ${pile.discard.length} discarded cards back in.` : `${pile.label} pile is empty.`}>
            <span>Empty</span>
            {can && pile.discard.length > 0 && <span className="small">Tap to shuffle the discards back in</span>}
          </button>
        )}
      </div>
      <p className="count" aria-hidden="true">{pile.cards.length} left</p>
      </div>

      <div className="pile-block discard-block">
      <div className="discard">
        {pile.discard.length === 0 ? (
          <div className="discard-empty" aria-hidden="true">Discard</div>
        ) : (
          // Fan the topmost 3 discards (index 0 is the interactive top). Older ones sit behind with offset + tilt.
          pile.discard.slice(0, 3).map((card, i) => {
            const isTop = i === 0;
            const tilt = tiltFor(card.id);
            const fanX = i * 10;   // px shift right for older cards
            const fanY = i * 6;
            const style = {
              ['--tilt' as string]: `${tilt}deg`,
              ['--fan-x' as string]: `${fanX}px`,
              ['--fan-y' as string]: `${fanY}px`,
              zIndex: 3 - i,
            };
            if (isTop) {
              return (
                <button key={card.id} type="button"
                  className={`discard-top${can ? ' tappable' : ''}`}
                  style={style}
                  aria-disabled={!can || undefined}
                  aria-label={`${pile.label} discard: ${label(card)} on top, ${pile.discard.length} discarded.${can ? ' Press to put it back on the pile.' : ''}`}
                  onClick={() => { if (can) void run(() => p.onUndo(pile.id)); }}>
                  <Face card={card} deck={deck} />
                </button>
              );
            }
            return (
              <div key={card.id} className="discard-fan" style={style} aria-hidden="true">
                <Face card={card} deck={deck} />
              </div>
            );
          })
        )}
      </div>
      <p className="count" aria-hidden="true">{pile.discard.length} discarded</p>
      </div>
      </div>

      {can && (
        <div className="table-actions">
          {deck.rules.allowFlip && top && p.onFlip && (
            <button type="button" className="btn small" onClick={() => void run(() => p.onFlip!(top.id, board.version))}>
              {top.faceDown ? 'Reveal' : 'Flip down'}
            </button>
          )}
          <button type="button" className="btn small" disabled={pile.cards.length < 2} onClick={() => void run(() => p.onShuffle(pile.id))}>🔀 Shuffle</button>
          <button type="button" className="btn small" disabled={pile.discard.length === 0} onClick={() => void run(() => p.onRecycle(pile.id))}>↺ Reshuffle discards</button>
        </div>
      )}
    </section>
  );
}

export function Table(props: TableProps) {
  const { board, deck, canManipulate, statusMessage, projector } = props;
  const aspect = deck.aspectRatio ?? DEFAULT_ASPECT_RATIO;
  const spoken = board.piles.map((pl) => label(pl.cards[0])).join(', ');
  return (
    <div className={`table-surface${projector ? ' projector' : ''}`} style={{ ['--aspect' as string]: aspect }}>
      <div className="sr-only" aria-live="polite">Top cards, left to right: {spoken}</div>
      {(canManipulate || statusMessage) && (
        <p className="table-hint">
          {canManipulate
            ? `Tap a pile to draw its top card. Tap a discard to put the card back.${deck.rules.allowFlip ? ' Use Reveal / Flip down under a pile to flip its top card.' : ''}`
            : statusMessage}
        </p>
      )}
      <div className="table-grid">
        {board.piles.map((pile, i) => <Column key={pile.id} pile={pile} index={i} {...props} />)}
      </div>
    </div>
  );
}
