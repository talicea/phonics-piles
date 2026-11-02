import { describe, expect, it } from 'vitest';
import { buildPracticeFile, parsePracticeFile, practiceFileName } from '../src/practiceFile';

const good = () => ({ schemaVersion: 1, kind: 'phonics-practice', studentName: 'Maya', updatedAt: '2026-10-29T00:00:00Z', cards: [{ id: 'a', text: 'sh', lesson: 3, addedAt: 5 }] });

describe('practice files', () => {
  it('round-trips: what we save can be loaded again', () => {
    const f = buildPracticeFile('Maya', [{ id: 'a', text: 'sh', lesson: 3, addedAt: 5, sourceDeckId: 'd' }]);
    expect(f).toMatchObject({ schemaVersion: 1, kind: 'phonics-practice', studentName: 'Maya' });
    const r = parsePracticeFile(JSON.parse(JSON.stringify(f)));
    expect(r.ok && r.file.cards).toEqual([{ id: 'a', text: 'sh', lesson: 3, addedAt: 5, sourceDeckId: 'd' }]);
  });

  it('rejects things that are not practice files', () => {
    for (const bad of [null, 'x', 42, [], { ...good(), kind: 'deck' }, { ...good(), schemaVersion: 2 }, { ...good(), studentName: '  ' }, { ...good(), studentName: 5 }, { ...good(), cards: 'no' }]) {
      expect(parsePracticeFile(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('cleans what it keeps: caps at 40, drops duplicates and junk, shortens long values', () => {
    const cards = [
      ...Array.from({ length: 60 }, (_, i) => ({ id: `c${i}`, text: 'a' })),
      { id: 'c0', text: 'dup' }, null, 7, { id: '', text: 'x' }, { id: 'z', text: '' },
    ];
    const r = parsePracticeFile({ ...good(), cards });
    expect(r.ok && r.file.cards).toHaveLength(40);
    const r2 = parsePracticeFile({ ...good(), studentName: 'n'.repeat(80), cards: [{ id: 'a', text: 'abcdefghijklmnopqrstuvwxyz', cat: 'LONGCAT', lesson: 500 }, { id: 'a', text: 'dup' }] });
    expect(r2.ok && r2.file.studentName).toHaveLength(24);
    expect(r2.ok && r2.file.cards).toHaveLength(1);
    expect(r2.ok && r2.file.cards[0]).toMatchObject({ text: 'abcdefghijkl', cat: 'LONG', lesson: 99 });
  });

  it('makes safe file names from student names', () => {
    expect(practiceFileName('Maya')).toBe('practice-maya.json');
    expect(practiceFileName("../../Maya O'Neil")).toBe('practice-maya-o-neil.json');
    expect(practiceFileName('   ')).toBe('practice-student.json');
    expect(practiceFileName('日本語')).toBe('practice-student.json');
    expect(practiceFileName('x'.repeat(100)).length).toBeLessThanOrEqual('practice-.json'.length + 40);
  });
});
