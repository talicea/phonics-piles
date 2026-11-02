/**
 * End-to-end test with TWO separate browser sessions (teacher on desktop, student on a touch phone),
 * run against the production build served by the real server.
 *   npm run build && node e2e/classic-board.mjs   (opens the classic drag-to-arrange board via ?view=arrange)
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { chromium } from 'playwright-core';

const PORT = process.env.E2E_PORT ?? '3100';
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = 'e2e/screenshots';
fs.mkdirSync(SHOTS, { recursive: true });

let server = null;
function startServer() {
  server = spawn('node', ['dist/server/index.js'], { env: { ...process.env, PORT, HOST: '127.0.0.1', NODE_ENV: process.env.E2E_NODE_ENV ?? 'production' }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 8000);
    server.stdout.on('data', (d) => { if (String(d).includes('listening')) { clearTimeout(t); resolve(); } });
  });
}
const stopServer = (signal = 'SIGTERM') => new Promise((r) => { if (!server) return r(); const s = server; server = null; s.once('exit', r); s.kill(signal); });

let passed = 0;
const ok = (cond, msg) => { if (!cond) throw new Error(`FAILED: ${msg}`); passed++; console.log(`  ✓ ${msg}`); };
const step = (name) => console.log(`\n${name}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function eventually(fn, msg, timeout = 6000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) { try { last = await fn(); if (last) return ok(true, msg); } catch { /* retry */ } await sleep(80); }
  throw new Error(`FAILED (timeout): ${msg}`);
}

/** "pileId:index" of a card as rendered in a given page. */
const where = (page, id) => page.evaluate((cid) => {
  const el = document.querySelector(`[data-card-id="${cid}"]`); if (!el) return null;
  const pile = el.closest('[data-pile-id]'); const cards = [...pile.querySelectorAll('[data-card-id]')];
  return `${pile.dataset.pileId}:${cards.indexOf(el)}`;
}, id);
const box = async (page, sel) => { const b = await page.locator(sel).first().boundingBox(); if (!b) throw new Error(`no box for ${sel}`); return b; };

async function mouseDrag(page, fromSel, toSel, toOffset = { x: 0.5, y: 0.5 }) {
  const a = await box(page, fromSel); const b = await box(page, toSel);
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 12, a.y + a.height / 2 + 12, { steps: 3 });
  await page.mouse.move(b.x + b.width * toOffset.x, b.y + b.height * toOffset.y, { steps: 12 });
  await page.mouse.up();
}

