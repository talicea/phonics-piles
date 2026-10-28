/**
 * One game session. All authoritative state lives here; socket handlers are thin wrappers.
 * Everything takes an explicit `now` so tests can control time (lock expiry, grace periods).
 *
 * CONFLICT RULES (predictable, documented in the README):
 *  1. A card can be locked by one participant at a time (taken when a drag starts, 8 s TTL by default).
 *  2. Another student cannot lock / move / flip a card that is locked by someone else (CARD_LOCKED).
 *  3. The teacher always wins: a host action overrides and clears a student's lock.
 *  4. Each card remembers the board version at which it last changed. A client that names a `baseVersion`
 *     older than that is rejected with STALE ("first writer wins"), so nobody silently overwrites a newer change.
 *  5. Shuffle / reset / deck-load change many cards at once; they invalidate in-flight moves via rule 4.
 */
import type { Deck, ErrorCode, LockMap, Permissions, ParticipantView, Presence, RoomSnapshot, DeckMeta, FlipPayload, MovePayload } from '@shared/index';
import { sanitizeDisplayName } from '@shared/index';
import {
  allCardIds, cloneBoard, createBoard, findCard, findPile, flipCard, moveCard, restoreBoard, shuffleBoard, toBoardView,
  type BoardState, type Rng, secureRandomInt,
} from '../game/engine';
import { generateParticipantId, generateToken, hashToken, tokenMatches } from '../util/ids';

export type Actor = { role: 'host' } | { role: 'student'; participantId: string };
export type Change = 'board' | 'locks' | 'permissions' | 'presence' | 'snapshot';
export type RoomResult<T extends object = object> =
  | ({ ok: true; changes: Change[] } & T)
  | { ok: false; code: ErrorCode; message: string };

export interface RoomOptions {
  code: string;
  hostToken: string;
  deck: Deck;
  now: number;
  lockTtlMs: number;
  maxParticipants: number;
  rng?: Rng;
}

interface Participant {
  id: string;
  name: string;
  tokenHash: Buffer;
  socketId: string | null;
  disconnectedAt: number | null;
}
interface Lock {
  by: string;
  byName: string;
  expiresAt: number;
}

const fail = (code: ErrorCode, message: string): { ok: false; code: ErrorCode; message: string } => ({ ok: false, code, message });
export const ownerId = (a: Actor): string => (a.role === 'host' ? 'host' : a.participantId);

export class Room {
  readonly code: string;
  readonly createdAt: number;
  private readonly hostTokenHash: Buffer;
  private readonly lockTtlMs: number;
  private readonly maxParticipants: number;
  private readonly rng: Rng;

  deck: Deck;
  board: BoardState;
  private initialBoard: BoardState;
  /** Board version at which each card last changed (rule 4). */
  private cardRev = new Map<string, number>();
  private locks = new Map<string, Lock>();
  permissions: Permissions = { mode: 'teacher-only', activeStudentId: null };
  private participants = new Map<string, Participant>();
  private hostSockets = new Set<string>();
  private studentCounter = 0;
  /** Time at which the last connection left (null while anyone is connected). */
  emptySince: number | null;

  constructor(opts: RoomOptions) {
    this.code = opts.code;
    this.createdAt = opts.now;
    this.hostTokenHash = hashToken(opts.hostToken);
    this.lockTtlMs = opts.lockTtlMs;
    this.maxParticipants = opts.maxParticipants;
    this.rng = opts.rng ?? secureRandomInt;
    this.deck = opts.deck;
    this.board = createBoard(opts.deck, this.rng);
    this.initialBoard = cloneBoard(this.board);
    this.emptySince = opts.now;
  }

  // ---------------------------------------------------------------- identity
  verifyHostToken(token: string): boolean {
    return tokenMatches(token, this.hostTokenHash);
  }
  isHostSocket(socketId: string): boolean {
    return this.hostSockets.has(socketId);
  }
  hasStudent(participantId: string): boolean {
    return this.participants.has(participantId);
  }
  participantName(participantId: string): string | undefined {
    return this.participants.get(participantId)?.name;
  }

  bindHost(socketId: string): Change[] {
    this.hostSockets.add(socketId);
    this.emptySince = null;
    return ['presence'];
  }

