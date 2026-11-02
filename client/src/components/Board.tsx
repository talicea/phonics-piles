/**
 * The shared board. The SAME component renders for the teacher and for students; only the props differ.
 *
 * Interaction model
 *  - Mouse / pen: press and move > 5 px to drag; press and release to select.
 *  - Touch: press and HOLD (~160 ms) to pick a card up, then drag. Moving earlier means "scroll the page".
 *    While a card is held we cancel touchmove so the page does not scroll under the finger.
 *  - Keyboard: Tab to the board, arrows move focus, Enter/Space select, Shift+Arrow re-orders, Esc deselects.
 *  - The toolbar under the word strip offers buttons for everything a drag can do (also the accessible path).
 *  - Dragging takes a server-side lock on the card (so nobody else can grab it) and it is released on drop.
 *  - The board never changes itself: a drop sends a request and the card moves when the server broadcasts it.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_ASPECT_RATIO, type AckResult, type BoardView, type CardView, type DeckMeta, type LockMap } from '@shared/index';
import { CardFace } from './CardFace';

export interface BoardProps {
  board: BoardView;
  locks: LockMap;
  deck: DeckMeta;
  canManipulate: boolean;
  isHost: boolean;
  /** 'host' or the participant id; used to tell my locks from other people's. */
  myOwnerId: string;
  /** One line describing who can move cards right now. */
  statusMessage: string;
  onLock(cardId: string): Promise<AckResult>;
  onUnlock(cardId: string): Promise<AckResult>;
  onMove(p: { cardId: string; toPileId: string; toIndex: number; baseVersion: number }): Promise<AckResult>;
  onFlip(cardId: string, baseVersion: number): Promise<AckResult>;
  onShufflePile(pileId: string): Promise<AckResult>;
  notify(message: string): void;
}

interface DropTarget { pileId: string; index: number }
interface DragView { cardId: string; text: string | null; faceDown: boolean; x: number; y: number; offX: number; offY: number; w: number; h: number; target: DropTarget | null }
interface DragInternal {
  cardId: string; pointerId: number; pointerType: string;
  startX: number; startY: number; lastX: number; lastY: number; offX: number; offY: number; w: number; h: number;
  active: boolean; movedFar: boolean; baseVersion: number; target: DropTarget | null;
  holdTimer: ReturnType<typeof setTimeout> | null; keepAlive: ReturnType<typeof setInterval> | null; raf: number | null;
}

const MOUSE_SLOP = 5;
const TOUCH_SLOP = 10;
const TOUCH_HOLD_MS = 160;
const LOCK_REFRESH_MS = 4000;
const EDGE = 70;

const cardLabel = (c: CardView) => (c.faceDown ? 'face-down card' : `card ${c.text ?? ''}`);

// ------------------------------------------------------------------------------------------------ Card tile
interface TileProps {
  card: CardView; index: number; count: number; pileLabel: string; isTop: boolean;
  selected: boolean; dragging: boolean; lockedBy: string | null; drop: '' | 'before' | 'after';
  disabled: boolean; tabbable: boolean; deck: DeckMeta;
  onPointerDown(e: React.PointerEvent<HTMLButtonElement>, id: string): void;
  onKeyDown(e: React.KeyboardEvent<HTMLButtonElement>, id: string): void;
  onActivate(id: string): void;
  onFocusCard(id: string): void;
}

