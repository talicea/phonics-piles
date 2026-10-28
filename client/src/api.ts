import { DECK_LIMITS, validateDeck, type Deck, type DeckSummary } from '@shared/index';

/** Empty string = same origin (the default, and what production uses). Set VITE_SERVER_URL only for a split deployment. */
export const SERVER_URL: string = (import.meta.env.VITE_SERVER_URL as string | undefined) ?? '';

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${SERVER_URL}${path}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return (await res.json()) as T;
}

export const fetchDecks = async (): Promise<DeckSummary[]> => (await getJson<{ decks: DeckSummary[] }>('/api/decks')).decks;
export const fetchDeck = (id: string): Promise<Deck> => getJson<Deck>(`/api/decks/${encodeURIComponent(id)}`);
export async function fetchMaxDeckBytes(): Promise<number> {
  try {
    return (await getJson<{ maxDeckBytes: number }>('/api/config')).maxDeckBytes;
  } catch {
    return DECK_LIMITS.defaultMaxBytes;
  }
}

// ---------------------------------------------------------------- uploaded decks live in THIS browser only (MVP)
const CUSTOM_KEY = 'phonics.customDecks.v1';
const MAX_SAVED = 20;

export const customDecks = {
  load(): Deck[] {
    try {
      const raw = localStorage.getItem(CUSTOM_KEY);
      if (!raw) return [];
      const arr: unknown = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      // Re-validate on load: storage is untrusted input too.
      return arr.flatMap((d) => {
        const v = validateDeck(d);
        return v.ok ? [v.deck] : [];
      });
    } catch {
      return [];
    }
  },
  save(deck: Deck): { ok: true } | { ok: false; error: string } {
    try {
      const rest = customDecks.load().filter((d) => d.id !== deck.id);
      const next = [deck, ...rest].slice(0, MAX_SAVED);
      localStorage.setItem(CUSTOM_KEY, JSON.stringify(next));
      return { ok: true };
    } catch {
      return { ok: false, error: 'Could not save the deck in this browser (storage may be full or disabled). You can still use it for this game.' };
    }
  },
  remove(id: string): void {
    try {
      localStorage.setItem(CUSTOM_KEY, JSON.stringify(customDecks.load().filter((d) => d.id !== id)));
    } catch {
      /* ignore */
    }
  },
};