  /** Returns the removed socket's changes; locks held by the host are released when the last host socket leaves. */
  unbindHost(socketId: string, now: number): Change[] {
    if (!this.hostSockets.delete(socketId)) return [];
    const changes: Change[] = ['presence'];
    if (this.hostSockets.size === 0 && this.releaseLocksOf('host')) changes.push('locks');
    this.refreshEmpty(now);
    return changes;
  }

  addStudent(rawName: string | undefined, socketId: string): RoomResult<{ participant: ParticipantView; token: string }> {
    if (this.participants.size >= this.maxParticipants) return fail('ROOM_FULL', 'This room is full.');
    this.studentCounter += 1;
    let name = sanitizeDisplayName(rawName) || `Student ${this.studentCounter}`;
    const taken = new Set([...this.participants.values()].map((p) => p.name.toLowerCase()));
    if (taken.has(name.toLowerCase())) {
      let n = 2;
      while (taken.has(`${name} (${n})`.toLowerCase())) n++;
      name = `${name} (${n})`;
    }
    const token = generateToken();
    const participant: Participant = { id: generateParticipantId(), name, tokenHash: hashToken(token), socketId, disconnectedAt: null };
    this.participants.set(participant.id, participant);
    this.emptySince = null;
    return { ok: true, changes: ['presence'], participant: { id: participant.id, name, connected: true }, token };
  }

  /** Re-attach a returning student by their secret token. */
  rebindStudent(token: string, socketId: string): RoomResult<{ participant: ParticipantView; previousSocketId: string | null }> {
    for (const p of this.participants.values()) {
      if (tokenMatches(token, p.tokenHash)) {
        const previousSocketId = p.socketId && p.socketId !== socketId ? p.socketId : null;
        p.socketId = socketId;
        p.disconnectedAt = null;
        this.emptySince = null;
        return { ok: true, changes: ['presence'], participant: { id: p.id, name: p.name, connected: true }, previousSocketId };
      }
    }
    return fail('UNAUTHORIZED', 'Your seat in this room was not found. Please join again.');
  }

  /** Only acts if `socketId` is still the participant's current socket (a replaced tab disconnecting is ignored). */
  unbindStudent(participantId: string, socketId: string, now: number): Change[] {
    const p = this.participants.get(participantId);
    if (!p || p.socketId !== socketId) return [];
    p.socketId = null;
    p.disconnectedAt = now;
    const changes: Change[] = ['presence'];
    if (this.releaseLocksOf(p.id)) changes.push('locks');
    this.refreshEmpty(now);
    return changes;
  }

  private refreshEmpty(now: number): void {
    const anyone = this.hostSockets.size > 0 || [...this.participants.values()].some((p) => p.socketId !== null);
    this.emptySince = anyone ? null : (this.emptySince ?? now);
  }

  // ------------------------------------------------------------- permissions
  canManipulate(actor: Actor): boolean {
    if (actor.role === 'host') return true;
    if (!this.participants.has(actor.participantId)) return false;
    switch (this.permissions.mode) {
      case 'all-students': return true;
      case 'one-student': return this.permissions.activeStudentId === actor.participantId;
      default: return false;
    }
  }

  setPermissions(actor: Actor, mode: Permissions['mode'], activeStudentId: string | null | undefined): RoomResult {
    if (actor.role !== 'host') return fail('FORBIDDEN', 'Only the teacher can change who controls the board.');
    let active: string | null = null;
    if (mode === 'one-student') {
      const candidate = activeStudentId === undefined ? this.permissions.activeStudentId : activeStudentId;
      if (candidate !== null) {
        if (!this.participants.has(candidate)) return fail('PARTICIPANT_NOT_FOUND', 'That student is not in the room.');
        active = candidate;
      }
    }
    this.permissions = { mode, activeStudentId: active };
    const changes: Change[] = ['permissions'];
    // Anyone who lost the right to move cards also loses their locks immediately.
    for (const p of this.participants.values()) {
      if (!this.canManipulate({ role: 'student', participantId: p.id }) && this.releaseLocksOf(p.id)) changes.push('locks');
    }
    return { ok: true, changes };
  }

  // -------------------------------------------------------------------- locks
  /** Drop expired locks. Returns true if any were removed. */
  purgeExpiredLocks(now: number): boolean {
    let changed = false;
    for (const [cardId, lock] of this.locks) {
      if (lock.expiresAt <= now) {
        this.locks.delete(cardId);
        changed = true;
      }
    }
    return changed;
  }

