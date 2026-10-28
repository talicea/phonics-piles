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

export const LoadDeckPayloadSchema = CreateRoomPayloadSchema;

export type CreateRoomPayload = z.infer<typeof CreateRoomPayloadSchema>;
export type JoinPayload = z.infer<typeof JoinPayloadSchema>;
export type HostResumePayload = z.infer<typeof HostResumePayloadSchema>;
export type LockPayload = z.infer<typeof LockPayloadSchema>;
export type MovePayload = z.infer<typeof MovePayloadSchema>;
export type FlipPayload = z.infer<typeof FlipPayloadSchema>;
export type ShufflePayload = z.infer<typeof ShufflePayloadSchema>;
export type SetPermissionsPayload = z.infer<typeof SetPermissionsPayloadSchema>;

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
