# Phonics Piles — progress log

## Goal (from the teacher)
A "sandbox" feel: eggshell background; cards sit on a table in three piles that look like the printed card sheets (`skills_1.pdf`);
tap a pile → its top card goes to the discard and the next appears. Work in chunks.

## Done
**Earlier (see README):** real-time rooms, permissions, deck schema + validation, classic drag board, reconnection, rate limits, deployment config.

**Card formatting + importer:** decks can carry font/colour/outline/border/corner-mark/shape formatting (`shared/src/style.ts`); `client/src/import/htmlCards.ts`
imports printable HTML card sheets (skills_1…8) in the browser; `CardFace.tsx` draws them (matches the original within ~2/255 mean pixel difference).

**Sandbox table (this session):**
- Chunk 1 — server: `pile:draw` (with `expectedCardId` so a double tap draws once), `pile:undo`, `pile:recycle`; `PileState.discard` / `PileView.discard`;
  reset and deck change clear discards; face-down discards stay hidden from students. Tests in `server/tests/draw.test.ts`.
- Chunk 2 — client: `components/Table.tsx` (stacks with depth layers, tilted discards, count labels, tap/undo/recycle, per-pile Shuffle / Reshuffle discards),
  eggshell palette (`--bg #f5f0e6`) + table styles in `styles.css`, Table ⇄ Arrange toggle (`ViewToggle` in `common.tsx`), plain decks drawn in the bundled Playwrite script font.
- A previous tool's restyle (Caveat via Google Fonts) was NOT adopted: only its eggshell palette was. Google Fonts would send every student device's request to Google and fail offline.

**Verified (run in sandbox):** `npm test` 94 passing; `npm run typecheck` clean; `npm run build`; `e2e/table.mjs` 24 checks; `e2e/classic-board.mjs` 43 checks (Chromium only).

**Compact teacher header (this session):**
- Room-code banner tightened (smaller padding, slightly smaller code font that remains projector-readable, shorter join-help line).
- "Who can move cards?" + action buttons collapsed into a `<details class="compact-controls">` (open by default). Summary shows current permission status + deck name; expand for the mode radios, student picker, and Shuffle/Reset/Change-deck buttons.
- Top bar and overall teacher padding reduced so the table has more vertical room at 1440×900 and on tablets.
- Files: `client/src/components/TeacherView.tsx`, `client/src/styles.css`.

**Flip/reveal on the table (this session):**
- When `deck.rules.allowFlip` is true, each pile shows a "Reveal" / "Flip down" button under the stack (only for users who may manipulate cards).
- Uses the existing `board:flip` path (server-authoritative, redacts text for students).
- Hint text mentions the new control.
- Files: `client/src/components/Table.tsx`, `TeacherView.tsx`, `StudentView.tsx`.

**Table polish (this session):**
- **Fanned discards:** the last 2–3 discarded cards are shown as real card faces with progressive offset + tilt (not just blank layers).
- **Draw / land animation:** improved `land` keyframe so the arriving discard flies from the stack area into its fanned position; `deal-in` for the new top card. Both respect `prefers-reduced-motion`.
- **Projector mode:** teacher-only toggle next to the Table/Arrange switch. Adds `.projector` class that enlarges card size (`--sw`), labels, hint text and action buttons for classroom projection.
- Files: `client/src/components/Table.tsx`, `TeacherView.tsx`, `client/src/styles.css`.

**Tracing Practice (new feature, design approved):**
- Design refined: teacher marks cards “not yet” → per-student practice list; student traces on device; teacher can watch live; JSON save/load by student name; success = ≥80% coverage + mostly inside the path; visual feedback primary, optional vibration.
- **Slice 1 done:** single-player `TracingCanvas` — skills-style card, pointer tracing, green/red stroke, coverage + inside-ratio stats, success detection, optional vibration, Clear button. Open via `?view=trace&text=ea&cat=P` or the demo link on the home screen.
- **Slice 2 done:** real-time teacher mirror.
  - Socket events: `practice:start` / `practice:points` / `practice:end` (student → server → host only).
  - StudentView: “Practice tracing” opens the canvas and streams normalised points.
  - TeacherView: live thumbnail(s) via `LiveTraceMirror` while any student is tracing.
  - Files: `shared/src/events.ts`, `server/src/gameServer.ts`, `client/src/hooks/useRoom.ts`, `TracingCanvas.tsx`, `LiveTraceMirror.tsx`, `StudentView.tsx`, `TeacherView.tsx`.
- **Slice 3 done:** teacher marks top cards “not yet” for a student; per-student practice lists on the server; student sees their list and opens TracingCanvas for each card; optional self-assessment toggle; remove from list. Live streaming still works for list cards.
- **Slice 4 done:** practice lists save/load as JSON by student name.
  - Format: `{ schemaVersion: 1, kind: "phonics-practice", studentName, updatedAt, cards[] }`.
  - Teacher: **Save JSON** per student; **Load practice JSON** onto the selected student (replaces their list).
  - Student: **Save JSON** for their own list.
  - Files: `client/src/practiceFile.ts`, TeacherView, StudentView, shared events, Room.importPractice, gameServer.
- Tracing Practice feature is complete for the approved design (canvas, live mirror, mark not-yet, lists, JSON persistence).

## Next chunks (suggested order)
1. ~~**Compact the teacher header**~~ — done.
2. ~~**Flip/reveal on the table**~~ — done.
3. ~~**Polish**~~ — done (above).
4. **Sandbox extras (ask the teacher first):** movable/zoomable piles? a "word" read-out under the piles? a lesson picker that switches among the imported lesson decks mid-game?
5. **Real-device testing** (Safari/iOS, Android tablets) and a screen-reader pass — only Chromium has been tested.
6. **Deployment:** not yet verified on Render (see README); the teacher is deploying from their own GitHub repo and must re-upload changed files.

## Gotchas
- Node 20+ is required to build; the teacher's Mac (macOS 10.13) cannot run Node, so everything the teacher needs must work from the deployed website.
- `pkill -f "dist/server/index.js"` kills your own shell if the pattern is in the command line; use `pkill -f "[d]ist/server/index.js"`.
- TypeScript 7 has no `baseUrl`; path aliases live in `tsconfig.base.json` (`@shared/*`).


## Review of the Tracing Practice work (Claude, after Grok)
Grok's version did not typecheck (11 strict-index errors) and its zip was missing `client/tests` and the formatting docs; both restored/fixed.
Real bugs found and fixed, each with a regression test (they fail on Grok's original code, pass now): student practice lists were wiped by deck-change / stale resync snapshots;
students could put arbitrary text on the teacher's screen (client-supplied card text / trace label) and could mark face-down cards (revealing hidden text);
a leaving student's list was never cleaned up; a continuous stroke exceeded the shared rate limit; a student's drawing was wiped on every room update (callback identity re-ran an effect);
a disconnect left a stuck "is tracing" thumbnail; practice-file download could be cancelled in Safari (immediate revoke) and had no size cap.
**Verified (run):** typecheck clean; 116 unit/integration tests; e2e: table 24, practice 13, classic board 43 (Chromium only).
**Open design concern:** with *Live tracing* and *Tracing practice lists* panels open the table is pushed below the fold; consider a side column / overlay for live traces.
**Not verified:** tracing success detection with a real, careful trace (only that strokes register and stream), Safari/iOS/tablet touch tracing, screen readers, Render deploy.
