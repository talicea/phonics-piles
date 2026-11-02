import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import { Server, type Socket } from 'socket.io';
import {
  CreateRoomPayloadSchema, FlipPayloadSchema, HostResumePayloadSchema, JoinPayloadSchema, LoadDeckPayloadSchema, LockPayloadSchema,
  MovePayloadSchema, PileDrawPayloadSchema, PileRecyclePayloadSchema, PileUndoPayloadSchema,
  PracticeAllowSelfPayloadSchema, PracticeEndPayloadSchema, PracticeImportPayloadSchema, PracticeMarkPayloadSchema, PracticePointsPayloadSchema, PracticeStartPayloadSchema, PracticeUnmarkPayloadSchema,
  SetPermissionsPayloadSchema, ShufflePayloadSchema, formatIssues, normalizeRoomCode, validateDeck,
  type Ack, type AckResult, type ClientToServerEvents, type CreateRoomPayload, type Deck, type ErrorCode, type ServerToClientEvents,
  type Role, type EndReason,
} from '@shared/index';
import type { ZodType } from 'zod';
import type { ServerConfig } from './config';
import { DeckLibrary } from './deckLibrary';
import { toBoardView } from './game/engine';
import { RoomManager } from './rooms/roomManager';
import { ownerId, type Actor, type Change, type Room } from './rooms/room';
import { TokenBucket, WindowLimiter } from './util/rateLimit';
import type { Rng } from './game/engine';

interface SocketData {
  roomCode?: string;
  role?: Role;
  participantId?: string;
  bucket: TokenBucket;
  /** Tracing point batches have their own allowance so a long stroke cannot starve taps (and vice versa). */
  pointsBucket: TokenBucket;
}
type GameSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
type Handler = (socket: GameSocket, payload: unknown) => AckResult<Record<string, unknown>> | Promise<AckResult<Record<string, unknown>>>;

export interface GameServerOptions {
  now?: () => number;
  rng?: Rng;
  log?: (message: string) => void;
}

export interface GameServer {
  httpServer: http.Server;
  io: Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
  rooms: RoomManager;
  decks: DeckLibrary;
  config: ServerConfig;
  listen(): Promise<number>;
  /** Run housekeeping immediately (the interval timer calls this too). Exposed for tests. */
  sweep(): void;
  /** Tell every room the server is going away, then close. */
  shutdown(reason?: EndReason): Promise<void>;
}

const err = (code: ErrorCode, message: string, details?: string[]): AckResult => ({ ok: false, code, message, ...(details ? { details } : {}) });
const hostChannel = (code: string) => `r:${code}:host`;
const studentChannel = (code: string) => `r:${code}:students`;

