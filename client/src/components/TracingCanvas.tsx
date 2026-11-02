/**
 * Tracing Practice — Slice 1 (single-player canvas).
 *
 * Renders a skills-style card with writing lines and a grapheme.
 * The student traces with a finger/stylus:
 *   - Stroke is green while inside the letter, muted when outside.
 *   - Progress = % of the letter mask that has been visited.
 *   - Success when coverage ≥ 80 % AND the majority of the stroke stayed inside.
 *   - Optional vibration while the pointer is inside (feature-detected).
 *
 * No multiplayer or persistence yet — that is later slices.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { CARD_GEOMETRY, DEFAULT_ASPECT_RATIO, FONT_STACKS } from '@shared/index';

const VIEW_W = CARD_GEOMETRY.viewWidth; // 896
const VIEW_H = VIEW_W / DEFAULT_ASPECT_RATIO; // ~1345
// Writing-line centres from the original printable skills cards (flashcard kit).
const LINE_YS = [110, 425, 721, 1037];
const LINE_W = 32;
const BASELINE = 721;
const FONT_PX = 592;

export interface TraceCard {
  text: string;
  cat?: string;       // colour category (V/C/DG/…)
  count?: string;     // optional sound count (top-left)
  lesson?: number;
  color?: string;     // override ink colour
}

const CAT_COLORS: Record<string, string> = {
  V: '#990000', C: '#000000', DG: '#0b1a6b', P: '#c21f1f',
  B: '#2f5fd9', T: '#4b1a7a', DP: '#ff4f9a',
};

export interface TracingCanvasProps {
  card: TraceCard;
  /** Called when the student meets the success criteria. */
  onSuccess?: () => void;
  /** Allow the device to vibrate while the finger is inside the path. Default false. */
  vibrate?: boolean;
  className?: string;
  /** Called once when tracing begins (first pointer down). */
  onStreamStart?: () => void;
  /**
   * Batched normalised points [x0,y0,x1,y1,...] in 0..1 card space.
   * Fired while the student is drawing (throttled by the parent if needed).
   */
  onStreamPoints?: (points: number[]) => void;
  /** Called when the pointer is lifted or the component unmounts while streaming. */
  onStreamEnd?: () => void;
}

type Pt = { x: number; y: number };

