/**
 * End-to-end test of the sandbox TABLE view with two real browser sessions (desktop teacher + touch phone student).
 *   npm run build && node e2e/table.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { chromium } from 'playwright-core';

const PORT = process.env.E2E_PORT ?? '3101';
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = 'e2e/screenshots'; fs.mkdirSync(SHOTS, { recursive: true });
const server = spawn('node', ['dist/server/index.js'], { env: { ...process.env, PORT, HOST: '127.0.0.1', NODE_ENV: 'production' }, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1500));

let passed = 0;
const ok = (c, m) => { if (!c) throw new Error(`FAILED: ${m}`); passed++; console.log(`  ✓ ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function eventually(fn, msg, timeout = 6000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { try { if (await fn()) return ok(true, msg); } catch { /* retry */ } await sleep(80); }
  throw new Error(`FAILED (timeout): ${msg}`);
}
/** "m|i|t": the visible top card of each pile, read from the accessible labels. */
const tops = (p) => p.locator('.stack-top, .stack-empty').evaluateAll((els) => els.map((e) => /"(.+?)"/.exec(e.getAttribute('aria-label') ?? '')?.[1] ?? '∅').join('|'));
const discards = (p) => p.locator('.table-col').evaluateAll((cols) => cols.map((c) => c.querySelectorAll('.discard-top').length ? /"(.+?)"/.exec(c.querySelector('.discard-top').getAttribute('aria-label'))?.[1] : '∅').join('|'));
const col = (p, i) => p.locator('.table-col').nth(i);

