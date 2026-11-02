/** Loads and validates the built-in decks from disk at startup. A broken built-in deck is a deploy error, so we fail loudly. */
import fs from 'node:fs';
import path from 'node:path';
import { parseDeckJson, summarizeDeck, type Deck, type DeckSummary } from '@shared/index';

export class DeckLibrary {
  private decks = new Map<string, Deck>();

  constructor(dir: string, maxBytes: number) {
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    for (const file of files) {
      const text = fs.readFileSync(path.join(dir, file), 'utf8');
      const result = parseDeckJson(text, maxBytes);
      if (!result.ok) throw new Error(`Built-in deck ${file} is invalid:\n  - ${result.errors.join('\n  - ')}`);
      if (this.decks.has(result.deck.id)) throw new Error(`Duplicate built-in deck id "${result.deck.id}" (${file})`);
      this.decks.set(result.deck.id, result.deck);
    }
  }

  list(): DeckSummary[] {
    return [...this.decks.values()].map(summarizeDeck);
  }
  get(id: string): Deck | undefined {
    return this.decks.get(id);
  }
}
