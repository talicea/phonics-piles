/** Types describing what travels over the wire (what clients are allowed to see). */
import type { DeckRules } from './deck';
import type { CardStyle } from './style';

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
  /** The draw pile. cards[0] is the TOP card (the one showing). */
  cards: CardView[];
  /** Cards already drawn from this pile. discard[0] is the most recently drawn. */
  discard: CardView[];
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
  /** True when the deck has formatting: cards are drawn as designed cards. */
  styled: boolean;
  aspectRatio?: number;
  /** Deck-wide card formatting. */
  cardStyle?: CardStyle;
  /** Per-card formatting overrides, by card id (only cards that have any). */
  cardStyles: Record<string, CardStyle>;
}

export interface Presence {
  participantCount: number; // connected students
  hostConnected: boolean;
  /** Only sent to the host. */
  participants?: ParticipantView[];
}

/** A card the teacher has marked for tracing practice. */
export interface PracticeCard {
  id: string;
  text: string;
  cat?: string;
  count?: string;
  lesson?: number;
  sourceDeckId?: string;
  addedAt: number;
}

export interface PracticeState {
  /** When true, students may add cards to their own list. */
  allowSelfAssessment: boolean;
  /**
   * Practice lists by participant id.
   * Host snapshot includes every student; student snapshot includes only their own entry.
   */
  lists: Record<string, PracticeCard[]>;
}

export interface RoomSnapshot {
  roomCode: string;
  deck: DeckMeta;
  board: BoardView;
  locks: LockMap;
  permissions: Permissions;
  presence: Presence;
  practice: PracticeState;
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