const browser = await chromium.launch();
try {
  const T = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  const S = await (await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 })).newPage();
  const errors = [];
  for (const [n, p] of [['teacher', T], ['student', S]]) { p.on('pageerror', (e) => errors.push(`${n}: ${e.message}`)); p.on('console', (m) => { if (m.type() === 'error') errors.push(`${n}: ${m.text()}`); }); }

  console.log('\n1. Import formatted card sheets and start a game');
  await T.goto(BASE); await T.getByRole('button', { name: 'Create a game' }).click();
  await T.getByRole('radio', { name: /Short vowels/ }).waitFor();
  await T.locator('input[type=file]').setInputFiles(['client/tests/fixtures/skills_1.html', 'client/tests/fixtures/skills_5.html', 'client/tests/fixtures/skills_8.html']);
  await T.getByRole('button', { name: /^Add 3 decks/ }).click();
  await T.getByRole('radio', { name: /lessons 1, 5, 8/ }).check();
  await T.getByRole('button', { name: 'Start game' }).click();
  const code = (await T.getByTestId('room-code').textContent()).trim();
  await S.goto(BASE); await S.getByLabel('Room code').fill(code); await S.getByRole('button', { name: 'Join game' }).click(); await S.getByTestId('student-status').waitFor();
  await T.locator('.stack-top svg').first().waitFor();
  ok((await T.locator('.table-surface').count()) === 1 && (await S.locator('.table-surface').count()) === 1, 'both screens open on the eggshell table');
  ok((await T.evaluate(() => getComputedStyle(document.body).backgroundColor)) === 'rgb(245, 240, 230)', 'page background is eggshell (#f5f0e6)');
  ok((await T.locator('.stack-top').count()) === 3 && (await T.locator('.stack-top svg text').first().getAttribute('font-family')).includes('PlaywriteCO'), 'three face-up stacks drawn with the card formatting');
  const start = await tops(T);
  ok(start === (await tops(S)), `same top cards on both screens (${start})`);
  ok((await discards(T)) === '∅|∅|∅', 'discards start empty');
  await T.screenshot({ path: `${SHOTS}/table-1-teacher.png` });

  console.log('\n2. Teacher taps a pile: card goes to the discard, next card appears (everywhere)');
  const [b0] = start.split('|');
  await col(T, 0).locator('.stack-top').click();
  await eventually(async () => (await discards(T)).startsWith(`${b0}|`), `the "${b0}" card moved to pile 1's discard`);
  await eventually(async () => (await tops(T)) !== start && (await tops(T)) === (await tops(S)), 'the next card is showing, identically on the student phone');
  await eventually(async () => (await discards(S)).startsWith(`${b0}|`), 'student sees the discard pile too');
  ok((await col(T, 0).locator('.count').first().textContent()).includes('left'), 'pile shows how many cards are left');
  await S.screenshot({ path: `${SHOTS}/table-2-student-phone.png` });

  console.log('\n3. Double tap draws only once');
  const before = await tops(T);
  await col(T, 2).locator('.stack-top').dblclick();
  await sleep(600);
  const afterCount = await col(T, 2).locator('.count').nth(1).textContent();
  ok(afterCount.startsWith('1 '), `double tap drew exactly one card (${afterCount.trim()})`);
  ok(before !== (await tops(T)), 'and the next card is showing');

  console.log('\n4. Student cannot draw while the teacher has control');
  const sBefore = await tops(S);
  await col(S, 1).locator('.stack-top').click({ force: true }); await sleep(500);
  ok((await tops(S)) === sBefore && (await tops(T)) === sBefore, 'a student tap changed nothing');
  ok((await S.locator('.table-actions').count()) === 0 && (await S.getByText('Arrange cards').count()) === 0, 'student sees no teacher buttons');

  console.log('\n5. Teacher allows all students: the student can tap too');
  await T.getByLabel(/All students/).check();
  await eventually(async () => (await S.getByTestId('student-status').textContent()).includes('You can move cards'), 'student UI updates immediately');
  await col(S, 0).locator('.stack-top').tap();
  await eventually(async () => (await discards(T)).split('|')[0] !== b0 && (await tops(T)) === (await tops(S)), 'the student tap drew a card on the teacher screen as well');

  console.log('\n6. Undo by tapping the discard');
  const topBefore = (await tops(T)).split('|')[0]; const drawn = (await discards(T)).split('|')[0];
  await col(T, 0).locator('.discard-top').click();
  await eventually(async () => (await tops(T)).split('|')[0] === drawn && (await tops(S)).split('|')[0] === drawn, `"${drawn}" is back on top of pile 1 (it was "${topBefore}")`);

  console.log('\n7. Empty pile → tap to shuffle the discards back in');
  await T.getByLabel(/Teacher only/).check();
  const middle = col(T, 1);
  while ((await middle.locator('.stack-top').count()) > 0) { await middle.locator('.stack-top').click(); await sleep(350); }
  ok((await middle.locator('.stack-empty').count()) === 1, 'the middle pile is empty and says so');
  await middle.locator('.stack-empty').click();
  await eventually(async () => (await middle.locator('.stack-top').count()) === 1 && (await discards(T)).split('|')[1] === '∅', 'discards were shuffled back into the pile');
  await eventually(async () => (await tops(S)) === (await tops(T)), 'student screen matches');

  console.log('\n8. Reset board, then a plain (unformatted) deck shows script letters');
  await T.getByRole('button', { name: /Reset board/ }).click(); await T.getByRole('dialog').getByRole('button', { name: 'Reset board' }).click();
  await eventually(async () => (await discards(T)) === '∅|∅|∅', 'reset cleared every discard');
  await T.getByRole('button', { name: /Change deck/ }).click(); await T.getByRole('radio', { name: /Multi-letter/ }).check(); await T.getByRole('button', { name: 'Use this deck' }).click();
  await eventually(async () => (await T.locator('.stack-top .face-wrap.plain .card-text').count()) === 3, 'plain deck is shown on the table');
  const fs_ = await T.locator('.stack-top .card-text').first().evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
  ok(fs_ > 40, `plain-deck letters are large (${fs_.toFixed(0)}px)`);
  await T.screenshot({ path: `${SHOTS}/table-3-plain-deck.png` });

  console.log('\n9. Arrange view is still available to the teacher');
  await T.getByRole('button', { name: /Arrange cards/ }).click();
  ok((await T.locator('.piles .pile').count()) === 3, 'classic drag-to-arrange board opens');
  await T.getByRole('button', { name: /^🃏 Table/ }).click();

  ok(errors.length === 0, `no browser errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  console.log(`\nAll ${passed} table checks passed.`);
} catch (e) {
  console.error('\n' + (e instanceof Error ? e.message : e)); process.exitCode = 1;
} finally { await browser.close(); server.kill('SIGTERM'); }
