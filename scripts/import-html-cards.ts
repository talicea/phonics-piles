/**
 * Command-line version of the in-app HTML importer, for people who have Node installed.
 *   npm run import:html -- <outDir> <file1.html> [file2.html ...] [--single]
 * Writes one JSON deck per lesson (cumulative) or one combined deck with --single.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseHTML } from 'linkedom';
import { buildDecks, parseCardsHtml, suggestPlacements } from '../client/src/import/htmlCards';

const args = process.argv.slice(2);
const single = args.includes('--single');
const [outDir, ...inputs] = args.filter((a) => a !== '--single');
if (!outDir || inputs.length === 0) { console.error('Usage: tsx scripts/import-html-cards.ts <outDir> <files...> [--single]'); process.exit(1); }

const files = inputs
  .map((f) => parseCardsHtml(parseHTML(fs.readFileSync(f, 'utf8')).document as unknown as Document, path.basename(f)))
  .sort((a, b) => (a.lesson ?? 0) - (b.lesson ?? 0));
for (const f of files) {
  console.log(`${f.fileName}: ${f.cards.length} cards, lesson ${f.lesson ?? '?'}`);
  for (const w of f.warnings) console.log(`   ! ${w}`);
}
const placement = suggestPlacements(files);
const { decks, skipped, notes } = buildDecks(files, { pileLabels: ['Beginning sound', 'Middle sound', 'Ending sound'], placement, cumulative: !single });
fs.mkdirSync(outDir, { recursive: true });
for (const d of decks) { fs.writeFileSync(path.join(outDir, `${d.id}.json`), JSON.stringify(d, null, 2) + '\n'); console.log(`wrote ${d.id}.json (${d.name})`); }
for (const s of skipped) console.log(`SKIPPED ${s.name}: ${s.reasons.join('; ')}`);
for (const n of notes) console.log(n);