export function TracingCanvas({ card, onSuccess, vibrate = false, className, onStreamStart, onStreamPoints, onStreamEnd }: TracingCanvasProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const maskRef = useRef<ImageData | null>(null);
  const visitedRef = useRef<Uint8Array | null>(null);
  const totalMaskRef = useRef(0);
  const visitedCountRef = useRef(0);
  const strokeInsideRef = useRef(0);
  const strokeTotalRef = useRef(0);
  const drawingRef = useRef(false);
  const lastPtRef = useRef<Pt | null>(null);
  const successFiredRef = useRef(false);
  const streamingRef = useRef(false);
  const streamBufRef = useRef<number[]>([]);
  const streamTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Callbacks arrive as fresh inline functions on every parent render. Keep the latest in a ref so that effects do NOT
  // re-run (which would rebuild the mask and wipe the child's drawing) every time something else happens in the room.
  const onStreamEndRef = useRef(onStreamEnd);
  onStreamEndRef.current = onStreamEnd;

  const [coverage, setCoverage] = useState(0);
  const [insideRatio, setInsideRatio] = useState(1);
  const [succeeded, setSucceeded] = useState(false);
  const [vibrateOn, setVibrateOn] = useState(vibrate);
  const [canVibrate, setCanVibrate] = useState(false);

  const ink = card.color ?? CAT_COLORS[(card.cat ?? 'C').toUpperCase()] ?? '#000000';

  // Feature-detect vibration once.
  useEffect(() => {
    setCanVibrate(typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function');
  }, []);

  // Build the letter mask whenever the card text or size changes.
  const rebuildMask = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    if (cssW < 10 || cssH < 10) return;

    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Wait for the cursive font so the mask matches what we draw.
    try {
      if (document.fonts) await document.fonts.load(`400 ${FONT_PX}px PlaywriteCO`);
    } catch { /* continue with fallback */ }

    // Offscreen mask at the same CSS pixel size.
    const off = document.createElement('canvas');
    off.width = Math.round(cssW * dpr);
    off.height = Math.round(cssH * dpr);
    const octx = off.getContext('2d')!;
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const sx = cssW / VIEW_W;
    const sy = cssH / VIEW_H;

    // Draw a thickened version of the grapheme for a forgiving hit region.
    octx.save();
    octx.translate(cssW / 2, BASELINE * sy);
    octx.fillStyle = '#000';
    octx.strokeStyle = '#000';
    octx.lineWidth = Math.max(18, FONT_PX * sy * 0.14); // generous hit tolerance
    octx.lineJoin = 'round';
    octx.lineCap = 'round';
    octx.font = `400 ${FONT_PX * sy}px PlaywriteCO, cursive`;
    octx.textAlign = 'center';
    octx.textBaseline = 'alphabetic';
    octx.strokeText(card.text, 0, 0);
    octx.fillText(card.text, 0, 0);
    octx.restore();

    const mask = octx.getImageData(0, 0, off.width, off.height);
    maskRef.current = mask;
    const visited = new Uint8Array(mask.width * mask.height);
    visitedRef.current = visited;
    visitedCountRef.current = 0;
    strokeInsideRef.current = 0;
    strokeTotalRef.current = 0;
    successFiredRef.current = false;
    setSucceeded(false);
    setCoverage(0);
    setInsideRatio(1);

    let total = 0;
    for (let i = 3; i < mask.data.length; i += 4) {
      if ((mask.data[i] ?? 0) > 128) total++; // alpha channel
    }
    totalMaskRef.current = Math.max(1, total);

    // Initial paint of the guide card.
    paintGuide(ctx, cssW, cssH, sx, sy, null);
  }, [card.text, card.cat, card.color, ink]);

  useEffect(() => {
    void rebuildMask();
    const onResize = () => { void rebuildMask(); };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      if (streamTimerRef.current) clearTimeout(streamTimerRef.current);
      if (streamingRef.current) {
        streamingRef.current = false;
        onStreamEndRef.current?.();
      }
    };
  }, [rebuildMask]);

  function paintGuide(
    ctx: CanvasRenderingContext2D,
    cssW: number, cssH: number,
    sx: number, sy: number,
    strokePts: { pts: Pt[]; inside: boolean[] } | null,
  ) {
    ctx.clearRect(0, 0, cssW, cssH);

    // Card background
    ctx.fillStyle = '#fffdf8';
    roundRect(ctx, 0, 0, cssW, cssH, 12);
    ctx.fill();

    // Writing lines
    ctx.strokeStyle = ink;
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = Math.max(2, LINE_W * sy * 0.45);
    for (const y of LINE_YS) {
      const yy = y * sy;
      ctx.beginPath();
      ctx.moveTo(cssW * 0.06, yy);
      ctx.lineTo(cssW * 0.94, yy);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Guide letter (light fill so the student stroke is visible on top)
    ctx.save();
    ctx.translate(cssW / 2, BASELINE * sy);
    ctx.font = `400 ${FONT_PX * sy}px PlaywriteCO, cursive`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(2, FONT_PX * sy * 0.04);
    ctx.strokeStyle = ink;
    ctx.globalAlpha = 0.22;
    ctx.strokeText(card.text, 0, 0);
    ctx.fillStyle = ink;
    ctx.globalAlpha = 0.12;
    ctx.fillText(card.text, 0, 0);
    ctx.restore();
    ctx.globalAlpha = 1;

    // Corner marks
    ctx.fillStyle = '#555';
    ctx.font = `700 ${Math.max(14, 28 * sy)}px "Times New Roman", Times, serif`;
    if (card.count) {
      ctx.textAlign = 'left';
      ctx.fillStyle = ink;
      ctx.fillText(card.count, cssW * 0.07, cssH * 0.09);
    }
    if (card.lesson != null) {
      ctx.textAlign = 'right';
      ctx.fillStyle = '#555';
      ctx.fillText(String(card.lesson), cssW * 0.93, cssH * 0.96);
    }

    // Student stroke
    if (strokePts && strokePts.pts.length > 1) {
      for (let i = 1; i < strokePts.pts.length; i++) {
        const a = strokePts.pts[i - 1];
        const b = strokePts.pts[i];
        if (!a || !b) continue;
        const ok = strokePts.inside[i];
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.strokeStyle = ok ? '#166534' : '#a8a29e';
        ctx.lineWidth = Math.max(4, FONT_PX * sy * 0.07);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.stroke();
      }
    }
  }

  // Keep the latest stroke so we can repaint on pointer move without React state thrashing.
  const strokePtsRef = useRef<{ pts: Pt[]; inside: boolean[] }>({ pts: [], inside: [] });

  function cssPoint(e: React.PointerEvent | PointerEvent): Pt | null {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function testInside(cssX: number, cssY: number): boolean {
    const mask = maskRef.current;
    const canvas = canvasRef.current;
    if (!mask || !canvas) return false;
    const dpr = canvas.width / canvas.clientWidth;
    const mx = Math.round(cssX * dpr);
    const my = Math.round(cssY * dpr);
    if (mx < 0 || my < 0 || mx >= mask.width || my >= mask.height) return false;
    const idx = (my * mask.width + mx) * 4 + 3;
    return (mask.data[idx] ?? 0) > 128;
  }

  function markVisited(cssX: number, cssY: number) {
    const mask = maskRef.current;
    const visited = visitedRef.current;
    const canvas = canvasRef.current;
    if (!mask || !visited || !canvas) return;
    const dpr = canvas.width / canvas.clientWidth;
    // Stamp a small brush so coverage accumulates reasonably.
    const brush = Math.max(3, Math.round(6 * dpr));
    const cx = Math.round(cssX * dpr);
    const cy = Math.round(cssY * dpr);
    for (let dy = -brush; dy <= brush; dy++) {
      for (let dx = -brush; dx <= brush; dx++) {
        if (dx * dx + dy * dy > brush * brush) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= mask.width || y >= mask.height) continue;
        const mi = (y * mask.width + x) * 4 + 3;
        if ((mask.data[mi] ?? 0) <= 128) continue;
        const vi = y * mask.width + x;
        if (!visited[vi]) {
          visited[vi] = 1;
          visitedCountRef.current++;
        }
      }
    }
  }

  function updateStats() {
    const cov = visitedCountRef.current / totalMaskRef.current;
    const total = strokeTotalRef.current;
    const ratio = total > 0 ? strokeInsideRef.current / total : 1;
    setCoverage(cov);
    setInsideRatio(ratio);
    if (!successFiredRef.current && cov >= 0.8 && ratio >= 0.55) {
      successFiredRef.current = true;
      setSucceeded(true);
      if (canVibrate && vibrateOn) {
        try { navigator.vibrate([40, 30, 40, 30, 80]); } catch { /* ignore */ }
      }
      onSuccess?.();
    }
  }

  function vibratePulse(inside: boolean) {
    if (!canVibrate || !vibrateOn) return;
    try {
      if (inside) navigator.vibrate(30);
      else navigator.vibrate(0);
    } catch { /* ignore */ }
  }

  const flushStream = () => {
    if (!onStreamPoints || streamBufRef.current.length < 2) {
      streamBufRef.current = [];
      return;
    }
    onStreamPoints(streamBufRef.current.slice());
    streamBufRef.current = [];
  };

  const queueStreamPoint = (cssX: number, cssY: number) => {
    if (!onStreamPoints) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const nx = Math.min(1, Math.max(0, cssX / canvas.clientWidth));
    const ny = Math.min(1, Math.max(0, cssY / canvas.clientHeight));
    streamBufRef.current.push(nx, ny);
    if (streamBufRef.current.length >= 40) {
      if (streamTimerRef.current) { clearTimeout(streamTimerRef.current); streamTimerRef.current = null; }
      flushStream();
    } else if (!streamTimerRef.current) {
      streamTimerRef.current = setTimeout(() => { streamTimerRef.current = null; flushStream(); }, 100); // ≤10 batches/s, inside the server's allowance
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (succeeded) return;
    const pt = cssPoint(e);
    if (!pt) return;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    drawingRef.current = true;
    lastPtRef.current = pt;
    const inside = testInside(pt.x, pt.y);
    strokePtsRef.current = { pts: [pt], inside: [inside] };
    if (inside) {
      markVisited(pt.x, pt.y);
      strokeInsideRef.current++;
    }
    strokeTotalRef.current++;
    if (!streamingRef.current) {
      streamingRef.current = true;
      onStreamStart?.();
    }
    queueStreamPoint(pt.x, pt.y);
    vibratePulse(inside);
    repaint();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drawingRef.current || succeeded) return;
    const pt = cssPoint(e);
    if (!pt) return;
    const last = lastPtRef.current;
    if (last && Math.hypot(pt.x - last.x, pt.y - last.y) < 1.5) return;
    lastPtRef.current = pt;

    const inside = testInside(pt.x, pt.y);
    strokePtsRef.current.pts.push(pt);
    strokePtsRef.current.inside.push(inside);
    if (inside) {
      markVisited(pt.x, pt.y);
      strokeInsideRef.current++;
    }
    strokeTotalRef.current++;
    queueStreamPoint(pt.x, pt.y);
    vibratePulse(inside);
    updateStats();
    repaint();
  };

  const onPointerUp = () => {
    drawingRef.current = false;
    lastPtRef.current = null;
    if (streamTimerRef.current) { clearTimeout(streamTimerRef.current); streamTimerRef.current = null; }
    flushStream();
    if (streamingRef.current) {
      streamingRef.current = false;
      onStreamEnd?.();
    }
    if (canVibrate && vibrateOn) {
      try { navigator.vibrate(0); } catch { /* ignore */ }
    }
    updateStats();
  };

  function repaint() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    const sx = cssW / VIEW_W;
    const sy = cssH / VIEW_H;
    // Reset transform because we may have set dpr earlier.
    const dpr = canvas.width / cssW;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    paintGuide(ctx, cssW, cssH, sx, sy, strokePtsRef.current);
  }

  const reset = () => {
    strokePtsRef.current = { pts: [], inside: [] };
    successFiredRef.current = false;
    setSucceeded(false);
    void rebuildMask();
  };

  const pct = Math.round(coverage * 100);
  const insidePct = Math.round(insideRatio * 100);

  return (
    <div className={`tracing-wrap${className ? ` ${className}` : ''}`} ref={wrapRef}>
      <div className="tracing-toolbar">
        <div className="tracing-progress" aria-live="polite">
          <span className={pct >= 80 ? 'ok' : ''}>{pct}% covered</span>
          <span className="muted">·</span>
          <span className={insideRatio >= 0.55 ? 'ok' : ''}>{insidePct}% inside</span>
          {succeeded && <span className="ok"> · Done!</span>}
        </div>
        <div className="row">
          {canVibrate && (
            <label className="trace-vibrate">
              <input type="checkbox" checked={vibrateOn} onChange={(e) => setVibrateOn(e.target.checked)} />
              Vibrate when inside
            </label>
          )}
          <button type="button" className="btn small" onClick={reset}>Clear</button>
        </div>
      </div>

      <div className="tracing-stage">
        <canvas
          ref={canvasRef}
          className="tracing-canvas"
          style={{ aspectRatio: `${VIEW_W} / ${VIEW_H}` }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
      </div>

      <p className="tracing-hint muted small">
        Trace the letter. Stay inside the strokes. Cover at least 80% of the letter.
        {canVibrate ? ' Turn on vibration for sensory feedback (works best on Android).' : ' Vibration is not available on this device — visual feedback only.'}
      </p>
    </div>
  );
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