export function createGameServer(config: ServerConfig, options: GameServerOptions = {}): GameServer {
  const now = options.now ?? Date.now;
  const log = options.log ?? ((m: string) => console.log(m));
  // Built-in decks ship with the app, so they are validated against a fixed limit rather than the (tunable) upload limit.
  const decks = new DeckLibrary(config.decksDir, 1024 * 1024);
  const rooms = new RoomManager(config, options.rng);
  const createLimiter = new WindowLimiter(config.createPerMinute, 60_000);
  const joinLimiter = new WindowLimiter(config.joinPerMinute, 60_000);

  // ------------------------------------------------------------------ HTTP
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'connect-src': ["'self'", 'ws:', 'wss:'],
          'img-src': ["'self'", 'data:'],
          // Don't force https upgrades during local http development.
          'upgrade-insecure-requests': config.isProduction ? [] : null,
        },
      },
    }),
  );

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', rooms: rooms.size, uptimeSeconds: Math.round(process.uptime()) });
  });
  app.get('/api/config', (_req, res) => {
    res.json({ maxDeckBytes: config.maxDeckBytes, roomCodeLength: config.roomCodeLength });
  });
  app.get('/api/decks', (_req, res) => {
    res.json({ decks: decks.list() });
  });
  app.get('/api/decks/:id', (req, res) => {
    const deck = decks.get(String(req.params.id));
    if (!deck) {
      res.status(404).json({ error: 'Deck not found' });
      return;
    }
    res.json(deck);
  });

  const indexHtml = path.join(config.clientDistDir, 'index.html');
  if (fs.existsSync(indexHtml)) {
    app.use(
      express.static(config.clientDistDir, {
        index: false,
        setHeaders(res, filePath) {
          // Vite emits content-hashed files under /assets: safe to cache hard. Everything else must revalidate.
          res.setHeader('Cache-Control', filePath.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache');
        },
      }),
    );
    app.use((req, res, next) => {
      if ((req.method !== 'GET' && req.method !== 'HEAD') || req.path.startsWith('/api/') || req.path.startsWith('/socket.io/')) return next();
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(indexHtml);
    });
  } else {
    app.get('/', (_req, res) => {
      res.type('text/plain').send('Phonics Piles server is running, but the client has not been built. Run "npm run build" (or "npm run dev" for development).');
    });
  }
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  const httpServer = http.createServer(app);

  // ------------------------------------------------------------- Socket.IO
  const io = new Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>(httpServer, {
    // Large enough for a maximum-size deck upload plus envelope, but no larger.
    maxHttpBufferSize: config.maxDeckBytes + 16 * 1024,
    ...(config.corsOrigins.length ? { cors: { origin: config.corsOrigins } } : {}),
  });

  // ---- broadcasting (every emit is scoped to ONE room's channels)
  function emitBoth<K extends keyof ServerToClientEvents>(room: Room, event: K, hostArgs: Parameters<ServerToClientEvents[K]>, studentArgs: Parameters<ServerToClientEvents[K]>) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (io.to(hostChannel(room.code)) as any).emit(event, ...hostArgs);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (io.to(studentChannel(room.code)) as any).emit(event, ...studentArgs);
  }

  function broadcast(room: Room, changes: Change[]): void {
    const set = new Set(changes);
    if (set.has('snapshot')) {
      // Practice lists are per student, so each student gets a snapshot built for THEM (never someone else's list).
      io.to(hostChannel(room.code)).emit('room:snapshot', room.snapshot(true));
      for (const sid of room.allSocketIds()) {
        const sock = io.sockets.sockets.get(sid);
        if (sock && sock.data.role === 'student') sock.emit('room:snapshot', room.snapshot(false, sock.data.participantId));
      }
      return;
    }
    if (set.has('board')) emitBoth(room, 'board:update', [toBoardView(room.board, true)], [toBoardView(room.board, false)]);
    if (set.has('locks')) io.to([hostChannel(room.code), studentChannel(room.code)]).emit('board:locks', room.lockMap());
    if (set.has('permissions')) io.to([hostChannel(room.code), studentChannel(room.code)]).emit('room:permissions', { ...room.permissions });
    if (set.has('presence')) emitBoth(room, 'room:presence', [room.presence(true)], [room.presence(false)]);
    if (set.has('practice')) {
      // Host gets every list; each student only their own.
      io.to(hostChannel(room.code)).emit('practice:update', room.practiceState(true));
      for (const sid of room.allSocketIds()) {
        const sock = io.sockets.sockets.get(sid);
        if (!sock || sock.data.role !== 'student' || !sock.data.participantId) continue;
        sock.emit('practice:update', room.practiceState(false, sock.data.participantId));
      }
    }
  }

  function detachSocket(id: string): void {
    const s = io.sockets.sockets.get(id);
    if (!s) return;
    for (const r of s.rooms) if (r !== s.id) void s.leave(r);
    delete s.data.roomCode;
    delete s.data.role;
    delete s.data.participantId;
  }

  function endRoom(room: Room, reason: EndReason): void {
    io.to([hostChannel(room.code), studentChannel(room.code)]).emit('room:ended', { reason });
    for (const id of room.allSocketIds()) detachSocket(id);
    rooms.delete(room.code); // invalidates the code AND the host token (it only ever existed inside the room)
  }

  // ---- identity
  function clientIp(socket: GameSocket): string {
    if (config.trustProxy) {
      const fwd = socket.handshake.headers['x-forwarded-for'];
      const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
      if (first) return first;
    }
    return socket.handshake.address;
  }

  /** The socket's room + actor, derived ONLY from server-side state (never from anything the client claims). */
  function sessionOf(socket: GameSocket): { room: Room; actor: Actor } | AckResult {
    const code = socket.data.roomCode;
    const room = code ? rooms.get(code) : undefined;
    if (!room) return err('NOT_IN_ROOM', 'This session is no longer available.');
    if (socket.data.role === 'host') {
      if (!room.isHostSocket(socket.id)) return err('UNAUTHORIZED', 'Not authorised.');
      return { room, actor: { role: 'host' } };
    }
    const pid = socket.data.participantId;
    if (socket.data.role !== 'student' || !pid || !room.hasStudent(pid)) return err('NOT_IN_ROOM', 'You are not in this room.');
    return { room, actor: { role: 'student', participantId: pid } };
  }
  const isError = (x: unknown): x is Extract<AckResult, { ok: false }> => typeof x === 'object' && x !== null && 'ok' in x && (x as { ok: unknown }).ok === false;

  function resolveDeck(p: CreateRoomPayload): { ok: true; deck: Deck } | Extract<AckResult, { ok: false }> {
    if (p.deckId !== undefined) {
      const deck = decks.get(p.deckId);
      return deck ? { ok: true, deck } : (err('DECK_NOT_FOUND', 'That deck does not exist.') as Extract<AckResult, { ok: false }>);
    }
    // Uploaded deck: size-check the serialised form, then validate with the same schema the client used. Never trust the client's check.
    let size = 0;
    try {
      size = Buffer.byteLength(JSON.stringify(p.deck) ?? '', 'utf8');
    } catch {
      return err('INVALID_DECK', 'The deck could not be read.') as Extract<AckResult, { ok: false }>;
    }
    if (size > config.maxDeckBytes) {
      return err('INVALID_DECK', `Deck is too large (limit ${(config.maxDeckBytes / 1024).toFixed(0)} KB).`) as Extract<AckResult, { ok: false }>;
    }
    const v = validateDeck(p.deck);
    return v.ok ? { ok: true, deck: v.deck } : (err('INVALID_DECK', 'The deck is not valid.', v.errors) as Extract<AckResult, { ok: false }>);
  }

  // ---- event registration helper: validation, rate limiting, error containment
  const SKIP_BUCKET = new Set(['room:create', 'room:join', 'host:resume']);
  function on(socket: GameSocket, event: keyof ClientToServerEvents, schema: ZodType | null, handler: Handler): void {
    // The typed overloads can't express "payload is unknown until validated", so we use a raw listener.
    (socket as unknown as { on(e: string, cb: (payload: unknown, ack: unknown) => void): void }).on(event, (payload, ackFn) => {
      const ack: Ack<Record<string, unknown>> = typeof ackFn === 'function' ? (ackFn as Ack<Record<string, unknown>>) : () => undefined;
      void (async () => {
        try {
          if (!SKIP_BUCKET.has(event) && !(event === 'practice:points' ? socket.data.pointsBucket : socket.data.bucket).take(now())) return ack(err('RATE_LIMITED', 'Slow down a little.') as never);
          let parsed: unknown = payload;
          if (schema) {
            const r = schema.safeParse(payload ?? {});
            if (!r.success) return ack(err('BAD_REQUEST', 'Malformed request.', formatIssues(r.error.issues)) as never);
            parsed = r.data;
          }
          ack((await handler(socket, parsed)) as never);
        } catch (e) {
          log(`[error] ${event}: ${e instanceof Error ? e.message : 'unknown'}`); // never log payloads: they may contain secrets
          ack(err('INTERNAL', 'Something went wrong on the server.') as never);
        }
      })();
    });
  }

  io.on('connection', (socket: GameSocket) => {
    socket.data.bucket = new TokenBucket(config.actionBurst, config.actionRefillPerSec, now());
    socket.data.pointsBucket = new TokenBucket(20, 12, now());

    on(socket, 'room:create', CreateRoomPayloadSchema, (s, raw) => {
      if (!createLimiter.hit(clientIp(s), now())) return err('RATE_LIMITED', 'Too many games created from this network. Try again in a minute.');
      if (s.data.roomCode) return err('BAD_REQUEST', 'This connection is already in a room.');
      const d = resolveDeck(raw as CreateRoomPayload);
      if (isError(d)) return d;
      const created = rooms.create(d.deck, now());
      if (!created) return err('SERVER_BUSY', 'The server is busy right now. Please try again shortly.');
      const { room, hostToken } = created;
      room.bindHost(s.id);
      s.data.roomCode = room.code;
      s.data.role = 'host';
      void s.join(hostChannel(room.code));
      log(`[room] created ${room.code} (${rooms.size} active)`);
      return { ok: true, roomCode: room.code, hostToken, you: { role: 'host', participantId: null, displayName: 'Teacher' }, snapshot: room.snapshot(true) };
    });

    on(socket, 'room:join', JoinPayloadSchema, (s, raw) => {
      const p = raw as import('@shared/index').JoinPayload;
      if (!joinLimiter.hit(clientIp(s), now())) return err('RATE_LIMITED', 'Too many attempts. Wait a minute and try again.');
      if (s.data.roomCode) return err('BAD_REQUEST', 'This connection is already in a room.');
      const room = rooms.get(normalizeRoomCode(p.roomCode));
      if (!room) return err('ROOM_NOT_FOUND', 'We could not find that room. Check the code, or ask your teacher for a new one.');

      let participantId: string;
      let name: string;
      let token: string | undefined;
      const rebound = p.participantToken ? room.rebindStudent(p.participantToken, s.id) : null;
      if (rebound && rebound.ok) {
        participantId = rebound.participant.id;
        name = rebound.participant.name;
        if (rebound.previousSocketId) {
          io.to(rebound.previousSocketId).emit('session:replaced');
          detachSocket(rebound.previousSocketId);
        }
      } else {
        const added = room.addStudent(p.displayName, s.id);
        if (!added.ok) return added;
        participantId = added.participant.id;
        name = added.participant.name;
        token = added.token;
      }
      s.data.roomCode = room.code;
      s.data.role = 'student';
      s.data.participantId = participantId;
      void s.join(studentChannel(room.code));
      broadcast(room, ['presence']);
      return { ok: true, you: { role: 'student', participantId, displayName: name }, snapshot: room.snapshot(false, participantId), ...(token ? { participantToken: token } : {}) };
    });

    on(socket, 'host:resume', HostResumePayloadSchema, (s, raw) => {
      const p = raw as import('@shared/index').HostResumePayload;
      if (!joinLimiter.hit(clientIp(s), now())) return err('RATE_LIMITED', 'Too many attempts. Wait a minute and try again.');
      if (s.data.roomCode) return err('BAD_REQUEST', 'This connection is already in a room.');
      const room = rooms.get(normalizeRoomCode(p.roomCode));
      if (!room) return err('ROOM_NOT_FOUND', 'That game no longer exists.');
      if (!room.verifyHostToken(p.hostToken)) return err('UNAUTHORIZED', 'Not authorised.');
      room.bindHost(s.id);
      s.data.roomCode = room.code;
      s.data.role = 'host';
      void s.join(hostChannel(room.code));
      broadcast(room, ['presence']);
      return { ok: true, you: { role: 'host', participantId: null, displayName: 'Teacher' }, snapshot: room.snapshot(true) };
    });

    /** Wrap a handler that needs an authenticated session. */
    const withSession = (fn: (room: Room, actor: Actor, s: GameSocket, payload: unknown) => AckResult<Record<string, unknown>>): Handler => (s, payload) => {
      const session = sessionOf(s);
      if (isError(session)) return session;
      if (!('room' in session)) return session as AckResult<Record<string, unknown>>;
      return fn(session.room, session.actor, s, payload);
    };
    const hostOnly = (fn: (room: Room, actor: Actor, s: GameSocket, payload: unknown) => AckResult<Record<string, unknown>>): Handler =>
      withSession((room, actor, s, payload) => (actor.role === 'host' ? fn(room, actor, s, payload) : err('FORBIDDEN', 'Only the teacher can do that.')));

    /** Run a Room method, broadcast what changed, resync the sender if their view was out of date. */
    const finish = (room: Room, s: GameSocket, res: ReturnType<Room['reset']>): AckResult => {
      if (!res.ok) {
        if (res.code === 'STALE' || res.code === 'CARD_NOT_FOUND') s.emit('room:snapshot', room.snapshot(s.data.role === 'host', s.data.participantId));
        return err(res.code, res.message);
      }
      broadcast(room, res.changes);
      return { ok: true };
    };

    on(socket, 'card:lock', LockPayloadSchema, withSession((room, actor, s, p) => finish(room, s, room.lockCard(actor, (p as { cardId: string }).cardId, now()))));
    on(socket, 'card:unlock', LockPayloadSchema, withSession((room, actor, s, p) => finish(room, s, room.unlockCard(actor, (p as { cardId: string }).cardId))));
    on(socket, 'board:move', MovePayloadSchema, withSession((room, actor, s, p) => finish(room, s, room.moveCard(actor, p as import('@shared/index').MovePayload, now()))));
    on(socket, 'board:flip', FlipPayloadSchema, withSession((room, actor, s, p) => finish(room, s, room.flipCard(actor, p as import('@shared/index').FlipPayload, now()))));
    on(socket, 'board:shuffle', ShufflePayloadSchema, withSession((room, actor, s, p) => {
      const sp = p as import('@shared/index').ShufflePayload;
      return finish(room, s, room.shuffle(actor, sp.scope === 'all' ? 'all' : sp.pileId, now()));
    }));

    on(socket, 'pile:draw', PileDrawPayloadSchema, withSession((room, actor, s, p) => finish(room, s, room.drawCard(actor, p as import('@shared/index').PileDrawPayload, now()))));
    on(socket, 'pile:undo', PileUndoPayloadSchema, withSession((room, actor, s, p) => finish(room, s, room.undoDraw(actor, p as import('@shared/index').PileUndoPayload, now()))));
    on(socket, 'pile:recycle', PileRecyclePayloadSchema, withSession((room, actor, s, p) => finish(room, s, room.recycle(actor, p as import('@shared/index').PileRecyclePayload, now()))));

    on(socket, 'board:reset', null, hostOnly((room, actor, s) => finish(room, s, room.reset(actor))));
    on(socket, 'host:set-permissions', SetPermissionsPayloadSchema, hostOnly((room, actor, s, p) => {
      const sp = p as import('@shared/index').SetPermissionsPayload;
      return finish(room, s, room.setPermissions(actor, sp.mode, sp.activeStudentId));
    }));
    on(socket, 'host:load-deck', LoadDeckPayloadSchema, hostOnly((room, actor, s, p) => {
      const d = resolveDeck(p as CreateRoomPayload);
      if (isError(d)) return d;
      return finish(room, s, room.loadDeck(actor, d.deck));
    }));
    // ---- Practice lists (mark / unmark / allow self)
    on(socket, 'practice:mark', PracticeMarkPayloadSchema, withSession((room, actor, s, p) => {
      const payload = p as import('@shared/index').PracticeMarkPayload;
      return finish(room, s, room.markPractice(actor, payload.participantId, payload.card, now()));
    }));
    on(socket, 'practice:unmark', PracticeUnmarkPayloadSchema, withSession((room, actor, s, p) => {
      const payload = p as import('@shared/index').PracticeUnmarkPayload;
      return finish(room, s, room.unmarkPractice(actor, payload.participantId, payload.cardId));
    }));
    on(socket, 'practice:allow-self', PracticeAllowSelfPayloadSchema, hostOnly((room, actor, s, p) => {
      const payload = p as import('@shared/index').PracticeAllowSelfPayload;
      return finish(room, s, room.setAllowSelfAssessment(actor, payload.enabled));
    }));
    on(socket, 'practice:import', PracticeImportPayloadSchema, hostOnly((room, actor, s, p) => {
      const payload = p as import('@shared/index').PracticeImportPayload;
      return finish(room, s, room.importPractice(actor, payload.participantId, payload.cards, now()));
    }));

    // ---- Tracing practice live mirror (student → teacher only)
    on(socket, 'practice:start', PracticeStartPayloadSchema, withSession((room, actor, s, p) => {
      if (actor.role !== 'student') return err('FORBIDDEN', 'Only students stream tracing practice.');
      const payload = p as import('@shared/index').PracticeStartPayload;
      if (!room.canTraceText(actor.participantId, payload.text)) return err('CARD_NOT_FOUND', 'That is not a card in this deck or on your practice list.');
      const name = room.participantName(actor.participantId) ?? 'Student';
      io.to(hostChannel(room.code)).emit('practice:student-start', {
        participantId: actor.participantId,
        name,
        text: payload.text,
        cat: payload.cat,
        count: payload.count,
        lesson: payload.lesson,
      });
      return { ok: true };
    }));
    on(socket, 'practice:points', PracticePointsPayloadSchema, withSession((room, actor, s, p) => {
      if (actor.role !== 'student') return err('FORBIDDEN', 'Only students stream tracing practice.');
      const payload = p as import('@shared/index').PracticePointsPayload;
      io.to(hostChannel(room.code)).emit('practice:student-points', {
        participantId: actor.participantId,
        points: payload.points,
      });
      return { ok: true };
    }));
    on(socket, 'practice:end', PracticeEndPayloadSchema, withSession((room, actor, s, p) => {
      if (actor.role !== 'student') return err('FORBIDDEN', 'Only students stream tracing practice.');
      io.to(hostChannel(room.code)).emit('practice:student-end', { participantId: actor.participantId });
      return { ok: true };
    }));

    on(socket, 'host:end', null, hostOnly((room) => {
      log(`[room] ended ${room.code}`);
      endRoom(room, 'host-ended');
      return { ok: true };
    }));

    socket.on('disconnect', () => {
      const code = socket.data.roomCode;
      const room = code ? rooms.get(code) : undefined;
      if (!room) return;
      // A student who vanishes mid-stroke must not leave a stuck "is tracing" thumbnail on the teacher's screen.
      if (socket.data.role === 'student' && socket.data.participantId) io.to(hostChannel(room.code)).emit('practice:student-end', { participantId: socket.data.participantId });
      const changes = socket.data.role === 'host' ? room.unbindHost(socket.id, now()) : room.unbindStudent(socket.data.participantId ?? '', socket.id, now());
      if (changes.length) broadcast(room, changes);
    });
  });

  // ---------------------------------------------------------- housekeeping
  function sweep(): void {
    const t = now();
    createLimiter.prune(t);
    joinLimiter.prune(t);
    const { expired, changed } = rooms.sweep(t);
    for (const room of expired) {
      log(`[room] expired ${room.code}`);
      io.to([hostChannel(room.code), studentChannel(room.code)]).emit('room:ended', { reason: 'expired' });
      for (const id of room.allSocketIds()) detachSocket(id);
    }
    for (const { room, changes } of changed) broadcast(room, changes);
  }
  const timer = setInterval(sweep, config.sweepIntervalMs);
  timer.unref();

  return {
    httpServer, io, rooms, decks, config,
    listen: () => new Promise<number>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(config.port, config.host, () => {
        const addr = httpServer.address();
        resolve(typeof addr === 'object' && addr ? addr.port : config.port);
      });
    }),
    sweep,
    async shutdown(reason: EndReason = 'server-restart') {
      clearInterval(timer);
      io.emit('room:ended', { reason });
      await new Promise<void>((resolve) => void io.close(() => resolve()));
    },
  };
}

export { ownerId };