  private releaseLocksOf(owner: string): boolean {
    let changed = false;
    for (const [cardId, lock] of this.locks) {
      if (lock.by === owner) {
        this.locks.delete(cardId);
        changed = true;
      }
    }
    return changed;
  }

  private actorName(actor: Actor): string {
    return actor.role === 'host' ? 'Teacher' : (this.participants.get(actor.participantId)?.name ?? 'Student');
  }

  /** Is the card held by someone other than `actor`? (Expired locks must be purged first.) */
  private lockedByOther(cardId: string, actor: Actor): Lock | null {
    const lock = this.locks.get(cardId);
    return lock && lock.by !== ownerId(actor) ? lock : null;
  }

  lockCard(actor: Actor, cardId: string, now: number): RoomResult {
    if (!this.canManipulate(actor)) return fail('FORBIDDEN', 'You cannot move cards right now.');
    if (!findCard(this.board, cardId)) return fail('CARD_NOT_FOUND', 'That card is not on the board.');
    this.purgeExpiredLocks(now);
    const other = this.lockedByOther(cardId, actor);
    if (other && actor.role !== 'host') return fail('CARD_LOCKED', `${other.byName} is moving that card.`);
    this.releaseLocksOf(ownerId(actor)); // one lock per participant
    this.locks.set(cardId, { by: ownerId(actor), byName: this.actorName(actor), expiresAt: now + this.lockTtlMs });
    return { ok: true, changes: ['locks'] };
  }

  unlockCard(actor: Actor, cardId: string): RoomResult {
    const lock = this.locks.get(cardId);
    if (!lock) return { ok: true, changes: [] };
    if (lock.by !== ownerId(actor) && actor.role !== 'host') return fail('FORBIDDEN', 'That card is locked by someone else.');
    this.locks.delete(cardId);
    return { ok: true, changes: ['locks'] };
  }

  // ------------------------------------------------------------ board actions
  /** Shared guard for move / flip: permission, existence, lock (rule 2/3) and staleness (rule 4). */
  private guardCardAction(actor: Actor, cardId: string, baseVersion: number | undefined, now: number): RoomResult {
    if (!this.canManipulate(actor)) return fail('FORBIDDEN', 'You cannot move cards right now.');
    if (!findCard(this.board, cardId)) return fail('CARD_NOT_FOUND', 'That card is not on the board.');
    this.purgeExpiredLocks(now);
    const other = this.lockedByOther(cardId, actor);
    if (other && actor.role !== 'host') return fail('CARD_LOCKED', `${other.byName} is moving that card.`);
    if (baseVersion !== undefined && baseVersion < this.board.version && (this.cardRev.get(cardId) ?? 0) > baseVersion) {
      return fail('STALE', 'That card was changed by someone else. Try again.');
    }
    return { ok: true, changes: [] };
  }

  private commit(board: BoardState, affected: string[]): void {
    this.board = board;
    for (const id of affected) {
      this.cardRev.set(id, board.version);
      this.locks.delete(id);
    }
  }

  moveCard(actor: Actor, p: MovePayload, now: number): RoomResult {
    const guard = this.guardCardAction(actor, p.cardId, p.baseVersion, now);
    if (!guard.ok) return guard;
    const res = moveCard(this.board, this.deck.rules, p.cardId, p.toPileId, p.toIndex);
    if (!res.ok) return res;
    if (!res.changed) {
      // Dropped back where it was: just release the drag lock.
      return { ok: true, changes: this.locks.get(p.cardId)?.by === ownerId(actor) && this.locks.delete(p.cardId) ? ['locks'] : [] };
    }
    const hadLock = this.locks.has(p.cardId);
    this.commit(res.board, res.affected);
    return { ok: true, changes: hadLock ? ['board', 'locks'] : ['board'] };
  }

  flipCard(actor: Actor, p: FlipPayload, now: number): RoomResult {
    const guard = this.guardCardAction(actor, p.cardId, p.baseVersion, now);
    if (!guard.ok) return guard;
    const res = flipCard(this.board, this.deck.rules, p.cardId);
    if (!res.ok) return res;
    const hadLock = this.locks.has(p.cardId);
    this.commit(res.board, res.affected);
    return { ok: true, changes: hadLock ? ['board', 'locks'] : ['board'] };
  }

