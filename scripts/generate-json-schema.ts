/** Writes docs/deck.schema.json from the Zod schema (the single source of truth). Run: npm run schema:json */
import fs from 'node:fs';
import { z } from 'zod';
import { DeckSchema } from '../shared/src/deck';

const schema = z.toJSONSchema(DeckSchema, { io: 'input' });
fs.writeFileSync('docs/deck.schema.json', JSON.stringify({ $id: 'https://example.invalid/phonics-piles/deck-v1.schema.json', title: 'Phonics Piles deck (schemaVersion 1)', ...schema }, null, 2) + '\n');
console.log('wrote docs/deck.schema.json');
