import path from 'node:path';
import { io as ioClient, type Socket } from 'socket.io-client';
import type { AckResult, ClientToServerEvents, CreateRoomResult, JoinResult, ServerToClientEvents } from '@shared/index';
import { loadConfig, type ServerConfig } from '../src/config';
import { createGameServer, type GameServer, type GameServerOptions } from '../src/gameServer';

export type TestSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export interface Harness {
  server: GameServer;
  url: string;
  sockets: TestSocket[];
  connect(): Promise<TestSocket>;
  stop(): Promise<void>;
}

export async function startHarness(overrides: Partial<ServerConfig> = {}, options: GameServerOptions = {}): Promise<Harness> {
  const config = loadConfig({}, {
    port: 0, host: '127.0.0.1',
    decksDir: path.resolve(process.cwd(), 'decks'),
    clientDistDir: '/nonexistent',
    sweepIntervalMs: 600_000, // tests call server.sweep() explicitly
    ...overrides,
  });
  const server = createGameServer(config, { log: () => undefined, ...options });
  const port = await server.listen();
  const url = `http://127.0.0.1:${port}`;
  const sockets: TestSocket[] = [];
  return {
    server, url, sockets,
    async connect() {
      const s: TestSocket = ioClient(url, { transports: ['websocket'], forceNew: true, reconnection: false });
      sockets.push(s);
      await new Promise<void>((resolve, reject) => {
        s.once('connect', () => resolve());
        s.once('connect_error', reject);
      });
      return s;
    },
    async stop() {
      for (const s of sockets) s.close();
      await server.shutdown();
    },
  };
}

/** Emit an event and resolve with the ack payload. */
export function call<T extends object = object>(socket: TestSocket, event: keyof ClientToServerEvents, payload: unknown = {}): Promise<AckResult<T>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`ack timeout for ${String(event)}`)), 3000);
    (socket as unknown as { emit(e: string, p: unknown, cb: (r: AckResult<T>) => void): void }).emit(event as string, payload, (res) => {
      clearTimeout(timer);
      resolve(res);
    });
  });
}

/** Resolve with the next event of this name (optionally matching a predicate). */
export function nextEvent<K extends keyof ServerToClientEvents>(socket: TestSocket, event: K, predicate: (...args: Parameters<ServerToClientEvents[K]>) => boolean = () => true, timeoutMs = 2000): Promise<Parameters<ServerToClientEvents[K]>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error(`timed out waiting for ${String(event)}`)); }, timeoutMs);
    const handler = (...args: Parameters<ServerToClientEvents[K]>) => {
      if (predicate(...args)) { off(); clearTimeout(timer); resolve(args); }
    };
    const off = () => (socket as unknown as { off(e: string, h: unknown): void }).off(event as string, handler);
    (socket as unknown as { on(e: string, h: unknown): void }).on(event as string, handler);
  });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function must<T extends object>(res: AckResult<T>): Extract<AckResult<T>, { ok: true }> {
  if (!res.ok) throw new Error(`expected ok but got ${res.code}: ${res.message}`);
  return res as Extract<AckResult<T>, { ok: true }>;
}

export async function createRoom(h: Harness, deckId = 'sample-cvc-short-vowels') {
  const host = await h.connect();
  const res = must<CreateRoomResult>(await call<CreateRoomResult>(host, 'room:create', { deckId }));
  return { host, ...res };
}

export async function joinRoom(h: Harness, roomCode: string, displayName?: string) {
  const student = await h.connect();
  const res = must<JoinResult>(await call<JoinResult>(student, 'room:join', { roomCode, ...(displayName ? { displayName } : {}) }));
  return { student, ...res };
}

export const firstCardId = (snapshot: { board: { piles: { cards: { id: string }[] }[] } }, pile = 0, index = 0): string => {
  const id = snapshot.board.piles[pile]?.cards[index]?.id;
  if (!id) throw new Error('no such card');
  return id;
};