  shuffle(actor: Actor, target: 'all' | string, now: number): RoomResult {
    if (!this.canManipulate(actor)) return fail('FORBIDDEN', 'You cannot move cards right now.');
    this.purgeExpiredLocks(now);
    const targetPiles = target === 'all' ? this.board.piles : this.board.piles.filter((pl) => pl.id === target);
    if (targetPiles.length === 0) return fail('PILE_NOT_FOUND', 'That pile does not exist.');
    if (actor.role !== 'host') {
      for (const pile of targetPiles) {
        for (const c of pile.cards) {
          const other = this.lockedByOther(c.id, actor);
          if (other) return fail('CARD_LOCKED', `${other.byName} is moving a card in that pile.`);
        }
      }
    }
    const res = shuffleBoard(this.board, target, this.rng);
    if (!res.ok) return res;
    const hadLocks = this.locks.size > 0;
    this.commit(res.board, res.affected);
    return { ok: true, changes: hadLocks ? ['board', 'locks'] : ['board'] };
  }

  reset(actor: Actor): RoomResult {
    if (actor.role !== 'host') return fail('FORBIDDEN', 'Only the teacher can reset the board.');
    this.board = restoreBoard(this.initialBoard, this.board.version);
    this.cardRev = new Map(allCardIds(this.board).map((id) => [id, this.board.version]));
    const hadLocks = this.locks.size > 0;
    this.locks.clear();
    return { ok: true, changes: hadLocks ? ['board', 'locks'] : ['board'] };
  }

  loadDeck(actor: Actor, deck: Deck): RoomResult {
    if (actor.role !== 'host') return fail('FORBIDDEN', 'Only the teacher can change the deck.');
    const previousVersion = this.board.version;
    this.deck = deck;
    this.board = createBoard(deck, this.rng);
    this.board.version = previousVersion + 1;
    this.initialBoard = cloneBoard(this.board);
    this.cardRev = new Map(allCardIds(this.board).map((id) => [id, this.board.version]));
    this.locks.clear();
    return { ok: true, changes: ['snapshot'] };
  }

  // ------------------------------------------------------------- serialisation
  deckMeta(): DeckMeta {
    const { id, name, description, version, rules } = this.deck;
    return { id, name, description, version, rules };
  }

  lockMap(): LockMap {
    const out: LockMap = {};
    for (const [cardId, l] of this.locks) out[cardId] = { by: l.by, byName: l.byName };
    return out;
  }

  connectedStudentCount(): number {
    let n = 0;
    for (const p of this.participants.values()) if (p.socketId !== null) n++;
    return n;
  }

  connectedSocketCount(): number {
    return this.hostSockets.size + this.connectedStudentCount();
  }

  presence(forHost: boolean): Presence {
    const presence: Presence = { participantCount: this.connectedStudentCount(), hostConnected: this.hostSockets.size > 0 };
    if (forHost) {
      presence.participants = [...this.participants.values()].map((p) => ({ id: p.id, name: p.name, connected: p.socketId !== null }));
    }
    return presence;
  }

  snapshot(forHost: boolean): RoomSnapshot {
    return {
      roomCode: this.code,
      deck: this.deckMeta(),
      board: toBoardView(this.board, forHost),
      locks: this.lockMap(),
      permissions: { ...this.permissions },
      presence: this.presence(forHost),
    };
  }

  // ------------------------------------------------------------------- upkeep
  /** Periodic housekeeping. Removes students who stayed disconnected past the grace period and expired locks. */
  sweep(now: number, participantGraceMs: number): Change[] {
    const changes = new Set<Change>();
    if (this.purgeExpiredLocks(now)) changes.add('locks');
    for (const p of [...this.participants.values()]) {
      if (p.socketId === null && p.disconnectedAt !== null && now - p.disconnectedAt >= participantGraceMs) {
        this.participants.delete(p.id);
        changes.add('presence');
        if (this.permissions.activeStudentId === p.id) {
          this.permissions = { ...this.permissions, activeStudentId: null };
          changes.add('permissions');
        }
      }
    }
    return [...changes];
  }

  /** All Socket.IO ids currently bound to this room (used when ending it). */
  allSocketIds(): string[] {
    return [...this.hostSockets, ...[...this.participants.values()].flatMap((p) => (p.socketId ? [p.socketId] : []))];
  }

  // keep helper referenced for tests / debugging
  hasCard(cardId: string): boolean {
    return findCard(this.board, cardId) !== null;
  }
  hasPile(pileId: string): boolean {
    return findPile(this.board, pileId) !== undefined;
  }
}
