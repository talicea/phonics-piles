import { useMemo, useState } from 'react';
import type { Deck } from '@shared/index';
import { PLACEMENT_LABELS, buildDecks, colorGroups, formatLessons, suggestPlacements, type ParsedFile, type Placement } from '../import/htmlCards';
import { Modal } from './common';

/** Review step for importing printable card sheets (HTML): the teacher confirms which pile each kind of card belongs in. */
export function ImportDialog({ files, problems, onImport, onCancel }: { files: ParsedFile[]; problems: string[]; onImport(decks: Deck[]): void; onCancel(): void }) {
  const groups = useMemo(() => colorGroups(files), [files]);
  const lessons = useMemo(() => [...new Set(files.flatMap((f) => f.cards.map((c) => c.lesson ?? 0)))].filter((n) => n > 0), [files]);
  const [placement, setPlacement] = useState<Record<string, Placement>>(() => suggestPlacements(files));
  const [labels, setLabels] = useState<[string, string, string]>(['Beginning sound', 'Middle sound', 'Ending sound']);
  const [cumulative, setCumulative] = useState(lessons.length > 1);
  const result = useMemo(() => buildDecks(files, { pileLabels: labels, placement, cumulative }), [files, labels, placement, cumulative]);
  const cardCount = files.reduce((n, f) => n + f.cards.length, 0);
  const warnings = files.flatMap((f) => f.warnings.map((w) => `${f.fileName}: ${w}`));
  const count = (d: Deck) => d.piles.reduce((n, p) => n + p.cards.length, 0);

  return (
    <Modal title="Import card sheets" wide onClose={onCancel}>
      <p>
        Read <strong>{cardCount} card{cardCount === 1 ? '' : 's'}</strong> from <strong>{files.length} file{files.length === 1 ? '' : 's'}</strong>
        {lessons.length > 0 && <> (lessons {formatLessons(lessons)})</>}. Fonts, colours, outlines, borders, corner marks and card shape are kept.
      </p>
      {problems.length > 0 && <div className="error" role="alert"><strong>Some files could not be read:</strong><ul>{problems.map((e, i) => <li key={i}>{e}</li>)}</ul></div>}
      {warnings.length > 0 && <div className="error" role="status"><strong>Notes:</strong><ul>{warnings.map((e, i) => <li key={i}>{e}</li>)}</ul></div>}

      <fieldset className="import-groups">
        <legend>Which pile does each kind of card go in?</legend>
        <p className="muted small">Cards are grouped by text colour. These are suggestions based on the cards — please check them. A card can go in more than one pile.</p>
        {groups.map((g) => (
          <div className="import-row" key={g.color}>
            <span className="chip swatch" style={{ borderColor: g.color, color: g.color }} aria-hidden="true">■</span>
            <label className="import-label" htmlFor={`pl-${g.color}`}>
              <span><strong>{g.color}</strong> <span className="muted small">{g.texts.length} card{g.texts.length === 1 ? '' : 's'}: {g.texts.join(' ')}</span></span>
            </label>
            <select id={`pl-${g.color}`} value={placement[g.color] ?? 'be'} onChange={(e) => setPlacement((p) => ({ ...p, [g.color]: e.target.value as Placement }))}>
              {(Object.keys(PLACEMENT_LABELS) as Placement[]).map((k) => <option key={k} value={k}>{PLACEMENT_LABELS[k]}</option>)}
            </select>
          </div>
        ))}
      </fieldset>

      <fieldset className="import-labels">
        <legend>Pile names</legend>
        <div className="row">
          {labels.map((l, i) => (
            <div key={i} className="grow">
              <label htmlFor={`pn-${i}`}>Pile {i + 1}</label>
              <input id={`pn-${i}`} value={l} maxLength={40} onChange={(e) => setLabels((cur) => cur.map((x, j) => (j === i ? e.target.value : x)) as [string, string, string])} />
            </div>
          ))}
        </div>
      </fieldset>

      {lessons.length > 1 && (
        <label className="check"><input type="checkbox" checked={cumulative} onChange={(e) => setCumulative(e.target.checked)} /> <span>Make a deck for each lesson step (lesson 1, lessons 1–2, lessons 1–3 …) instead of one deck with everything</span></label>
      )}

      <div className="import-result" aria-live="polite">
        <strong>{result.decks.length === 0 ? 'No decks can be made yet' : `This will add ${result.decks.length} deck${result.decks.length === 1 ? '' : 's'}:`}</strong>
        <ul>{result.decks.map((d) => <li key={d.id}>{d.name} <span className="muted small">— {count(d)} cards ({d.piles.map((p) => p.cards.length).join(' / ')})</span></li>)}</ul>
        {result.skipped.length > 0 && <div className="error" role="alert"><strong>Skipped:</strong><ul>{result.skipped.map((s) => <li key={s.name}>{s.name}: {s.reasons.join('; ')}</li>)}</ul></div>}
      </div>

      <div className="row end">
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        <button type="button" className="btn primary big" disabled={result.decks.length === 0} onClick={() => onImport(result.decks)}>Add {result.decks.length || ''} deck{result.decks.length === 1 ? '' : 's'}</button>
      </div>
    </Modal>
  );
}
