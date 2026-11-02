# Phonics Piles

A real-time, browser-based classroom card game for phonics instruction. A teacher shows three piles of cards
(beginning / middle / ending sounds) whose top cards form a nonsense word; students join from their own devices with a
short room code and see the same board live. The teacher decides when students may move cards.

No accounts, no emails, no database. Works on desktop, tablet and phone browsers (mouse and touch).

* **Frontend:** React + TypeScript + Vite (`client/`)
* **Backend:** Node.js + TypeScript, Express, Socket.IO (`server/`) — authoritative game state
* **Shared:** types, Zod deck schema, event contract (`shared/`)
* **Decks:** JSON files (`decks/`), documented in [`docs/DECK_SCHEMA.md`](docs/DECK_SCHEMA.md)

## Quick start (local development)

Requires Node.js 20+ (developed on 22).

```bash
npm install
npm run dev          # server on :3001, Vite dev server on :5173 (proxies /api and /socket.io)
```

Open <http://localhost:5173>. Click **Create a game** as the teacher, then open a second window (or a private window, or your phone
on the same network at `http://<your-computer-ip>:5173`) and join with the code.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Server (tsx watch) + Vite dev server |
| `npm run build` | Production build: client → `dist/client`, server bundle → `dist/server/index.js` |
| `npm start` | Run the production build (serves the frontend **and** Socket.IO from one process) |
| `npm test` | Unit + integration tests (Vitest) |
| `npm run typecheck` | Strict TypeScript check for server and client |
| `npm run e2e` | Two-browser end-to-end tests (Playwright/Chromium) against the production build — run `npm run build` first (`e2e:table`, `e2e:classic` run one suite) |
| `npm run import:html -- <outDir> <files…>` | Convert HTML card sheets to JSON decks from the command line |
| `npm run schema:json` | Regenerate `docs/deck.schema.json` from the Zod schema |

The E2E test needs a Chromium that `playwright-core` can find (`npx playwright install chromium`, or set `PLAYWRIGHT_BROWSERS_PATH`).

## How to play

1. **Teacher:** *Create a game* → choose a deck (or upload one, or import card sheets) → *Start game*. The room code is shown large for a projector, with *Copy code* and *Copy join link*.
2. **Students:** open the site, enter the code (and optionally a name) → *Join game*.
3. **The table.** Everyone sees an eggshell table with three face-up piles. The three top cards sit side by side and read as the current word.
   * **Tap a pile** → its top card moves to that pile's **discard** and the next card appears (on every screen).
   * **Tap a discard** → the last drawn card goes back on top (undo).
   * **Tap an empty pile** (or *Reshuffle discards*) → the discards are shuffled back in.
   * Per-pile *Shuffle* is under each pile. A double tap draws only once.
4. **Who can move cards?** *Teacher only* / *All students* / *One student at a time* (pick the student). Changeable at any time; students who can't move cards see the table but their taps do nothing (the server rejects them too).
5. *Shuffle all piles*, *Reset board* (back to the starting arrangement, discards cleared), *Change deck*, *End game*.
6. **Arrange cards** (button above the table, only for people who can move cards) opens the classic board where you drag cards between piles or re-order them. Keyboard: arrows move focus, Enter/Space select, Shift+arrows re-order, Esc deselects. Touch: press and **hold** a card briefly to pick it up; a normal swipe still scrolls. Add `?view=arrange` to the address to open it first.

## Tracing practice

Students can practise writing the letters they have not mastered yet.

