# Phonics Piles — handoff

**What it is:** a real-time classroom card game. A teacher creates a room; students join with a 5-character code on their own devices. Three piles of phonics cards
(beginning / middle / ending sound) sit on an eggshell "table"; the three top cards read as a nonsense word. Tap a pile → top card goes to that pile's discard.
No accounts, no database; one in-memory Node process serves the React app and Socket.IO.

**Stack:** React 19 + Vite 8 + TypeScript 7 (client/), Node 20+ / Express 5 / Socket.IO 4 (server/), Zod 4 deck + event schemas (shared/), Vitest 5, Playwright (playwright-core, e2e/).

## Run
```bash
npm install
npm run dev            # server :3001 + Vite :5173 (proxy). Open http://localhost:5173
npm test               # 116 tests
npm run typecheck      # server + client + scripts
npm run build && npm run e2e     # two-browser end-to-end (needs a Chromium for playwright-core)
npm start              # production: one process serves client + sockets
```

## Rules of the road (do not break)
1. **Server-authoritative.** Clients send requests; the UI changes when the broadcast arrives. Never trust client-claimed role/room/permissions. Every state change goes through `Room` methods (`server/src/rooms/room.ts`) which check permission, existence, locks and staleness.
2. **Host token ≠ room code.** Host token is secret, hashed server-side, never broadcast or logged.
3. **Decks are data.** Validate with `shared/src/deck.ts` on the client AND server. Colours must be hex; fonts come from a fixed list; text is rendered as text (never HTML).
4. **No external assets/fonts** (privacy + offline classrooms). The Playwrite CO font is bundled (`client/public/fonts`, OFL).
5. Keep the double-tap guard: `pile:draw` carries `expectedCardId`; a mismatch returns `STALE` and re-syncs the sender.
6. Add/keep tests when changing behaviour (`server/tests`, `shared/tests`, `client/tests`, `e2e/`).

## Map
- `shared/src/deck.ts` deck schema · `style.ts` card formatting + geometry constants · `meta.ts` DeckMeta builder · `events.ts` socket contract + Zod payloads · `types.ts` wire types
- `server/src/game/engine.ts` pure board ops (move, flip, shuffle, **drawTop / undoDraw / recycleDiscard**, `toBoardView` redacts face-down text for students)
- `server/src/rooms/room.ts` authoritative state, permissions, locks, stale rules · `roomManager.ts` codes/expiry · `gameServer.ts` HTTP + socket handlers
- `client/src/hooks/useRoom.ts` connection, auto re-auth on reconnect, `actions` · `components/Table.tsx` **the table** · `Board.tsx` classic drag board · `CardFace.tsx` card renderer (plain + designed SVG)
- `client/src/import/htmlCards.ts` + `components/ImportDialog.tsx` HTML card-sheet importer · `components/DeckPicker.tsx` deck list/upload/import/download

## Socket events (client → server, all acked; payloads validated with Zod)
`room:create`, `room:join`, `host:resume`, `host:end`, `host:set-permissions`, `host:load-deck`, `board:reset`, `board:move`, `board:flip`, `board:shuffle`,
`card:lock`, `card:unlock`, `pile:draw {pileId, expectedCardId?}`, `pile:undo {pileId}`, `pile:recycle {pileId, shuffle?}`, **tracing practice:** `practice:mark`, `practice:unmark`, `practice:allow-self`, `practice:import` (teacher-only), `practice:start`, `practice:points`, `practice:end` (students only; relayed to the host only).
Server → client: `practice:update` (host: all lists; each student: only their own), `practice:student-start|student-points|student-end` (host only), `room:snapshot`, `board:update`, `board:locks`, `room:permissions`, `room:presence`, `room:ended`, `session:replaced`.
Permission modes: `teacher-only`, `all-students`, `one-student`. Students who may move cards can draw/undo/recycle/shuffle/move/flip; reset, deck change, permissions and ending are teacher-only.

## Status and next steps
See `PROGRESS.md` (done / next chunks / gotchas). Known not-verified: real deployment, Safari/iOS, screen-reader audit, load.

## Tracing practice: rules learned the hard way
- Snapshots are **per viewer** (`room.snapshot(forHost, participantId)`): never build a student snapshot without their id, or their practice list is wiped on the next deck change/resync.
- Marked/traced cards come from the **deck**, never from client-supplied text; students cannot mark face-down cards.
- Point streams have their own rate-limit bucket (`pointsBucket`); the client batches at most 10/s.
- In React, pass callbacks to `TracingCanvas` freely, but keep effects independent of their identity (use refs) or the child's drawing is wiped on every room update.
- A student's disconnect emits `practice:student-end` to the host.