const CardTile = memo(function CardTile(p: TileProps) {
  const { card } = p;
  const cls = ['card', p.deck.styled && 'styled', p.selected && 'selected', p.dragging && 'dragging', p.lockedBy && 'locked', card.faceDown && 'facedown', p.drop && `drop-${p.drop}`, p.disabled && 'disabled']
    .filter(Boolean).join(' ');
  const label = `${cardLabel(card)}, ${p.pileLabel}, position ${p.index + 1} of ${p.count}${p.isTop ? ', top card' : ''}${p.selected ? ', selected' : ''}${p.lockedBy ? `, being moved by ${p.lockedBy}` : ''}`;
  return (
    <button
      type="button"
      className={cls}
      data-card-id={card.id}
      aria-label={label}
      aria-pressed={p.disabled ? undefined : p.selected}
      aria-disabled={p.disabled || undefined}
      tabIndex={p.tabbable ? 0 : -1}
      onPointerDown={(e) => p.onPointerDown(e, card.id)}
      onKeyDown={(e) => p.onKeyDown(e, card.id)}
      onFocus={() => p.onFocusCard(card.id)}
      // Real mouse/touch clicks are handled by the pointer events; click with detail 0 is a keyboard activation.
      onClick={(e) => { if (e.detail === 0) p.onActivate(card.id); }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <CardFace text={card.text} faceDown={card.faceDown} deck={p.deck} cardId={card.id} />
      {p.isTop && <span className="badge badge-top" aria-hidden="true">TOP</span>}
      {p.selected && <span className="badge badge-sel" aria-hidden="true">✓</span>}
      {p.lockedBy && <span className="badge badge-lock" aria-hidden="true">🔒 {p.lockedBy}</span>}
    </button>
  );
});

// ------------------------------------------------------------------------------------------------ Board
export function Board(props: BoardProps) {
  const { board, locks, deck, canManipulate, isHost, myOwnerId } = props;
  const rules = deck.rules;
  const aspect = deck.aspectRatio ?? DEFAULT_ASPECT_RATIO;
  const propsRef = useRef(props);
  propsRef.current = props;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rovingId, setRovingId] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragView | null>(null);
  const dragRef = useRef<DragInternal | null>(null);
  const holdingRef = useRef(false); // true while a card is held: used to block touch scrolling
  const rootRef = useRef<HTMLDivElement>(null);

  const where = useMemo(() => {
    const m = new Map<string, { pileIdx: number; idx: number; card: CardView }>();
    board.piles.forEach((p, pi) => p.cards.forEach((c, i) => m.set(c.id, { pileIdx: pi, idx: i, card: c })));
    return m;
  }, [board]);
  const whereRef = useRef(where);
  whereRef.current = where;

  // Drop a selection / roving focus that points at a card that no longer exists (deck changed, etc.).
  const selected = selectedId && where.get(selectedId) ? selectedId : null;
  const firstId = board.piles.find((p) => p.cards.length)?.cards[0]?.id ?? null;
  const tabId = rovingId && where.has(rovingId) ? rovingId : firstId;

  // Cannot manipulate any more (teacher changed the mode)? Cancel any drag in flight and clear selection.
  useEffect(() => {
    if (!canManipulate) { setSelectedId(null); cancelDrag(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canManipulate]);

  // ---- touch: stop the page scrolling while a card is held. Must be a NON-passive listener registered up front.
  useEffect(() => {
    const block = (e: TouchEvent) => { if (holdingRef.current && e.cancelable) e.preventDefault(); };
    window.addEventListener('touchmove', block, { passive: false });
    return () => window.removeEventListener('touchmove', block);
  }, []);

  // ---- drop target under the pointer
  const computeTarget = useCallback((x: number, y: number, cardId: string): DropTarget | null => {
    for (const el of document.elementsFromPoint(x, y)) {
      const pileEl = (el as HTMLElement).closest?.('[data-pile-id]') as HTMLElement | null;
      if (!pileEl || !rootRef.current?.contains(pileEl)) continue;
      const cards = Array.from(pileEl.querySelectorAll<HTMLElement>('[data-card-id]')).filter((c) => c.dataset.cardId !== cardId);
      let index = 0;
      for (const c of cards) {
        const r = c.getBoundingClientRect();
        // "Before the pointer" in reading order: whole rows above, or same row and left of the pointer.
        if (r.bottom < y || (y >= r.top && y <= r.bottom && r.left + r.width / 2 < x)) index++;
      }
      return { pileId: pileEl.dataset.pileId as string, index };
    }
    return null;
  }, []);

  const targetAllowed = useCallback((cardId: string, t: DropTarget | null): boolean => {
    if (!t) return false;
    const from = whereRef.current.get(cardId);
    const toIdx = propsRef.current.board.piles.findIndex((p) => p.id === t.pileId);
    if (!from || toIdx < 0) return false;
    return from.pileIdx === toIdx ? propsRef.current.deck.rules.allowReorder : propsRef.current.deck.rules.allowCrossPileMoves;
  }, []);

  const stopTimers = (st: DragInternal) => {
    if (st.holdTimer) clearTimeout(st.holdTimer);
    if (st.keepAlive) clearInterval(st.keepAlive);
    if (st.raf !== null) cancelAnimationFrame(st.raf);
    st.holdTimer = null; st.keepAlive = null; st.raf = null;
  };

  function cancelDrag(release: boolean) {
    const st = dragRef.current;
    if (!st) return;
    stopTimers(st);
    dragRef.current = null;
    holdingRef.current = false;
    setDrag(null);
    if (release && st.active) void propsRef.current.onUnlock(st.cardId);
  }

  const refreshTarget = (st: DragInternal) => {
    const raw = computeTarget(st.lastX, st.lastY, st.cardId);
    st.target = targetAllowed(st.cardId, raw) ? raw : null;
    setDrag((d) => (d ? { ...d, x: st.lastX, y: st.lastY, target: st.target } : d));
  };

  const activate = (st: DragInternal) => {
    const found = whereRef.current.get(st.cardId);
    if (!found || st.active) return;
    st.active = true;
    holdingRef.current = true;
    if (navigator.vibrate) try { navigator.vibrate(8); } catch { /* ignore */ }
    setDrag({ cardId: st.cardId, text: found.card.text, faceDown: found.card.faceDown, x: st.lastX, y: st.lastY, offX: st.offX, offY: st.offY, w: st.w, h: st.h, target: null });
    void propsRef.current.onLock(st.cardId).then((res) => {
      if (!res.ok && dragRef.current === st) { cancelDrag(false); propsRef.current.notify(res.message); }
    });
    // Locks expire on the server (so abandoned drags cannot jam the board); keep ours alive while the finger is down.
    st.keepAlive = setInterval(() => { void propsRef.current.onLock(st.cardId); }, LOCK_REFRESH_MS);
    const tick = () => {
      if (dragRef.current !== st || !st.active) return;
      const dy = st.lastY < EDGE ? -14 : st.lastY > window.innerHeight - EDGE ? 14 : 0;
      if (dy) { window.scrollBy(0, dy); refreshTarget(st); }
      st.raf = requestAnimationFrame(tick);
    };
    st.raf = requestAnimationFrame(tick);
    refreshTarget(st);
  };

  // ---- window-level pointer tracking (registered once; handlers read refs, so they are never stale)
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const st = dragRef.current;
      if (!st || e.pointerId !== st.pointerId) return;
      st.lastX = e.clientX; st.lastY = e.clientY;
      const dist = Math.hypot(e.clientX - st.startX, e.clientY - st.startY);
      if (!st.active) {
        if (st.pointerType === 'touch') {
          if (dist > TOUCH_SLOP) { stopTimers(st); dragRef.current = null; } // finger moved before the hold: it is a scroll
        } else if (dist > MOUSE_SLOP) { st.movedFar = true; activate(st); }
        return;
      }
      if (dist > MOUSE_SLOP) st.movedFar = true;
      if (e.cancelable) e.preventDefault();
      refreshTarget(st);
    };
    const up = (e: PointerEvent) => {
      const st = dragRef.current;
      if (!st || e.pointerId !== st.pointerId) return;
      stopTimers(st);
      dragRef.current = null;
      holdingRef.current = false;
      const p = propsRef.current;
      if (!st.active || !st.movedFar) {
        // A tap / click (or a hold that never moved): toggle selection.
        if (st.active) void p.onUnlock(st.cardId);
        setDrag(null);
        setSelectedId((cur) => (cur === st.cardId ? null : st.cardId));
        setRovingId(st.cardId);
        return;
      }
      const target = st.target;
      if (!target) {
        setDrag(null);
        void p.onUnlock(st.cardId);
        const raw = computeTarget(st.lastX, st.lastY, st.cardId);
        if (raw) p.notify(p.deck.rules.allowCrossPileMoves ? 'That move is not allowed in this deck.' : 'This deck keeps cards in their own pile.');
        return;
      }
      void p.onMove({ cardId: st.cardId, toPileId: target.pileId, toIndex: target.index, baseVersion: st.baseVersion }).then((res) => {
        setDrag(null); // the server's broadcast has already arrived: the card is in its new place
        if (!res.ok) { p.notify(res.message); void p.onUnlock(st.cardId); }
        else setSelectedId(null);
      });
    };
    const cancel = (e: PointerEvent) => {
      const st = dragRef.current;
      if (st && e.pointerId === st.pointerId) cancelDrag(true);
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && dragRef.current?.active) cancelDrag(true); };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key);
      const st = dragRef.current;
      if (st) { stopTimers(st); if (st.active) void propsRef.current.onUnlock(st.cardId); }
      dragRef.current = null; holdingRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onCardPointerDown = useCallback((e: React.PointerEvent<HTMLButtonElement>, cardId: string) => {
    const p = propsRef.current;
    if (!p.canManipulate || dragRef.current) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const lock = p.locks[cardId];
    if (lock && lock.by !== p.myOwnerId && !p.isHost) { p.notify(`${lock.byName} is moving that card.`); return; }
    const rect = e.currentTarget.getBoundingClientRect();
    const st: DragInternal = {
      cardId, pointerId: e.pointerId, pointerType: e.pointerType,
      startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY,
      offX: e.clientX - rect.left, offY: e.clientY - rect.top, w: rect.width, h: rect.height,
      active: false, movedFar: false, baseVersion: p.board.version, target: null, holdTimer: null, keepAlive: null, raf: null,
    };
    dragRef.current = st;
    if (e.pointerType !== 'mouse') {
      // Touch / pen: a short hold picks the card up, so ordinary swipes still scroll the page.
      st.holdTimer = setTimeout(() => { if (dragRef.current === st && !st.active) activate(st); }, TOUCH_HOLD_MS);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- keyboard
  const focusCard = (id: string | undefined) => {
    if (!id) return;
    setRovingId(id);
    requestAnimationFrame(() => rootRef.current?.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(id)}"]`)?.focus());
  };

  const sendMove = useCallback(async (cardId: string, toPileId: string, toIndex: number) => {
    const p = propsRef.current;
    const res = await p.onMove({ cardId, toPileId, toIndex, baseVersion: p.board.version });
    if (!res.ok) p.notify(res.message);
    return res.ok;
  }, []);

  const onCardKeyDown = useCallback((e: React.KeyboardEvent<HTMLButtonElement>, id: string) => {
    const w = whereRef.current.get(id);
    if (!w) return;
    const pile = propsRef.current.board.piles[w.pileIdx]!;
    const flat = propsRef.current.board.piles.flatMap((pl) => pl.cards.map((c) => c.id));
    const pos = flat.indexOf(id);
    const arrow = ({ ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 } as Record<string, number>)[e.key];
    if (arrow !== undefined) {
      e.preventDefault();
      if (e.shiftKey) {
        if (!propsRef.current.canManipulate) return;
        const target = w.idx + arrow;
        if (target < 0 || target >= pile.cards.length) return;
        void sendMove(id, pile.id, target).then((ok) => ok && focusCard(id));
      } else {
        focusCard(flat[Math.min(flat.length - 1, Math.max(0, pos + arrow))]);
      }
    } else if (e.key === 'Escape') {
      setSelectedId(null);
    } else if (e.key === 'Home') { e.preventDefault(); focusCard(pile.cards[0]?.id); }
    else if (e.key === 'End') { e.preventDefault(); focusCard(pile.cards[pile.cards.length - 1]?.id); }
  }, [sendMove]);

  const onActivate = useCallback((id: string) => {
    if (!propsRef.current.canManipulate) return;
    setSelectedId((cur) => (cur === id ? null : id));
  }, []);
  const onFocusCard = useCallback((id: string) => setRovingId(id), []);

  // ---- render
  const selW = selected ? where.get(selected) : undefined;
  const selPile = selW ? board.piles[selW.pileIdx] : undefined;
  const words = board.piles.map((p) => p.cards[0]);
  const spoken = words.map((c) => (c ? (c.faceDown ? 'hidden card' : c.text) : 'empty')).join(' ');

  return (
    <div className={`board${deck.styled ? ' styled' : ''}`} ref={rootRef} style={{ ['--aspect' as string]: aspect }}>
      <section className="word-strip" aria-label="Top card of each pile, left to right">
        <div className="sr-only" aria-live="polite">Top cards: {spoken}</div>
        {board.piles.map((p, i) => {
          const c = words[i];
          return (
            <div className="word-slot" key={p.id}>
              <div className={`word-card${deck.styled ? ' styled' : ''}`} aria-hidden="true">
                {c ? <CardFace text={c.text} faceDown={c.faceDown} deck={deck} cardId={c.id} /> : <span className="card-text">–</span>}
              </div>
              <div className="word-label">{p.label}</div>
            </div>
          );
        })}
      </section>

      <div className="toolbar" role="toolbar" aria-label="Card actions">
        {!canManipulate && <p className="hint">{props.statusMessage}</p>}
        {canManipulate && !selW && <p className="hint">{props.statusMessage} Tap a card to select it, or drag it to a new place.</p>}
        {canManipulate && selW && selPile && (
          <>
            <p className="hint"><strong>Selected:</strong> <span className="chip">{selW.card.faceDown ? '?' : selW.card.text}</span> in {selPile.label}</p>
            <button type="button" className="btn small" disabled={selW.idx === 0 || !rules.allowReorder} onClick={() => void sendMove(selected!, selPile.id, 0)}>⇱ Make top</button>
            <button type="button" className="btn small" disabled={selW.idx === 0 || !rules.allowReorder} onClick={() => void sendMove(selected!, selPile.id, selW.idx - 1)}>◀ Earlier</button>
            <button type="button" className="btn small" disabled={selW.idx >= selPile.cards.length - 1 || !rules.allowReorder} onClick={() => void sendMove(selected!, selPile.id, selW.idx + 1)}>Later ▶</button>
            {rules.allowCrossPileMoves && board.piles.map((p, i) => i === selW.pileIdx ? null : (
              <button type="button" className="btn small" key={p.id} onClick={() => void sendMove(selected!, p.id, 0).then((ok) => ok && setSelectedId(null))}>→ {p.label}</button>
            ))}
            {rules.allowFlip && <button type="button" className="btn small" onClick={() => void props.onFlip(selected!, board.version).then((r) => !r.ok && props.notify(r.message))}>⟲ Flip</button>}
            <button type="button" className="btn small ghost" onClick={() => setSelectedId(null)}>Deselect</button>
          </>
        )}
      </div>

      <div className="piles">
        {board.piles.map((pile, pi) => {
          const others = drag ? pile.cards.filter((c) => c.id !== drag.cardId) : pile.cards;
          const tgt = drag?.target && drag.target.pileId === pile.id ? drag.target : null;
          return (
            <section className={`pile${tgt ? ' is-target' : ''}${tgt && others.length === 0 ? ' drop-empty' : ''}`} key={pile.id} data-pile-id={pile.id} aria-label={`${pile.label} pile, ${pile.cards.length} cards`}>
              <header className="pile-head">
                <h2><span className="pile-num" aria-hidden="true">{pi + 1}</span> {pile.label}</h2>
                <span className="count">{pile.cards.length} card{pile.cards.length === 1 ? '' : 's'}</span>
                {canManipulate && (
                  <button type="button" className="btn small" onClick={() => void props.onShufflePile(pile.id).then((r) => !r.ok && props.notify(r.message))}>🔀 Shuffle</button>
                )}
              </header>
              <div className="pile-cards">
                {pile.cards.map((card, i) => {
                  let drop: '' | 'before' | 'after' = '';
                  if (tgt) {
                    if (others[tgt.index]?.id === card.id) drop = 'before';
                    else if (tgt.index >= others.length && others[others.length - 1]?.id === card.id) drop = 'after';
                  }
                  const lock = locks[card.id];
                  const lockedBy = lock && lock.by !== myOwnerId ? lock.byName : null;
                  return (
                    <CardTile
                      key={card.id} card={card} index={i} count={pile.cards.length} pileLabel={pile.label} isTop={i === 0}
                      selected={selected === card.id} dragging={drag?.cardId === card.id} lockedBy={lockedBy} drop={drop}
                      disabled={!canManipulate} tabbable={tabId === card.id} deck={deck}
                      onPointerDown={onCardPointerDown} onKeyDown={onCardKeyDown} onActivate={onActivate} onFocusCard={onFocusCard}
                    />
                  );
                })}
                {pile.cards.length === 0 && <p className="empty">Empty pile</p>}
              </div>
            </section>
          );
        })}
      </div>

      {drag && (
        <div className={`card ghost-card${deck.styled ? ' styled' : ''}`} aria-hidden="true" style={{ left: drag.x - drag.offX, top: drag.y - drag.offY, width: drag.w, height: drag.h }}>
          <CardFace text={drag.text} faceDown={drag.faceDown} deck={deck} cardId={drag.cardId} />
        </div>
      )}
    </div>
  );
}
