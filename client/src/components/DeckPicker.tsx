import { useCallback, useEffect, useRef, useState } from 'react';
import { DECK_LIMITS, buildDeckMeta, parseDeckJson, resolveCardStyle, type Deck, type DeckSummary } from '@shared/index';
import { parseCardsHtml, type ParsedFile } from '../import/htmlCards';
import { CardFace } from './CardFace';
import { ImportDialog } from './ImportDialog';
import { customDecks, fetchDeck, fetchDecks, fetchMaxDeckBytes } from '../api';

export type DeckChoice = { deckId: string } | { deck: Deck };

type Selection = { kind: 'builtin'; id: string } | { kind: 'custom'; id: string } | null;

function DeckPreview({ deck }: { deck: Deck }) {
  const meta = buildDeckMeta(deck);
  return (
    <div className="preview" aria-label={`Preview of ${deck.name}`}>
      {deck.piles.map((p) => (
        <div key={p.id} className="preview-pile">
          <strong>{p.label}</strong> <span className="count">({p.cards.length})</span>
          {meta.styled ? (
            // Designed decks: show the real card faces so the teacher can check the formatting.
            <div className="preview-faces" style={{ ['--aspect' as string]: meta.aspectRatio ?? 0.666 }}>
              {p.cards.map((c) => <div className="preview-face" key={c.id} title={c.text}><CardFace text={c.text} faceDown={false} deck={meta} cardId={c.id} /></div>)}
            </div>
          ) : (
            <div className="chips">
              {p.cards.map((c) => <span className="chip" key={c.id} style={{ borderLeft: `8px solid ${resolveCardStyle(deck.cardStyle, c.style).textColor}` }}>{c.faceDown ? `${c.text} (face-down)` : c.text}</span>)}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function downloadDeckJson(deck: Deck) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(deck, null, 2) + '\n'], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url; a.download = `${deck.id}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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
  const [importing, setImporting] = useState<{ files: ParsedFile[]; problems: string[] } | null>(null);

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

  const MAX_HTML_BYTES = 5 * 1024 * 1024;

  /** JSON decks are validated and added; HTML card sheets open the import review dialog. */
  const onFiles = async (list: File[]) => {
    setUploadErrors([]); setUploadNote(null);
    if (list.length === 0) return;
    const errors: string[] = [];
    const added: Deck[] = [];
    const htmlFiles: ParsedFile[] = [];
    for (const file of list) {
      const isHtml = /\.html?$/i.test(file.name) || file.type === 'text/html';
      if (isHtml) {
        if (file.size > MAX_HTML_BYTES) { errors.push(`${file.name}: file is too large to import (limit 5 MB).`); continue; }
        try {
          const doc = new DOMParser().parseFromString(await file.text(), 'text/html'); // inert: scripts in the file never run
          htmlFiles.push(parseCardsHtml(doc, file.name));
        } catch { errors.push(`${file.name}: could not be read as an HTML card sheet.`); }
        continue;
      }
      if (file.size > maxBytes) { errors.push(`${file.name}: file is too large (${(file.size / 1024).toFixed(1)} KB). The limit is ${(maxBytes / 1024).toFixed(0)} KB.`); continue; }
      let text: string;
      try { text = await file.text(); } catch { errors.push(`${file.name}: could not read that file.`); continue; }
      const result = parseDeckJson(text, maxBytes);
      if (!result.ok) { errors.push(...result.errors.map((e) => (list.length > 1 ? `${file.name}: ${e}` : e))); continue; }
      added.push(result.deck);
    }
    if (added.length) {
      let note: string | null = null;
      for (const d of added) { const saved = customDecks.save(d); if (!saved.ok) note = saved.error; }
      setCustom(customDecks.load());
      const last = added[added.length - 1] as Deck;
      setSel({ kind: 'custom', id: last.id });
      setUploadNote(note ?? (added.length === 1 ? `Added “${last.name}” to this browser.` : `Added ${added.length} decks to this browser.`));
    }
    if (htmlFiles.length) {
      htmlFiles.sort((a, b) => (a.lesson ?? 1e9) - (b.lesson ?? 1e9) || a.fileName.localeCompare(b.fileName, undefined, { numeric: true }));
      setImporting({ files: htmlFiles, problems: errors });
    } else setUploadErrors(errors);
  };

  const finishImport = (decks: Deck[]) => {
    let note: string | null = null;
    for (const d of decks) { const saved = customDecks.save(d); if (!saved.ok) note = saved.error; }
    setCustom(customDecks.load());
    const last = decks[decks.length - 1];
    if (last) setSel({ kind: 'custom', id: last.id });
    setUploadNote(note ?? `Added ${decks.length} deck${decks.length === 1 ? '' : 's'} from your card sheets. Use “Download JSON” to keep a copy.`);
    setImporting(null);
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
            <button type="button" className="btn small" aria-label={`Download ${d.name} as a JSON file`} onClick={() => downloadDeckJson(d)}>Download JSON</button>
            <button type="button" className="btn small" aria-label={`Remove ${d.name} from this browser`} onClick={() => { customDecks.remove(d.id); setCustom(customDecks.load()); if (sel?.kind === 'custom' && sel.id === d.id) setSel(builtins?.[0] ? { kind: 'builtin', id: builtins[0].id } : null); }}>Remove</button>
          </div>
        ))}
      </fieldset>

      <div className="upload">
        <h3>Upload your own deck</h3>
        <p className="muted small">Choose <strong>JSON deck files</strong> (max {(maxBytes / 1024).toFixed(0)} KB each; <a href="/sample-deck.json" download="sample-deck.json">download an example</a>) or <strong>HTML card sheets</strong> such as <code>skills_1.html</code> — you can pick several at once and they are converted to decks for you.</p>
        <label className="btn file-btn">
          Choose files…
          <input ref={fileRef} type="file" multiple accept=".json,.html,.htm,application/json,text/html" onChange={(e) => { const fs = Array.from(e.target.files ?? []); e.target.value = ''; /* allow re-selecting the same (fixed) file */ void onFiles(fs); }} />
        </label>
        {uploadNote && <p className="ok" role="status">{uploadNote}</p>}
        {uploadErrors.length > 0 && (
          <div className="error" role="alert">
            <strong>That deck can’t be used:</strong>
            <ul>{uploadErrors.map((e, i) => <li key={i}>{e}</li>)}</ul>
          </div>
        )}
      </div>

      {importing && <ImportDialog files={importing.files} problems={importing.problems} onImport={finishImport} onCancel={() => setImporting(null)} />}

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
