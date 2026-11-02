import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ConnStatus } from '../hooks/useRoom';

const CONN_TEXT: Record<ConnStatus, { icon: string; text: string }> = {
  online: { icon: '●', text: 'Connected' },
  connecting: { icon: '◌', text: 'Connecting…' },
  reconnecting: { icon: '↻', text: 'Reconnecting…' },
  offline: { icon: '✕', text: 'Offline' },
};

/** Status is shown with an icon AND words, never colour alone. */
export function ConnectionBadge({ status }: { status: ConnStatus }) {
  const c = CONN_TEXT[status];
  return (
    <span className={`conn conn-${status}`} role="status" aria-live="polite">
      <span aria-hidden="true">{c.icon}</span> {c.text}
    </span>
  );
}

export function Toasts({ items, onDismiss }: { items: { id: number; text: string }[]; onDismiss(id: number): void }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((t) => (
        <div className="toast" key={t.id}>
          <span>{t.text}</span>
          <button type="button" className="toast-x" aria-label="Dismiss message" onClick={() => onDismiss(t.id)}>×</button>
        </div>
      ))}
    </div>
  );
}

/** Native <dialog>: focus is trapped, Esc closes, and the page behind is inert. */
export function Modal({ title, children, onClose, wide }: { title: string; children: ReactNode; onClose(): void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => { if (d?.open) d.close(); };
  }, []);
  return (
    <dialog ref={ref} className={`modal${wide ? ' wide' : ''}`} aria-labelledby="modal-title" onCancel={(e) => { e.preventDefault(); onClose(); }} onClick={(e) => { if (e.target === ref.current) onClose(); }}>
      <div className="modal-body">
        <h2 id="modal-title">{title}</h2>
        {children}
      </div>
    </dialog>
  );
}

export function ConfirmDialog(p: { title: string; message: string; confirmLabel: string; danger?: boolean; busy?: boolean; onConfirm(): void; onCancel(): void }) {
  return (
    <Modal title={p.title} onClose={p.onCancel}>
      <p>{p.message}</p>
      <div className="row end">
        <button type="button" className="btn" onClick={p.onCancel} autoFocus>Cancel</button>
        <button type="button" className={`btn ${p.danger ? 'danger' : 'primary'}`} disabled={p.busy} onClick={p.onConfirm}>{p.confirmLabel}</button>
      </div>
    </Modal>
  );
}

/** Copy with the async clipboard API, falling back to a hidden textarea for older / non-secure contexts. */
export function CopyButton({ text, label, onCopied }: { text: string; label: string; onCopied?(msg: string): void }) {
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const copy = async () => {
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch {
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      ta.remove();
    }
    setDone(ok);
    onCopied?.(ok ? 'Copied!' : 'Could not copy. Select the text and copy it manually.');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setDone(false), 1800);
  };
  return <button type="button" className="btn" onClick={() => void copy()}>{done ? '✓ Copied' : label}</button>;
}

export type BoardViewMode = 'table' | 'arrange';

/** Table (tap to draw) vs Arrange (drag cards between piles). Only shown to people who can move cards. */
export function ViewToggle({ mode, onChange }: { mode: BoardViewMode; onChange(m: BoardViewMode): void }) {
  return (
    <div className="view-toggle" role="group" aria-label="Board view">
      <button type="button" className={`btn small${mode === 'table' ? ' on' : ''}`} aria-pressed={mode === 'table'} onClick={() => onChange('table')}>🃏 Table</button>
      <button type="button" className={`btn small${mode === 'arrange' ? ' on' : ''}`} aria-pressed={mode === 'arrange'} onClick={() => onChange('arrange')}>✋ Arrange cards</button>
    </div>
  );
}
