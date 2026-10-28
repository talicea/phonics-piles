import { useCallback, useEffect, useRef, useState } from 'react';
import { DECK_LIMITS, parseDeckJson, type Deck, type DeckSummary } from '@shared/index';
import { customDecks, fetchDeck, fetchDecks, fetchMaxDeckBytes } from '../api';

export type DeckChoice = { deckId: string } | { deck: Deck };

type Selection = { kind: 'builtin'; id: string } | { kind: 'custom'; id: string } | null;

function DeckPreview({ deck }: { deck: Deck }) {
  return (
    <div className="preview" aria-label={`Preview of ${deck.name}`}>
      {deck.piles.map((p) => (
        <div key={p.id} className="preview-pile">
          <strong>{p.label}</strong> <span className="count">({p.cards.length})</span>
          <div className="chips">
            {p.cards.map((c) => <span className="chip" key={c.id}>{c.faceDown ? `${c.text} (face-down)` : c.text}</span>)}
          </div>
        </div>
      ))}
    </div>
  );
}

function RuleBadges({ rules }: { rules: Deck['rules'] }) {
  const items = [
    rules.allowCrossPileMoves ? 'Cards can change piles' : 'Cards stay in their pile',
    ...(rules.allowFlip ? ['Flip cards'] : []),
    ...(rules.initialShuffle ? ['Starts shuffled'] : []),
  ];
  return <p className="rules">{items.join(' · ')}</p>;
}

export function DeckPicker({ confirmLabel, busy, offline = false, onChoose, onCancel }: { confirmLabel: string; busy: boolean; offline?: boolean; onChoose(choice: DeckChoice): void; onCancel?(): void }) {
  const [builtins, setBuiltins] = useState<DeckSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [custom, setCustom] = useState<Deck[]>(() => customDecks.load());
  const [sel, setSel] = useState<Selection>(null);
  const [preview, setPreview] = useState<Deck | null>(null);
  const [uploadErrors, setUploadErrors] = useState<string[]>([]);
  const [uploadNote, setUploadNote] = useState<string | null>(null);
  const [maxBytes, setMaxBytes] = useState<number>(DECK_LIMITS.defaultMaxBytes);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    setLoadError(null);
    fetchDecks().then((d) => { setBuiltins(d); setSel((cur) => cur ?? (d[0] ? { kind: 'builtin', id: d[0].id } : null)); }).catch(() => setLoadError('Could not load the deck list. Is the server running?'));
  }, []);
  useEffect(() => { load(); void fetchMaxDeckBytes().then(setMaxBytes); }, [load]);

  // Load the full deck for the preview of whatever is selected.
  useEffect(() => {
    if (!sel) { setPreview(null); return; }
    if (sel.kind === 'custom') { setPreview(custom.find((d) => d.id === sel.id) ?? null); return; }
    let cancelled = false;
    fetchDeck(sel.id).then((d) => { if (!cancelled) setPreview(d); }).catch(() => { if (!cancelled) setPreview(null); });
    return () => { cancelled = true; };
  }, [sel, custom]);

  const onFile = async (file: File | undefined) => {
    setUploadErrors([]); setUploadNote(null);
    if (!file) return;
    if (file.size > maxBytes) { setUploadErrors([`File is too large (${(file.size / 1024).toFixed(1)} KB). The limit is ${(maxBytes / 1024).toFixed(0)} KB.`]); return; }
    let text: string;
    try { text = await file.text(); } catch { setUploadErrors(['Could not read that file.']); return; }
    const result = parseDeckJson(text, maxBytes);
    if (!result.ok) { setUploadErrors(result.errors); return; }
    const saved = customDecks.save(result.deck);
    setCustom((cur) => [result.deck, ...cur.filter((d) => d.id !== result.deck.id)]);
    setSel({ kind: 'custom', id: result.deck.id });
    setUploadNote(saved.ok ? `Added “${result.deck.name}” to this browser.` : saved.error);
  };

  const choose = () => {
    if (!sel) return;
    if (sel.kind === 'builtin') onChoose({ deckId: sel.id });
    else { const d = custom.find((x) => x.id === sel.id); if (d) onChoose({ deck: d }); }
  };

  const key = (s: Selection) => (s ? `${s.kind}:${s.id}` : '');

  return (
    <div className="deck-picker">
      <fieldset className="deck-list">
        <legend>Choose a deck</legend>
        {loadError && <p className="error" role="alert">{loadError} <button type="button" className="btn small" onClick={load}>Retry</button></p>}
        {!builtins && !loadError && <p aria-busy="true">Loading decks…</p>}
        {builtins?.map((d) => (
          <label className={`deck-option${key(sel) === `builtin:${d.id}` ? ' chosen' : ''}`} key={d.id}>
            <input type="radio" name="deck" checked={key(sel) === `builtin:${d.id}`} onChange={() => setSel({ kind: 'builtin', id: d.id })} />
            <span className="deck-text">
              <strong>{d.name}</strong>
              <span className="muted">{d.description}</span>
              <span className="muted small">{d.cardCount} cards · {d.pileLabels.join(' / ')}</span>
            </span>
          </label>
        ))}
        {custom.length > 0 && <p className="subhead">Your uploaded decks (saved in this browser)</p>}
        {custom.map((d) => (
          <div className="deck-row" key={d.id}>
            <label className={`deck-option${key(sel) === `custom:${d.id}` ? ' chosen' : ''}`}>
              <input type="radio" name="deck" checked={key(sel) === `custom:${d.id}`} onChange={() => setSel({ kind: 'custom', id: d.id })} />
              <span className="deck-text">
                <strong>{d.name}</strong>
                <span className="muted">{d.description || 'Uploaded deck'}</span>
                <span className="muted small">{d.piles.reduce((n, p) => n + p.cards.length, 0)} cards · {d.piles.map((p) => p.label).join(' / ')}</span>
              </span>
            </label>
            <button type="button" className="btn small" aria-label={`Remove ${d.name} from this browser`} onClick={() => { customDecks.remove(d.id); setCustom(customDecks.load()); if (sel?.kind === 'custom' && sel.id === d.id) setSel(builtins?.[0] ? { kind: 'builtin', id: builtins[0].id } : null); }}>Remove</button>
          </div>
        ))}
      </fieldset>

      <div className="upload">
        <h3>Upload your own deck</h3>
        <p className="muted small">A JSON file with three piles of cards. Maximum {(maxBytes / 1024).toFixed(0)} KB. <a href="/sample-deck.json" download="sample-deck.json">Download an example</a>.</p>
        <label className="btn file-btn">
          Choose a JSON file…
          <input ref={fileRef} type="file" accept=".json,application/json" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; /* allow re-selecting the same (fixed) file */ void onFile(f); }} />
        </label>
        {uploadNote && <p className="ok" role="status">{uploadNote}</p>}
        {uploadErrors.length > 0 && (
          <div className="error" role="alert">
            <strong>That deck can’t be used:</strong>
            <ul>{uploadErrors.map((e, i) => <li key={i}>{e}</li>)}</ul>
          </div>
        )}
      </div>

      {preview && (
        <div className="preview-wrap">
          <h3>{preview.name}</h3>
          <RuleBadges rules={preview.rules} />
          <DeckPreview deck={preview} />
        </div>
      )}

      <div className="row end">
        {onCancel && <button type="button" className="btn" onClick={onCancel}>Cancel</button>}
        <button type="button" className="btn primary big" disabled={!sel || busy || offline} onClick={choose}>{offline ? 'Waiting for connection…' : busy ? 'Working…' : confirmLabel}</button>
      </div>
    </div>
  );
}
