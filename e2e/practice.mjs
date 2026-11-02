/**
 * End-to-end test of Tracing Practice with two real browser sessions (desktop teacher + touch phone student).
 *   npm run build && node e2e/practice.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { chromium } from 'playwright-core';

const PORT = process.env.E2E_PORT ?? '3102';
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
const coverage = async (p) => parseInt(await p.locator('.tracing-progress span').first().textContent(), 10);

/** Scribble over the middle of the tracing canvas (where the letter is) with the mouse. */
async function scribble(page, from = 0.2, to = 0.8) {
  const b = await page.locator('.tracing-canvas').boundingBox();
  await page.mouse.move(b.x + b.width * from, b.y + b.height * 0.5);
  await page.mouse.down();
  for (let row = 0; row < 14; row++) {
    const y = b.y + b.height * (0.3 + row * 0.03);
    await page.mouse.move(b.x + b.width * (row % 2 ? from : to), y, { steps: 6 });
  }
}

const browser = await chromium.launch();
try {
  const T = await (await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true })).newPage();
  const sCtx = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const S = await sCtx.newPage();
  const errors = [];
  for (const [n, p] of [['teacher', T], ['student', S]]) { p.on('pageerror', (e) => errors.push(`${n}: ${e.message}`)); p.on('console', (m) => { if (m.type() === 'error') errors.push(`${n}: ${m.text()}`); }); }

  console.log('\n1. Teacher marks a card for a student');
  await T.goto(BASE); await T.getByRole('button', { name: 'Create a game' }).click();
  await T.getByRole('radio', { name: /Short vowels/ }).waitFor(); await T.getByRole('button', { name: 'Start game' }).click();
  const code = (await T.getByTestId('room-code').textContent()).trim();
  await S.goto(BASE); await S.getByLabel('Room code').fill(code); await S.getByLabel(/Your name/).fill('Ada'); await S.getByRole('button', { name: 'Join game' }).click();
  await S.getByTestId('student-status').waitFor();
  await T.getByText('Tracing practice lists').click();
  await T.getByRole('button', { name: /^Mark “b”/ }).first().click();
  await S.locator('.practice-chip').first().waitFor();
  ok((await S.locator('.practice-chip').first().textContent()).trim() === 'b', 'student sees "b" on their practice list');
  ok((await T.locator('.practice-lists li').first().textContent()).includes('b'), 'teacher sees it in the list too');

  console.log('\n2. Student traces; the teacher watches live');
  await S.locator('.practice-chip').first().click();
  await S.locator('.tracing-canvas').waitFor(); await S.waitForTimeout(800); // font + mask
  await scribble(S);
  const cov = await coverage(S);
  ok(cov > 0, `student sees progress (${cov}% covered)`);
  await T.locator('[data-testid^="live-trace-"]').waitFor({ timeout: 5000 });
  ok((await T.locator('[data-testid^="live-trace-"]').first().textContent()).includes('Ada is tracing'), 'teacher sees "Ada is tracing b"');
  await eventually(() => T.locator('.live-trace-canvas').first().evaluate((c) => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; for (let i = 3; i < d.length; i += 4) if (d[i] > 0 && d[i - 3] < 80 && d[i - 2] > 80 && d[i - 1] < 120) return true; return false; }), 'the teacher\'s mirror shows the student\'s green stroke');
  await T.screenshot({ path: `${SHOTS}/practice-1-teacher-mirror.png` });
  await S.screenshot({ path: `${SHOTS}/practice-2-student-tracing.png` });
  await S.mouse.up();

  console.log('\n3. Progress survives other things happening in the room');
  const before = await coverage(S);
  await T.locator('.table-col').nth(1).locator('.stack-top').click(); // a board update re-renders the student screen
  await S.waitForTimeout(700);
  await T.locator('.table-col').nth(2).locator('.stack-top').click();
  await S.waitForTimeout(700);
  ok((await coverage(S)) === before && before > 0, `the student's drawing was not wiped by a board update (still ${before}%)`);

  console.log('\n4. The list survives the teacher changing the deck');
  await T.getByRole('button', { name: /Change deck/ }).click(); await T.getByRole('radio', { name: /Multi-letter/ }).check(); await T.getByRole('button', { name: 'Use this deck' }).click();
  await T.getByText(/Deck changed for everyone/).waitFor();
  await sleep(600);
  ok((await S.locator('.practice-chip').count()) === 1, 'Ada still has her practice list after the deck changed');

  console.log('\n5. Save and load practice JSON');
  const [dl] = await Promise.all([T.waitForEvent('download'), T.getByRole('button', { name: 'Save JSON' }).first().click()]);
  ok(dl.suggestedFilename() === 'practice-ada.json', `download is named by student (${dl.suggestedFilename()})`);
  const path = await dl.path(); const saved = JSON.parse(fs.readFileSync(path, 'utf8'));
  ok(saved.kind === 'phonics-practice' && saved.studentName === 'Ada' && saved.cards.length === 1 && saved.cards[0].text === 'b', 'file holds the student name and card');
  const S2 = await (await browser.newContext({ viewport: { width: 420, height: 900 } })).newPage();
  await S2.goto(BASE); await S2.getByLabel('Room code').fill(code); await S2.getByLabel(/Your name/).fill('Bo'); await S2.getByRole('button', { name: 'Join game' }).click(); await S2.getByTestId('student-status').waitFor();
  await T.locator('#practice-student').selectOption({ label: 'Bo' });
  await T.locator('.practice-import input[type=file]').setInputFiles(path);
  await S2.locator('.practice-chip').first().waitFor();
  ok((await S2.locator('.practice-chip').first().textContent()).trim() === 'b', 'Bo received the loaded practice list');
  ok((await S2.locator('.practice-chip').count()) === 1 && (await S2.getByText('Ada').count()) === 0, 'Bo sees only their own list (nothing of Ada\'s)');

  console.log('\n6. A student who disconnects mid-stroke does not leave a stuck thumbnail');
  await scribble(S, 0.3, 0.6);
  await T.locator('[data-testid^="live-trace-"]').waitFor({ timeout: 5000 });
  await sCtx.close();
  await eventually(async () => (await T.locator('[data-testid^="live-trace-"]').count()) === 0, 'the teacher\'s live thumbnail disappears when the student disconnects', 8000);

  ok(errors.length === 0, `no browser errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  console.log(`\nAll ${passed} tracing checks passed.`);
} catch (e) {
  console.error('\n' + (e instanceof Error ? e.message : e)); process.exitCode = 1;
} finally { await browser.close(); server.kill('SIGTERM'); }