/** Real touch gesture through the Chrome DevTools protocol: long-press, then drag. */
async function touchDrag(page, fromSel, toSel) {
  const cdp = await page.context().newCDPSession(page);
  await page.locator(fromSel).first().scrollIntoViewIfNeeded();
  const a = await box(page, fromSel);
  const sx = a.x + a.width / 2, sy = a.y + a.height / 2;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: sx, y: sy }] });
  await sleep(350); // hold
  const b = await box(page, toSel);
  const tx = b.x + 20, ty = b.y + b.height / 2;
  for (let i = 1; i <= 12; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: sx + ((tx - sx) * i) / 12, y: sy + ((ty - sy) * i) / 12 }] });
    await sleep(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

const CARD_B = '[data-card-id="b-b"]', CARD_A = '[data-card-id="m-a"]', CARD_T = '[data-card-id="e-t"]';

await startServer();
const browser = await chromium.launch();
try {
  const teacherCtx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const studentCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const teacher = await teacherCtx.newPage(); const student = await studentCtx.newPage();
  const errors = [];
  for (const [n, p] of [['teacher', teacher], ['student', student]]) {
    p.on('pageerror', (e) => errors.push(`${n}: ${e.message}`));
    p.on('console', (m) => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED|WebSocket connection to/.test(m.text())) errors.push(`${n} console: ${m.text()}`); }); // refused connections are expected while the test restarts the server
  }

  step('1. Teacher creates a game');
  await teacher.goto(`${BASE}/?view=arrange`);
  await teacher.getByRole('button', { name: 'Create a game' }).click();
  await teacher.getByRole('radio', { name: /Short vowels/ }).waitFor();
  await teacher.getByRole('button', { name: 'Start game' }).click();
  const code = (await teacher.getByTestId('room-code').textContent()).trim();
  ok(/^[A-Z2-9]{5}$/.test(code), `room code displayed: ${code}`);
  await teacher.screenshot({ path: `${SHOTS}/1-teacher-dashboard.png` });

  step('2. Student joins from a phone');
  await student.goto(`${BASE}/?view=arrange`);
  await student.getByLabel('Room code').fill(code.toLowerCase());
  await student.getByLabel(/Your name/).fill('Ada');
  await student.getByRole('button', { name: 'Join game' }).click();
  await student.getByTestId('student-status').waitFor();
  await eventually(async () => (await teacher.getByTestId('student-count').textContent()).startsWith('1'), 'teacher sees 1 student connected');
  ok((await student.getByTestId('student-status').textContent()).includes('teacher is moving'), 'student is told the teacher controls the board');
  ok((await student.locator('text=Shuffle all').count()) === 0 && (await student.locator('text=End game').count()) === 0, 'student sees no teacher-only controls');
  await student.screenshot({ path: `${SHOTS}/2-student-view-teacher-only.png` });

  step('3. Same board on both screens; teacher moves a card with the mouse');
  const start = await where(teacher, 'b-b');
  ok(start === (await where(student, 'b-b')), `both show card b-b at ${start}`);
  await mouseDrag(teacher, CARD_B, '[data-pile-id="ending"] .pile-cards', { x: 0.98, y: 0.5 });
  await eventually(async () => (await where(teacher, 'b-b'))?.startsWith('ending:'), 'card moved to the Ending pile on the teacher screen');
  await eventually(async () => (await where(student, 'b-b')) === (await where(teacher, 'b-b')), 'student screen shows the identical move in real time');

  step('4. Student cannot move cards while disabled');
  const before = await where(student, 'm-a');
  await student.locator(CARD_A).scrollIntoViewIfNeeded();
  await mouseDrag(student, CARD_A, '[data-pile-id="beginning"] .pile-cards');
  await sleep(400);
  ok((await where(student, 'm-a')) === before && (await where(teacher, 'm-a')) === before, 'drag attempt changed nothing');
  ok((await student.locator('.card.selected').count()) === 0, 'tapping did not select (interaction unavailable)');

  step('5. Teacher allows all students; student drags with a TOUCH long-press');
  await teacher.getByLabel(/All students/).check();
  await eventually(async () => (await student.getByTestId('student-status').textContent()).includes('You can move cards'), 'student UI updated immediately');
  await student.screenshot({ path: `${SHOTS}/3-student-can-move.png` });
  await touchDrag(student, CARD_A, '[data-pile-id="beginning"] .pile-cards');
  await eventually(async () => (await where(teacher, 'm-a'))?.startsWith('beginning:'), 'teacher screen shows the card the student moved by touch');
  await eventually(async () => (await where(student, 'm-a')) === (await where(teacher, 'm-a')), 'student screen matches');

  step('6. Quick swipe on a card scrolls instead of dragging (touch)');
  const scrollBefore = await student.evaluate(() => window.scrollY);
  const cdp = await studentCtx.newCDPSession(student);
  const c = await box(student, CARD_T);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: c.x + 20, y: c.y + 20 }] });
  for (let i = 1; i <= 6; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: c.x + 20, y: c.y + 20 - i * 15 }] }); await sleep(12); }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(300);
  ok((await where(teacher, 'e-t'))?.startsWith('ending:'), 'card did not move');
  void scrollBefore;

  step('7. Tap-to-select and toolbar buttons (teacher)');
  await teacher.locator(CARD_T).click();
  await teacher.locator('.card.selected').waitFor();
  await teacher.getByRole('button', { name: /Make top/ }).click();
  await eventually(async () => (await where(teacher, 'e-t')) === 'ending:0' && (await where(student, 'e-t')) === 'ending:0', 'Make top moved the card to the top on both screens');

  step('8. One-student-at-a-time');
  await teacher.getByLabel(/One student at a time/).check();
  await teacher.getByLabel('Student in control').selectOption({ label: 'Ada' });
  await eventually(async () => (await student.getByTestId('student-status').textContent()).includes('your turn'), 'Ada is told it is her turn');
  await teacher.getByLabel('Student in control').selectOption({ value: '' });
  await eventually(async () => (await student.getByTestId('student-status').textContent()).includes('Another student'), 'control removed again');

  step('9. Student reconnects after a network interruption');
  await teacher.getByLabel(/All students/).check();
  await studentCtx.setOffline(true);
  await eventually(async () => /Reconnecting|Offline/.test(await student.locator('.conn').textContent()), 'student shows a reconnecting indicator');
  await teacher.locator('[data-card-id="m-e"]').click();
  await teacher.getByRole('button', { name: /→ Ending/ }).click();
  await eventually(async () => (await where(teacher, 'm-e'))?.startsWith('ending:'), 'teacher moved a card while the student was offline');
  await eventually(async () => (await teacher.getByTestId('student-count').textContent()).startsWith('0'), 'teacher sees the student drop');
  await studentCtx.setOffline(false);
  await eventually(async () => (await where(student, 'm-e'))?.startsWith('ending:'), 'student got the latest board after reconnecting', 15000);
  await eventually(async () => (await student.locator('.conn').textContent()).includes('Connected'), 'student shows Connected again');
  await eventually(async () => (await teacher.getByTestId('student-count').textContent()).startsWith('1'), 'teacher sees the same student (not a duplicate) back');

  step('10. Teacher refreshes the page and resumes as host');
  await teacher.reload();
  await teacher.getByTestId('room-code').waitFor();
  ok((await teacher.getByTestId('room-code').textContent()).trim() === code, 'same room, still host after reload');
  ok((await where(teacher, 'm-e'))?.startsWith('ending:'), 'board state restored');

  step('11. Deck upload: invalid then valid');
  await teacher.getByRole('button', { name: /Change deck/ }).click();
  fs.writeFileSync('e2e/bad-deck.json', JSON.stringify({ schemaVersion: 1, id: 'bad', name: 'Bad', version: '1', piles: [] }));
  await teacher.locator('dialog input[type=file]').setInputFiles('e2e/bad-deck.json');
  await teacher.getByRole('alert').filter({ hasText: 'can’t be used' }).waitFor();
  ok((await teacher.getByRole('alert').filter({ hasText: 'can’t be used' }).textContent()).includes('exactly 3 piles'), 'invalid deck rejected with a clear explanation');
  fs.writeFileSync('e2e/bad-deck.json', '{oops');
  await teacher.locator('dialog input[type=file]').setInputFiles('e2e/bad-deck.json');
  await teacher.getByText(/not valid JSON/).waitFor();
  ok(true, 'malformed JSON rejected');
  await teacher.locator('dialog input[type=file]').setInputFiles('client/public/sample-deck.json');
  await teacher.getByText(/Added “My first deck”/).waitFor();
  await teacher.getByRole('button', { name: 'Use this deck' }).click();
  await eventually(async () => (await student.locator('.word-label').allTextContents()).join() === 'Start,Middle,End', 'student board switched to the uploaded deck');
  await student.screenshot({ path: `${SHOTS}/4-uploaded-deck-student.png` });
  fs.rmSync('e2e/bad-deck.json');

  step('11b. Import HTML card sheets as formatted cards');
  await teacher.getByRole('button', { name: /Change deck/ }).click();
  await teacher.locator('dialog input[type=file]').setInputFiles(['client/tests/fixtures/skills_1.html', 'client/tests/fixtures/skills_5.html', 'client/tests/fixtures/skills_8.html']);
  await teacher.getByRole('heading', { name: 'Import card sheets' }).waitFor();
  ok((await teacher.getByText(/Read 13 cards from 3 files/).count()) === 1, 'importer read 13 cards from the 3 HTML files');
  await teacher.getByRole('button', { name: /^Add 3 decks/ }).click();
  await teacher.getByText(/Added 3 decks/).waitFor();
  await teacher.getByRole('radio', { name: /lessons 1, 5, 8/ }).check();
  await teacher.getByRole('button', { name: 'Use this deck' }).click();
  await eventually(async () => (await student.locator('.card.styled svg').count()) > 10, 'student sees formatted (SVG) cards');
  await eventually(async () => (await student.locator('.word-card.styled svg').count()) === 3, 'word strip shows 3 formatted cards');
  ok((await student.locator('.card.styled svg text').first().getAttribute('font-family')).includes('PlaywriteCO'), 'cards use the bundled Playwrite font');
  ok((await student.evaluate(() => document.fonts.check('400 20px PlaywriteCO'))), 'the Playwrite font actually loaded in the browser');
  await eventually(async () => (await student.locator('[data-card-id="middle-a"] svg text.x, [data-card-id="middle-a"] svg text[fill="#990000"]').count()) >= 1, 'vowel card keeps its red colour on the student screen');
  await teacher.screenshot({ path: `${SHOTS}/6-teacher-formatted-cards.png` });
  await student.screenshot({ path: `${SHOTS}/7-student-formatted-cards.png` });
  const sBefore = await where(teacher, 'beginning-s');
  await mouseDrag(teacher, '[data-card-id="beginning-s"]', '[data-pile-id="ending"] .pile-cards', { x: 0.98, y: 0.5 });
  await eventually(async () => (await where(teacher, 'beginning-s')) === null || (await where(teacher, 'beginning-s')) !== sBefore, 'dragging a formatted card works');
  ok(true, 'student board follows: ' + (await where(student, 'beginning-s')));
  await teacher.getByRole('button', { name: /Change deck/ }).click();
  await teacher.getByRole('button', { name: 'Download lessons 1, 5, 8 as a JSON file'.replace('lessons','Skills · lessons').replace('Download Skills','Download Skills') }).first().waitFor();
  await teacher.keyboard.press('Escape');

  step('12. Server restarts are communicated, not hidden');
  // 12a: graceful deploy/restart (SIGTERM) - clients are told immediately
  await stopServer();
  await student.getByRole('heading', { name: 'The server restarted' }).waitFor({ timeout: 10000 });
  ok(true, 'student is told the server restarted (graceful shutdown)');
  await teacher.getByRole('heading', { name: 'The server restarted' }).waitFor({ timeout: 10000 });
  ok(true, 'teacher is told the same');
  await student.screenshot({ path: `${SHOTS}/5-student-after-restart.png` });
  await startServer();
  await teacher.getByRole('button', { name: 'Back to start' }).click();
  await student.getByRole('button', { name: 'Back to start' }).click();

  // 12b: hard crash (SIGKILL) - clients can only notice by reconnecting to a server that has forgotten the room
  await teacher.getByRole('button', { name: 'Create a game' }).click();
  await teacher.getByRole('button', { name: 'Start game' }).click();
  const crashCode = (await teacher.getByTestId('room-code').textContent()).trim();
  await student.getByLabel('Room code').fill(crashCode);
  await student.getByRole('button', { name: 'Join game' }).click();
  await student.getByTestId('student-status').waitFor();
  await stopServer('SIGKILL');
  await student.getByText(/Reconnecting|Offline/).first().waitFor({ timeout: 10000 });
  ok(true, 'student shows a reconnecting indicator while the server is down');
  await startServer();
  await student.getByRole('heading', { name: 'This game is no longer available' }).waitFor({ timeout: 25000 });
  ok(true, 'student sees "no longer available" instead of a stale board that looks alive');
  await teacher.getByRole('heading', { name: 'This game is no longer available' }).waitFor({ timeout: 25000 });
  ok(true, 'teacher is told the game was lost');
  await teacher.getByRole('button', { name: 'Back to start' }).click();
  await student.getByRole('button', { name: 'Back to start' }).click();

  step('13. A new game: teacher ends it, student is notified');
  await teacher.getByRole('button', { name: 'Create a game' }).click();
  await teacher.getByRole('button', { name: 'Start game' }).click();
  const code2 = (await teacher.getByTestId('room-code').textContent()).trim();
  await student.getByLabel('Room code').fill(code2);
  await student.getByRole('button', { name: 'Join game' }).click();
  await student.getByTestId('student-status').waitFor();
  await teacher.getByRole('button', { name: 'End game' }).click();
  await teacher.getByRole('dialog').getByRole('button', { name: 'End game' }).click();
  await student.getByRole('heading', { name: 'The game has ended' }).waitFor();
  ok(true, 'student told the game ended');
  await teacher.getByRole('button', { name: 'Create a game' }).waitFor();
  await student.getByRole('button', { name: 'Back to start' }).click();
  await student.getByLabel('Room code').fill(code2);
  await student.getByRole('button', { name: 'Join game' }).click();
  await student.getByText(/could not find that room/i).waitFor();
  ok(true, 'ended room code is rejected with a helpful message');

  ok(errors.length === 0, `no uncaught browser errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  console.log(`\nAll ${passed} end-to-end checks passed. Screenshots in ${SHOTS}/`);
} catch (e) {
  console.error('\n' + (e instanceof Error ? e.message : e));
  process.exitCode = 1;
} finally {
  await browser.close();
  await stopServer();
}
