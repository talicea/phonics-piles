import type { Deck } from '@shared/index';
import type { ServerConfig } from '../config';
import { generateRoomCode, generateToken } from '../util/ids';
import { Room, type Change } from './room';
import type { Rng } from '../game/engine';

export class RoomManager {
  private rooms = new Map<string, Room>();
  constructor(private readonly config: ServerConfig, private readonly rng?: Rng) {}

  get size(): number {
    return this.rooms.size;
  }

  get(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  /** Returns null when the server is at capacity. The returned host token is shown to the caller exactly once. */
  create(deck: Deck, now: number): { room: Room; hostToken: string } | null {
    if (this.rooms.size >= this.config.maxRooms) return null;
    const code = generateRoomCode(this.config.roomCodeLength, (c) => this.rooms.has(c));
    const hostToken = generateToken();
    const room = new Room({
      code, hostToken, deck, now,
      lockTtlMs: this.config.lockTtlMs,
      maxParticipants: this.config.maxParticipantsPerRoom,
      ...(this.rng ? { rng: this.rng } : {}),
    });
    this.rooms.set(code, room);
    return { room, hostToken };
  }

  delete(code: string): void {
    this.rooms.delete(code);
  }

  /**
   * Housekeeping for every room. Expired rooms are removed and returned so the caller can notify any
   * remaining clients; other rooms report what changed so the caller can broadcast it.
   */
  sweep(now: number): { expired: Room[]; changed: Array<{ room: Room; changes: Change[] }> } {
    const expired: Room[] = [];
    const changed: Array<{ room: Room; changes: Change[] }> = [];
    for (const room of [...this.rooms.values()]) {
      const tooOld = now - room.createdAt >= this.config.roomMaxAgeMs;
      const abandoned = room.emptySince !== null && now - room.emptySince >= this.config.roomIdleTtlMs;
      if (tooOld || abandoned) {
        this.rooms.delete(room.code);
        expired.push(room);
        continue;
      }
      const changes = room.sweep(now, this.config.participantGraceMs);
      if (changes.length) changed.push({ room, changes });
    }
    return { expired, changed };
  }
}
