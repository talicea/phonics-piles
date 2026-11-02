/**
 * Download / parse tracing-practice JSON files named by student.
 * Format is stable so a list saved today can be loaded in a later session.
 */
import type { PracticeCard } from '@shared/index';

export const PRACTICE_FILE_KIND = 'phonics-practice';
export const PRACTICE_FILE_VERSION = 1;

export interface PracticeFile {
  schemaVersion: number;
  kind: typeof PRACTICE_FILE_KIND;
  studentName: string;
  updatedAt: string;
  cards: PracticeCard[];
}

export function buildPracticeFile(studentName: string, cards: PracticeCard[]): PracticeFile {
  return {
    schemaVersion: PRACTICE_FILE_VERSION,
    kind: PRACTICE_FILE_KIND,
    studentName,
    updatedAt: new Date().toISOString(),
    cards: cards.map((c) => ({ ...c })),
  };
}

/** Safe filename fragment from a display name. */
export function practiceFileName(studentName: string): string {
  const slug = studentName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'student';
  return `practice-${slug}.json`;
}

export function downloadPracticeFile(studentName: string, cards: PracticeCard[]): void {
  const file = buildPracticeFile(studentName, cards);
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = practiceFileName(studentName);
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000); // revoking at once can cancel the save in Safari
}

export type ParsePracticeResult =
  | { ok: true; file: PracticeFile }
  | { ok: false; message: string };

/** Validate a user-selected JSON file as a practice list. */
export function parsePracticeFile(raw: unknown): ParsePracticeResult {
  if (!raw || typeof raw !== 'object') return { ok: false, message: 'File is not a JSON object.' };
  const o = raw as Record<string, unknown>;
  if (o.kind !== PRACTICE_FILE_KIND) {
    return { ok: false, message: 'This is not a Phonics Piles practice file.' };
  }
  if (o.schemaVersion !== PRACTICE_FILE_VERSION) {
    return { ok: false, message: `Unsupported practice file version (${String(o.schemaVersion)}).` };
  }
  if (typeof o.studentName !== 'string' || !o.studentName.trim()) {
    return { ok: false, message: 'Practice file is missing a student name.' };
  }
  if (!Array.isArray(o.cards)) return { ok: false, message: 'Practice file is missing a cards list.' };
  const cards: PracticeCard[] = [];
  const seen = new Set<string>();
  for (const item of o.cards.slice(0, 40)) {
    if (!item || typeof item !== 'object') continue;
    const c = item as Record<string, unknown>;
    if (typeof c.id !== 'string' || !c.id || typeof c.text !== 'string' || !c.text) continue;
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    const entry: PracticeCard = {
      id: c.id,
      text: String(c.text).slice(0, 12),
      addedAt: typeof c.addedAt === 'number' ? c.addedAt : Date.now(),
    };
    if (typeof c.cat === 'string') entry.cat = c.cat.slice(0, 4);
    if (typeof c.count === 'string') entry.count = c.count.slice(0, 4);
    if (typeof c.lesson === 'number' && Number.isFinite(c.lesson)) entry.lesson = Math.max(0, Math.min(99, Math.floor(c.lesson)));
    if (typeof c.sourceDeckId === 'string') entry.sourceDeckId = c.sourceDeckId.slice(0, 64);
    cards.push(entry);
  }
  return {
    ok: true,
    file: {
      schemaVersion: PRACTICE_FILE_VERSION,
      kind: PRACTICE_FILE_KIND,
      studentName: o.studentName.trim().slice(0, 24),
      updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : new Date().toISOString(),
      cards,
    },
  };
}

/** A practice list is at most 40 tiny cards; anything bigger than this is not one. */
export const MAX_PRACTICE_FILE_BYTES = 200 * 1024;

export async function readPracticeFileFromInput(file: File): Promise<ParsePracticeResult> {
  if (file.size > MAX_PRACTICE_FILE_BYTES) return { ok: false, message: 'That file is too large to be a practice list.' };
  try {
    const text = await file.text();
    const json = JSON.parse(text) as unknown;
    return parsePracticeFile(json);
  } catch {
    return { ok: false, message: 'Could not read that file as JSON.' };
  }
}
