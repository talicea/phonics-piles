/**
 * Socket.IO event contract shared by client and server, plus Zod schemas for every client->server payload.
 * The server validates EVERY incoming payload against these schemas; the TypeScript types are a convenience only.
 */
import { z } from 'zod';
import { CONTROL_MODES } from './types';
import type { Ack, ControlMode, BoardView, LockMap, Permissions, Presence, RoomSnapshot, YouInfo } from './types';

const idStr = z.string().min(1).max(64);

export const CreateRoomPayloadSchema = z
  .object({
    /** Built-in deck id. */
    deckId: idStr.optional(),
    /** Uploaded deck (validated separately with DeckSchema on the server). */
    deck: z.unknown().optional(),
  })
  .strict()
  .refine((p) => (p.deckId === undefined) !== (p.deck === undefined), { message: 'Provide exactly one of deckId or deck.' });

export const JoinPayloadSchema = z
  .object({
    roomCode: z.string().min(1).max(16),
    displayName: z.string().max(100).optional(),
    /** Present when re-joining after a dropped connection. */
    participantToken: z.string().min(8).max(128).optional(),
  })
  .strict();

export const HostResumePayloadSchema = z
  .object({ roomCode: z.string().min(1).max(16), hostToken: z.string().min(16).max(128) })
  .strict();

export const LockPayloadSchema = z.object({ cardId: idStr }).strict();

export const MovePayloadSchema = z
  .object({
    cardId: idStr,
    toPileId: idStr,
    /** Position in the destination pile AFTER the card has been removed from its old spot. Clamped by the server. */
    toIndex: z.number().int().min(0).max(1000),
    /** Board version the client was looking at. Used to reject a move of a card that has changed since. */
    baseVersion: z.number().int().min(0).optional(),
  })
  .strict();

export const FlipPayloadSchema = z.object({ cardId: idStr, baseVersion: z.number().int().min(0).optional() }).strict();

export const ShufflePayloadSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('all') }).strict(),
  z.object({ scope: z.literal('pile'), pileId: idStr }).strict(),
]);

export const SetPermissionsPayloadSchema = z
  .object({
    mode: z.enum(CONTROL_MODES as [ControlMode, ...ControlMode[]]),
    activeStudentId: idStr.nullable().optional(),
  })
  .strict();

export const PileDrawPayloadSchema = z
  .object({
    pileId: idStr,
    /** The card the client sees on top. If the top card has changed (e.g. a double tap), the draw is rejected as stale. */
    expectedCardId: idStr.optional(),
  })
  .strict();
export const PileUndoPayloadSchema = z.object({ pileId: idStr }).strict();
export const PileRecyclePayloadSchema = z.object({ pileId: idStr, shuffle: z.boolean().optional() }).strict();

export const PracticeStartPayloadSchema = z
  .object({
    text: z.string().min(1).max(12),
    cat: z.string().max(4).optional(),
    count: z.string().max(4).optional(),
    lesson: z.number().int().min(0).max(99).optional(),
  })
  .strict();
export const PracticePointsPayloadSchema = z
  .object({
    /** Flattened [x0,y0,x1,y1,...] in 0..1 card space. Max ~40 points per batch. */
    points: z.array(z.number().min(0).max(1)).min(2).max(80).refine((a) => a.length % 2 === 0, 'Points must come in x,y pairs.'),
  })
  .strict();
export const PracticeEndPayloadSchema = z.object({}).strict();

export const PracticeMarkPayloadSchema = z
  .object({
    participantId: idStr,
    card: z
      .object({
        id: idStr,
        text: z.string().min(1).max(12),
        cat: z.string().max(4).optional(),
        count: z.string().max(4).optional(),
        lesson: z.number().int().min(0).max(99).optional(),
        sourceDeckId: z.string().max(64).optional(),
      })
      .strict(),
  })
  .strict();
export const PracticeUnmarkPayloadSchema = z
  .object({ participantId: idStr, cardId: idStr })
  .strict();
export const PracticeAllowSelfPayloadSchema = z
  .object({ enabled: z.boolean() })
  .strict();
export const PracticeImportPayloadSchema = z
  .object({
    participantId: idStr,
    /** Replace the student's list with these cards (validated). */
    cards: z
      .array(
        z
          .object({
            id: idStr,
            text: z.string().min(1).max(12),
            cat: z.string().max(4).optional(),
            count: z.string().max(4).optional(),
            lesson: z.number().int().min(0).max(99).optional(),
            sourceDeckId: z.string().max(64).optional(),
            addedAt: z.number().optional(),
          })
          .strict(),
      )
      .max(40),
  })
  .strict();

export const LoadDeckPayloadSchema = CreateRoomPayloadSchema;