1. **Mark cards.** Open *Tracing practice lists* on the teacher screen, pick a student, and press *Mark “…”* for any of the current top cards. (Optionally tick *Allow students to mark cards themselves*; they can then add real cards from the current deck to their own list, never anyone else's.)
2. **Student traces.** The student's screen shows *Your practice list*; tapping a card opens a tracing canvas (the card with writing lines and the cursive letter). The stroke turns green inside the letter. Success is at least 80% of the letter covered with most of the stroke inside it. Optional vibration works mainly on Android; the visual feedback is the main signal everywhere.
3. **Teacher watches live.** A thumbnail under *Live tracing* mirrors the stroke as the student draws. Only the teacher receives this; classmates never do.
4. **Save and load.** *Save JSON* downloads `practice-<name>.json` (teacher: per student; student: their own list). *Load practice JSON* puts a saved list onto the student selected above (replacing their list), so a list can be reused in a later session.

**Privacy note.** Practice files contain the student's display name and the cards they find hard. They are saved only on the device that pressed *Save*; the server keeps lists in memory for the life of the room and deletes them with it (and when a student leaves for good). Use first names or nicknames if you prefer.
The server only accepts real cards: marked and traced cards must exist in the current deck (or already be on the student's list), and the card text always comes from the deck, never from the student's device.

## Card formatting and importing card sheets

Decks can describe how their cards look (font, colours, outline, border, corner marks, card shape) — see [`docs/DECK_SCHEMA.md`](docs/DECK_SCHEMA.md).
The deck picker can also **import printable HTML card sheets** (for example `skills_1.html` … `skills_8.html`, one `<svg>` per card): choose the files under *Upload your own deck*, check which pile each colour of card belongs in, and the app converts them to JSON decks, keeping the formatting. It runs entirely in the browser (nothing to install) and anything it cannot carry over is listed instead of silently dropped. Saved decks have a *Download JSON* button.
With Node installed you can also run `npm run import:html -- <outDir> file1.html file2.html …`.
The Playwrite CO font used by these cards (SIL Open Font License) is bundled in `client/public/fonts/`; no external fonts are loaded.

## Architecture

```
client (React)  ──Socket.IO──►  server (Express + Socket.IO)
   Board component                RoomManager ─► Room (authoritative state, permissions, locks)
   (same for teacher/student)     engine.ts (pure board operations)   deckLibrary (built-in decks)
```

* **Server-authoritative.** Clients send *requests* (`board:move`, …). The server validates identity, room membership, permission,
  payload shape (Zod) and game rules, updates the state, then broadcasts to that room only. The UI changes when the broadcast arrives.
* **Rooms.** Each room has two Socket.IO channels (`r:CODE:host`, `r:CODE:students`); every emit targets exactly one room.
  A socket's room/role is stored **server-side at join time** — nothing in later events (role, host flag, room) is trusted.
* **Secrets.** Room code (public, 5 chars from an unambiguous alphabet, `crypto.randomInt`) is separate from the host token
  (256-bit random, returned once to the creator, stored server-side only as a SHA-256 digest, compared in constant time, never broadcast or logged).
  Students get a private participant token so they can reclaim their seat after a dropped connection.
* **Reconnect.** On every (re)connect the client re-authenticates (host token / participant token) and receives a fresh snapshot.
  A room the server no longer knows (restart, expiry) produces a clear "no longer available" screen instead of a stale board.
  On graceful shutdown (SIGTERM, e.g. a deploy) clients are told "the server restarted" immediately.
* **Face-down cards.** If a deck allows flipping, the server does not send the *text* of face-down cards to students.

### Conflict rules (simultaneous actions)

1. Starting a drag takes a **server-side lock** on the card (one lock per participant; auto-expires after `LOCK_TTL_MS`, refreshed while dragging, released on drop/disconnect).
2. Others cannot lock/move/flip a locked card (`CARD_LOCKED`).
3. **The teacher always wins:** a host action overrides and clears a student's lock.
4. Each card remembers the board version at which it last changed; a move based on an older version of *that card* is rejected (`STALE`) and the sender is re-synced. Unrelated cards are unaffected.
5. Shuffle/reset/deck-change invalidate in-flight moves via rule 4. A student cannot shuffle a pile containing a card someone else is holding.

### Decisions where the brief was open

* A student with permission may **move, flip and shuffle**; **reset, change deck, permissions and end game are teacher-only.**
* Exactly **three piles** per deck. "Top" = first card of a pile; the word strip shows the three top cards.
* Reset restores the *starting arrangement of this room* (after any initial shuffle).
* Host token lives in the teacher's `localStorage` (so a refresh/closed tab can resume); the student token lives in `sessionStorage` (one seat per tab). Both vanish with the room.
* Students who stay offline for `PARTICIPANT_GRACE_MS` (5 min) lose their seat; rooms with nobody connected for `ROOM_IDLE_TTL_MS` (30 min) or older than `ROOM_MAX_AGE_MS` (12 h) are deleted.
* Uploaded decks are kept in the teacher's browser (`localStorage`, max 20) and sent to the server only when starting/changing a game.

## Configuration

All optional — see [`.env.example`](.env.example). The server reads `process.env` directly (use your platform's env settings, or `node --env-file=.env dist/server/index.js`).
Notable: `PORT`, `TRUST_PROXY=true` (behind Render/nginx), `CORS_ORIGINS` (only for a split frontend/backend deployment), `MAX_DECK_BYTES`, `MAX_ROOMS`, `MAX_PARTICIPANTS_PER_ROOM`, and the lifecycle timers.
Rate limits: per-socket token bucket for state-changing events (burst 30, 15/s) and per-IP limits for room creation (10/min) and join/resume attempts (30/min, which also throttles code guessing).

## Deployment (Render, single service)

The server serves the compiled frontend and Socket.IO from one origin, so there is no CORS setup; Render terminates HTTPS and WSS.

1. Push this repo to GitHub/GitLab.
2. In Render: **New → Blueprint** and select the repo (uses [`render.yaml`](render.yaml)), *or* **New → Web Service** with:
   * Build command: `npm ci --include=dev && npm run build` (the build needs devDependencies)
   * Start command: `npm start`
   * Health check path: `/healthz`
   * Env: `NODE_VERSION=22`, `NODE_ENV=production`, `TRUST_PROXY=true`
3. Open the service URL. Students use the same URL.

Notes: game state is **in memory** — run **one instance** (do not scale horizontally) and expect sessions to end on restart/deploy.
Free-tier instances sleep when idle and the first request after sleeping is slow; use a paid instance for classroom reliability.
Any host with persistent Node processes and WebSocket support works the same way (`npm ci --include=dev && npm run build && npm start`).

**Split deployment (not recommended):** host `dist/client` on a static host, build it with `VITE_SERVER_URL=https://your-server`, and set `CORS_ORIGINS=https://your-frontend` on the server.

## Testing

`npm test` runs 116 tests (deck + formatting validation, the HTML importer, engine and room logic with a controllable clock, and real Socket.IO client ↔ server integration).
They cover: unique codes, joining, invalid codes, initial sync, broadcasts, cross-room isolation, disabled/enabled/one-student permissions,
malformed payloads and unknown cards, deck validation, duplicate card text, reconnect (student and host), ending a room, conflicting simultaneous actions,
lock expiry, rate limits, capacity, expiry, graceful shutdown, and tap-to-draw / undo / recycle (including the double-tap race). `npm run e2e` drives two real browser sessions (desktop teacher + phone-sized student): `e2e/table.mjs` (table), `e2e/practice.mjs` (tracing practice) and `e2e/classic-board.mjs` (drag board).

## What has and has not been verified

**Verified by running it** (in the development sandbox):
`npm test` (65 passing), `npm run typecheck`, `npm run build`, `npm run dev` (Vite proxy serves API, health and the Socket.IO handshake), and `npm run e2e`
(35 checks, Chromium: create/join, live sync, mouse drag, touch long-press drag via real touch events, swipe-to-scroll not dragging, disabled student interaction,
mode changes, one-student mode, offline → reconnect resync, host reload/resume, invalid/valid deck upload, graceful restart and hard-crash handling, ending a room).

**Not verified — please check before relying on it in class:**
* **Not deployed.** I did not deploy to Render or any host, so HTTPS/WSS behind a real proxy, `TRUST_PROXY` behaviour and the `render.yaml` blueprint are untested.
* **Browsers/devices:** only Chromium (desktop and emulated phone). Safari/iOS (touch-drag and scroll blocking behave differently there), Firefox and real tablets are untested.
* **Accessibility:** designed for keyboard/screen-reader use (labels, roles, live regions, focus styles, no colour-only cues, reduced-motion) but **not audited** with a screen reader or automated tool; contrast was chosen to be high but not measured.
* **Scale:** not load-tested; one in-memory instance only.
* The `PARTICIPANT_GRACE_MS`/idle expiry paths are tested with a fake clock, not in real time.

**Intentionally not included (MVP):** persistence/database, multi-instance scaling, kicking/muting individual students, server-side storage of uploaded decks,
shared (rather than per-device) card selection, undo, and a curriculum-accurate phonics deck (the bundled decks are labelled illustrative samples).
