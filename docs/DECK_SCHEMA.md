# Deck schema (version 1)

A deck is a JSON file describing **exactly three piles** of cards (beginning / middle / ending, or whatever you label them)
and a few interaction rules. Decks are **data only**: nothing in them is executed, and card text is always rendered as plain text.

The schema lives in `shared/src/deck.ts` (Zod) and is exported as JSON Schema in [`deck.schema.json`](deck.schema.json)
(`npm run schema:json` regenerates it). Unknown properties are rejected so typos are caught.

## Example

```json
{
  "schemaVersion": 1,
  "id": "my-first-deck",
  "name": "My first deck",
  "description": "Optional text shown in the deck list.",
  "version": "1.0.0",
  "piles": [
    { "id": "start", "label": "Start",  "cards": [ { "id": "s-s", "text": "s" }, { "id": "s-sh", "text": "sh", "tags": ["digraph"] } ] },
    { "id": "mid",   "label": "Middle", "cards": [ { "id": "v-a", "text": "a" }, { "id": "v-i", "text": "i" } ] },
    { "id": "end",   "label": "End",    "cards": [ { "id": "n-t", "text": "t" }, { "id": "n-ck", "text": "ck" } ] }
  ],
  "rules": { "allowCrossPileMoves": true, "allowReorder": true, "allowFlip": false, "initialShuffle": false },
  "tags": ["example"]
}
```

## Fields

| Field | Required | Description |
|---|---|---|
| `schemaVersion` | yes | Must be `1`. |
| `id` | yes | 1–64 chars: letters, digits, `-`, `_`. Identifies the deck. |
| `name` | yes | 1–80 visible characters. |
| `description` | no | Up to 300 characters. |
| `version` | yes | Your own version string, e.g. `"1.0.0"` (max 20 chars). |
| `piles` | yes | Array of **exactly 3** piles. |
| `piles[].id` | yes | Unique within the deck (same character rules as `id`). |
| `piles[].label` | yes | Shown to everyone (e.g. "Beginning sound"). 1–40 chars. |
| `piles[].cards` | yes | 1–60 cards. |
| `cards[].id` | yes | **Unique across the whole deck** (cards can move between piles). Never derived from text. |
| `cards[].text` | yes | 1–16 characters, shown exactly as written (case preserved). Multi-letter phonograms (`sh`, `tch`, `ight`) are fine. Visible text may repeat as long as the ids differ. No control characters. |
| `cards[].faceDown` | no | Start face-down. Students are not sent the text of face-down cards. |
| `cards[].tags` | no | Up to 8 short lesson/skill tags (informational). |
| `rules.allowCrossPileMoves` | no (true) | Cards may move to another pile. |
| `rules.allowReorder` | no (true) | Cards may be re-ordered inside their pile. |
| `rules.allowFlip` | no (false) | Enables flip / reveal. |
| `rules.initialShuffle` | no (false) | Shuffle every pile when the room is created. "Reset board" returns to this starting arrangement. |
| `tags` | no | Up to 10 deck-level tags. |

## Limits

* ≤ 150 cards in total; the file must be ≤ `MAX_DECK_BYTES` (default 100 KB).
* A deck does **not** have to make valid words from every combination; teachers choose which combinations suit the lesson.

## How the pile works

The first card of each pile (marked **TOP**) is the one shown in the "word strip" above the piles; the three top cards read left-to-right
as the current (nonsense) word. Drag a card to the front of a pile — or use **Make top** — to change the word.

## Validation

Every deck is validated in the browser (to give instant feedback) **and again on the server** (never trusted) before a room uses it.
Errors name the exact place, e.g. `piles[2].cards[4].text: Card text must not be empty.` (numbers are 1-based).

## Card formatting (optional)

A deck may describe how its cards look. Everything here is optional; decks without it are drawn as plain tiles / script letters.
All values are validated: colours must be hex (`#990000` or `#900`), fonts come from a fixed list, numbers are range-checked.
Sizes are **fractions** of the card (so cards look the same at any size).

* `cardAspectRatio` (deck) — width ÷ height, 0.4–2.5 (a 4×6 in portrait card is `0.66617`).
* `cardStyle` (deck) — defaults for every card; `style` (card) overrides it. Fields:

| Field | Meaning |
|---|---|
| `fontId` | `default`, `serif`, or `playwrite-co` (bundled cursive font) |
| `fontWeight` | 100–900 |
| `fontSize` | text size, fraction of card height (0.1–0.9) |
| `glyphY` | text baseline position, fraction of card height |
| `textColor`, `outlineColor`, `outlineWidth` | colour, outline colour (default = text colour) and outline thickness as a fraction of the font size |
| `background`, `borderColor`, `borderWidth`, `cornerRadius` | card face; border thickness and rounding as fractions of card width |
| `corners` | `topLeft` / `topRight` / `bottomLeft` / `bottomRight`, each `{ "text": "2", "color": "#990000", "fontId": "serif", "size": 0.056 }` (text ≤ 6 chars) |

Example card: `{ "id": "middle-a", "text": "a", "tags": ["lesson-1"], "style": { "textColor": "#990000", "corners": { "topLeft": { "text": "2", "color": "#990000" } } } }`

## Piles, top cards and discards (at run time)

In a room each pile is a *draw pile* plus a *discard*. The first card of the draw pile is the **top** card. Tapping a pile moves its top card to the discard; the deck file itself only lists the cards.
