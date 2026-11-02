You are continuing work on **Phonics Piles**, a real-time classroom phonics card game (React + Vite + TypeScript client, Node/Express/Socket.IO server, shared Zod schemas). The attached zip is the full project. Read `HANDOFF.md` first, then `PROGRESS.md`, then `README.md`.

**Context.** A teacher (on a projector) creates a room; students join from their own devices. Three piles of cards sit face-up on an eggshell "table"; the three top cards read as a nonsense word. Tapping a pile draws its top card to that pile's discard; tapping a discard undoes; tapping an empty pile reshuffles the discards back in. The teacher controls who may tap (teacher-only / all students / one student). The teacher's cards come from printable HTML sheets (`skills_1..8.html`) that the app imports in the browser and draws with a bundled cursive font (Playwrite CO), so the cards look like the printed ones.

**Already done and tested:** server draw/undo/recycle with a double-tap guard (`expectedCardId`), the Table view (`client/src/components/Table.tsx`), eggshell theme, HTML card-sheet importer, card formatting schema, classic drag board ("Arrange cards"). 94 unit/integration tests pass; two Playwright suites pass (`e2e/table.mjs` 24 checks, `e2e/classic-board.mjs` 43 checks).

**Setup.** Node 20+. `npm install`, then `npm run dev` (open http://localhost:5173). Before you finish any change run `npm run typecheck && npm test && npm run build && npm run e2e`. (`npm run e2e` needs a Chromium that playwright-core can find: `npx playwright install chromium`.)

**Hard rules.** (1) Server-authoritative: clients request, the server validates identity/permission/payload/rules and broadcasts; never trust client claims. (2) Do not load external fonts/scripts/CDNs (privacy for children, offline classrooms) — fonts are bundled. (3) Deck/card data is untrusted: keep strict Zod validation, hex-only colours, fixed font list, render text as text. (4) Keep host tokens secret (never broadcast or log). (5) Keep or add tests for every behaviour change. (6) Don't claim something works unless you ran it; list anything unverified.

**Your tasks, in order** (work in small chunks; run the checks after each; update `PROGRESS.md`):
1. **Compact the teacher screen** so the table fills the first screen at 1440×900 and on a tablet: collapse "Who can move cards?" and the action buttons into a slim bar or a `<details>`, and shrink the room-code banner (keep the code large enough to read from a projector).
2. **Flip/reveal on the table** for decks with `rules.allowFlip`: let a permitted user flip the top card (face-down cards show "?"; students never receive hidden text). Add a `board:flip`-based button/tap gesture in `Table.tsx` and tests.
3. **Polish the table:** a draw animation that flies the card to the discard, a discard that fans the last 2–3 cards, and a "projector mode" (larger cards/labels). Respect `prefers-reduced-motion`.
4. Re-run the full checks, then update `README.md`/`PROGRESS.md` and summarise exactly what you changed and what you could not verify.

Ask me before adding anything beyond this list (for example movable piles or a lesson picker).
