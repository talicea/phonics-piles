/** Types describing what travels over the wire (what clients are allowed to see). */
import type { DeckRules } from './deck';

export type Role = 'host' | 'student';

/** Who may manipulate cards. The host can always manipulate. */
export type ControlMode = 'teacher-only' | 'all-students' | 'one-student';
export const CONTROL_MODES: readonly ControlMode[] = ['teacher-only', 'all-students', 'one-student'];

export interface Permissions {
  mode: ControlMode;
  /** Only meaningful when mode === 'one-student'. */
  activeStudentId: string | null;
}

/** A card as seen by a client. `text` is null when the card is face-down and the viewer is not the host. */
export interface CardView {
  id: string;
  text: string | null;
  faceDown: boolean;
}

export interface PileView {
  id: string;
  label: string;
  cards: CardView[];
}

export interface BoardView {
  /** Increments every time the arrangement changes. */
  version: number;
  piles: PileView[];
}

export interface LockInfo {
  /** 'host' or a participant id. */
  by: string;
  byName: string;
}
export type LockMap = Record<string, LockInfo>;

export interface ParticipantView {
  id: string;
  name: string;
  connected: boolean;
}

export interface DeckMeta {
  id: string;
  name: string;
  description: string;
  version: string;
  rules: DeckRules;
}

export interface Presence {
  participantCount: number; // connected students
  hostConnected: boolean;
  /** Only sent to the host. */
  participants?: ParticipantView[];
}

export interface RoomSnapshot {
  roomCode: string;
  deck: DeckMeta;
  board: BoardView;
  locks: LockMap;
  permissions: Permissions;
  presence: Presence;
}

export interface YouInfo {
  role: Role;
  /** Null for the host. */
  participantId: string | null;
  displayName: string;
}

export type ErrorCode =
  | 'BAD_REQUEST'
  | 'RATE_LIMITED'
  | 'ROOM_NOT_FOUND'
  | 'ROOM_FULL'
  | 'SERVER_BUSY'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_IN_ROOM'
  | 'INVALID_DECK'
  | 'DECK_NOT_FOUND'
  | 'CARD_NOT_FOUND'
  | 'PILE_NOT_FOUND'
  | 'PARTICIPANT_NOT_FOUND'
  | 'CARD_LOCKED'
  | 'STALE'
  | 'RULE_VIOLATION'
  | 'INTERNAL';

export type Ack<T = object> = (res: ({ ok: true } & T) | { ok: false; code: ErrorCode; message: string; details?: string[] }) => void;
export type AckResult<T = object> = Parameters<Ack<T>>[0];
