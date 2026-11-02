/**
 * Read-only live mirror of a student's tracing session (teacher side).
 * Receives normalised points [x0,y0,...] in 0..1 space and draws them on a skills-style card.
 */
import { useEffect, useRef } from 'react';
import { CARD_GEOMETRY, DEFAULT_ASPECT_RATIO } from '@shared/index';

const VIEW_W = CARD_GEOMETRY.viewWidth;
const VIEW_H = VIEW_W / DEFAULT_ASPECT_RATIO;
const LINE_YS = [110, 425, 721, 1037];
const BASELINE = 721;
const FONT_PX = 592;

const CAT_COLORS: Record<string, string> = {
  V: '#990000', C: '#000000', DG: '#0b1a6b', P: '#c21f1f',
  B: '#2f5fd9', T: '#4b1a7a', DP: '#ff4f9a',
};

export interface LiveTraceSession {
  participantId: string;
  name: string;
  text: string;
  cat?: string;
  count?: string;
  lesson?: number;
  /** Flattened normalised points accumulated so far. */
  points: number[];
}

export function LiveTraceMirror({ session }: { session: LiveTraceSession }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ink = CAT_COLORS[(session.cat ?? 'C').toUpperCase()] ?? '#000000';

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    if (cssW < 10) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const sx = cssW / VIEW_W;
    const sy = cssH / VIEW_H;

    ctx.clearRect(0, 0, cssW, cssH);
    ctx.fillStyle = '#fffdf8';
    roundRect(ctx, 0, 0, cssW, cssH, 10);
    ctx.fill();

    // Lines
    ctx.strokeStyle = ink;
    ctx.globalAlpha = 0.3;
    ctx.lineWidth = Math.max(1.5, 14 * sy);
    for (const y of LINE_YS) {
      const yy = y * sy;
      ctx.beginPath();
      ctx.moveTo(cssW * 0.06, yy);
      ctx.lineTo(cssW * 0.94, yy);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Guide letter
    ctx.save();
    ctx.translate(cssW / 2, BASELINE * sy);
    ctx.font = `400 ${FONT_PX * sy}px PlaywriteCO, cursive`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(1.5, FONT_PX * sy * 0.04);
    ctx.strokeStyle = ink;
    ctx.globalAlpha = 0.2;
    ctx.strokeText(session.text, 0, 0);
    ctx.fillStyle = ink;
    ctx.globalAlpha = 0.1;
    ctx.fillText(session.text, 0, 0);
    ctx.restore();
    ctx.globalAlpha = 1;

    // Live stroke
    const pts = session.points;
    if (pts.length >= 4) {
      ctx.beginPath();
      ctx.strokeStyle = '#166534';
      ctx.lineWidth = Math.max(3, FONT_PX * sy * 0.06);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.moveTo((pts[0] ?? 0) * cssW, (pts[1] ?? 0) * cssH);
      for (let i = 2; i < pts.length; i += 2) {
        ctx.lineTo((pts[i] ?? 0) * cssW, (pts[i + 1] ?? 0) * cssH);
      }
      ctx.stroke();
    }
  }, [session, ink]);

  return (
    <div className="live-trace" data-testid={`live-trace-${session.participantId}`}>
      <p className="live-trace-label">
        <strong>{session.name}</strong> is tracing <span className="chip">{session.text}</span>
      </p>
      <canvas ref={canvasRef} className="live-trace-canvas" style={{ aspectRatio: `${VIEW_W} / ${VIEW_H}` }} />
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