export type CreateRoomPayload = z.infer<typeof CreateRoomPayloadSchema>;
export type JoinPayload = z.infer<typeof JoinPayloadSchema>;
export type HostResumePayload = z.infer<typeof HostResumePayloadSchema>;
export type LockPayload = z.infer<typeof LockPayloadSchema>;
export type MovePayload = z.infer<typeof MovePayloadSchema>;
export type FlipPayload = z.infer<typeof FlipPayloadSchema>;
export type PileDrawPayload = z.infer<typeof PileDrawPayloadSchema>;
export type PileUndoPayload = z.infer<typeof PileUndoPayloadSchema>;
export type PileRecyclePayload = z.infer<typeof PileRecyclePayloadSchema>;
export type ShufflePayload = z.infer<typeof ShufflePayloadSchema>;
export type SetPermissionsPayload = z.infer<typeof SetPermissionsPayloadSchema>;
export type PracticeStartPayload = z.infer<typeof PracticeStartPayloadSchema>;
export type PracticePointsPayload = z.infer<typeof PracticePointsPayloadSchema>;
export type PracticeEndPayload = z.infer<typeof PracticeEndPayloadSchema>;
export type PracticeMarkPayload = z.infer<typeof PracticeMarkPayloadSchema>;
export type PracticeUnmarkPayload = z.infer<typeof PracticeUnmarkPayloadSchema>;
export type PracticeAllowSelfPayload = z.infer<typeof PracticeAllowSelfPayloadSchema>;
export type PracticeImportPayload = z.infer<typeof PracticeImportPayloadSchema>;

export interface CreateRoomResult { roomCode: string; hostToken: string; you: YouInfo; snapshot: RoomSnapshot }
export interface JoinResult { you: YouInfo; snapshot: RoomSnapshot; participantToken?: string }

export interface ClientToServerEvents {
  'room:create': (p: CreateRoomPayload, ack: Ack<CreateRoomResult>) => void;
  'room:join': (p: JoinPayload, ack: Ack<JoinResult>) => void;
  'host:resume': (p: HostResumePayload, ack: Ack<JoinResult>) => void;
  'host:end': (p: Record<string, never>, ack: Ack) => void;
  'host:set-permissions': (p: SetPermissionsPayload, ack: Ack) => void;
  'host:load-deck': (p: CreateRoomPayload, ack: Ack) => void;
  'board:reset': (p: Record<string, never>, ack: Ack) => void;
  'card:lock': (p: LockPayload, ack: Ack) => void;
  'card:unlock': (p: LockPayload, ack: Ack) => void;
  'board:move': (p: MovePayload, ack: Ack) => void;
  'board:flip': (p: FlipPayload, ack: Ack) => void;
  'board:shuffle': (p: ShufflePayload, ack: Ack) => void;
  /** Tap the top card of a pile: it moves to that pile's discard and the next card shows. */
  'pile:draw': (p: PileDrawPayload, ack: Ack) => void;
  /** Put the most recently drawn card back on top of its pile. */
  'pile:undo': (p: PileUndoPayload, ack: Ack) => void;
  /** Return the discards to the pile (shuffled by default). */
  'pile:recycle': (p: PileRecyclePayload, ack: Ack) => void;
  /** Student starts tracing a practice card (live mirror for the teacher). */
  'practice:start': (p: PracticeStartPayload, ack: Ack) => void;
  /** Batched normalised pointer points while tracing. */
  'practice:points': (p: PracticePointsPayload, ack: Ack) => void;
  /** Student finished or left the tracing canvas. */
  'practice:end': (p: PracticeEndPayload, ack: Ack) => void;
  /** Teacher marks a card for a student's tracing practice list. */
  'practice:mark': (p: PracticeMarkPayload, ack: Ack) => void;
  /** Teacher (or student if allowed) removes a card from a practice list. */
  'practice:unmark': (p: PracticeUnmarkPayload, ack: Ack) => void;
  /** Teacher toggles whether students may self-mark cards. */
  'practice:allow-self': (p: PracticeAllowSelfPayload, ack: Ack) => void;
  /** Teacher loads a previously saved practice JSON onto a student in the room. */
  'practice:import': (p: PracticeImportPayload, ack: Ack) => void;
}

export type EndReason = 'host-ended' | 'expired' | 'server-restart';

export interface ServerToClientEvents {
  'room:snapshot': (s: RoomSnapshot) => void;
  'board:update': (b: BoardView) => void;
  'board:locks': (l: LockMap) => void;
  'room:permissions': (p: Permissions) => void;
  'room:presence': (p: Presence) => void;
  'room:ended': (info: { reason: EndReason }) => void;
  /** This participant opened the room in another tab/device; this socket is no longer bound. */
  'session:replaced': () => void;
  /** A student started tracing (teacher only). */
  'practice:student-start': (info: { participantId: string; name: string; text: string; cat?: string; count?: string; lesson?: number }) => void;
  /** Live trace points from a student (teacher only). */
  'practice:student-points': (info: { participantId: string; points: number[] }) => void;
  /** A student stopped tracing (teacher only). */
  'practice:student-end': (info: { participantId: string }) => void;
  /** Practice lists changed (host gets all lists; students get only their own). */
  'practice:update': (state: import('./types').PracticeState) => void;
}

export const EVENTS = {
  create: 'room:create',
  join: 'room:join',
  resume: 'host:resume',
} as const;

/** Normalise what a person typed into a room code: upper-case, letters and digits only. */
export function normalizeRoomCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Characters used in room codes: no 0/O/1/I/L so codes are easy to read aloud and from a projector. */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Clean a student's display name: strip control chars, collapse whitespace, cap length. Empty string if nothing is left. */
export function sanitizeDisplayName(input: string | undefined, maxLength = 24): string {
  if (!input) return '';
  // eslint-disable-next-line no-control-regex
  const cleaned = input.replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(cleaned).slice(0, maxLength).join('').trim();
}
