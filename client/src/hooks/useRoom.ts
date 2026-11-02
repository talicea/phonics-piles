/**
 * Connection + room state for one browser tab.
 *
 * - One Socket.IO connection per tab (module singleton).
 * - The server is authoritative: every action is sent as a request; the UI changes when the server broadcasts.
 * - After ANY reconnect the new socket is unauthenticated, so we re-send the host token / participant token and
 *   replace our state with the fresh snapshot (this is how reconnect + resync works).
 */
import { useCallback, useEffect, useReducer, useRef } from 'react';
import { io, type Socket } from 'socket.io-client';
import type {
  AckResult, BoardView, ClientToServerEvents, CreateRoomPayload, CreateRoomResult, EndReason, JoinResult, LockMap, Permissions, Presence,
  PracticeState, Role, RoomSnapshot, ServerToClientEvents, YouInfo, ControlMode,
} from '@shared/index';
import { SERVER_URL } from '../api';

export type ConnStatus = 'connecting' | 'online' | 'reconnecting' | 'offline';
export type EndedReason = EndReason | 'lost' | 'replaced';
type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

interface Session { role: Role; roomCode: string; you: YouInfo }
interface Creds { role: Role; roomCode: string; secret: string; displayName?: string }

export interface RoomState {
  conn: ConnStatus;
  phase: 'idle' | 'resuming' | 'active' | 'ended';
  session: Session | null;
  snapshot: RoomSnapshot | null;
  ended: EndedReason | null;
}

type Action =
  | { type: 'conn'; conn: ConnStatus }
  | { type: 'resuming' }
  | { type: 'joined'; session: Session; snapshot: RoomSnapshot }
  | { type: 'snapshot'; snapshot: RoomSnapshot }
  | { type: 'board'; board: BoardView }
  | { type: 'locks'; locks: LockMap }
  | { type: 'permissions'; permissions: Permissions }
  | { type: 'presence'; presence: Presence }
  | { type: 'practice'; practice: PracticeState }
  | { type: 'ended'; reason: EndedReason }
  | { type: 'reset' };

function reducer(state: RoomState, a: Action): RoomState {
  switch (a.type) {
    case 'conn': return { ...state, conn: a.conn };
    case 'resuming': return { ...state, phase: 'resuming' };
    case 'joined': return { ...state, phase: 'active', session: a.session, snapshot: a.snapshot, ended: null };
    case 'snapshot': return state.snapshot ? { ...state, snapshot: a.snapshot } : state;
    case 'board':
      // Ignore out-of-order updates.
      return state.snapshot && a.board.version >= state.snapshot.board.version ? { ...state, snapshot: { ...state.snapshot, board: a.board } } : state;
    case 'locks': return state.snapshot ? { ...state, snapshot: { ...state.snapshot, locks: a.locks } } : state;
    case 'permissions': return state.snapshot ? { ...state, snapshot: { ...state.snapshot, permissions: a.permissions } } : state;
    case 'presence': return state.snapshot ? { ...state, snapshot: { ...state.snapshot, presence: a.presence } } : state;
    case 'practice': return state.snapshot ? { ...state, snapshot: { ...state.snapshot, practice: a.practice } } : state;
    case 'ended': return { ...state, phase: 'ended', ended: a.reason, snapshot: null, session: null };
    case 'reset': return { ...state, phase: 'idle', ended: null, snapshot: null, session: null };
  }
}

// ---------------------------------------------------------------- storage of credentials
const HOST_KEY = 'phonics.host.v1'; // localStorage: survives closing the tab so the teacher can resume
const STUDENT_KEY = 'phonics.student.v1'; // sessionStorage: one seat per tab

function readCreds(): Creds | null {
  try {
    const h = localStorage.getItem(HOST_KEY);
    if (h) {
      const v = JSON.parse(h) as { roomCode?: string; hostToken?: string };
      if (v.roomCode && v.hostToken) return { role: 'host', roomCode: v.roomCode, secret: v.hostToken };
    }
    const s = sessionStorage.getItem(STUDENT_KEY);
    if (s) {
      const v = JSON.parse(s) as { roomCode?: string; participantToken?: string; displayName?: string };
      if (v.roomCode && v.participantToken) return { role: 'student', roomCode: v.roomCode, secret: v.participantToken, displayName: v.displayName ?? '' };
    }
  } catch { /* storage unavailable or corrupt: start fresh */ }
  return null;
}
function writeCreds(c: Creds | null): void {
  try {
    localStorage.removeItem(HOST_KEY);
    sessionStorage.removeItem(STUDENT_KEY);
    if (!c) return;
    if (c.role === 'host') localStorage.setItem(HOST_KEY, JSON.stringify({ roomCode: c.roomCode, hostToken: c.secret }));
    else sessionStorage.setItem(STUDENT_KEY, JSON.stringify({ roomCode: c.roomCode, participantToken: c.secret, displayName: c.displayName ?? '' }));
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------- practice live-mirror listeners (teacher UI)
export type PracticeStartInfo = { participantId: string; name: string; text: string; cat?: string; count?: string; lesson?: number };
export type PracticePointsInfo = { participantId: string; points: number[] };
export type PracticeEndInfo = { participantId: string };
type PracticeHandlers = {
  onStart?: (info: PracticeStartInfo) => void;
  onPoints?: (info: PracticePointsInfo) => void;
  onEnd?: (info: PracticeEndInfo) => void;
};
const practiceHandlers: PracticeHandlers = {};
export function setPracticeHandlers(h: PracticeHandlers) {
  practiceHandlers.onStart = h.onStart;
  practiceHandlers.onPoints = h.onPoints;
  practiceHandlers.onEnd = h.onEnd;
}

// ---------------------------------------------------------------- socket singleton
let socketSingleton: ClientSocket | null = null;
function getSocket(): ClientSocket {
  if (!socketSingleton) {
    const opts = { reconnectionDelayMax: 4000, timeout: 8000 };
    socketSingleton = (SERVER_URL ? io(SERVER_URL, opts) : io(opts)) as ClientSocket;
  }
  return socketSingleton;
}

const failure = (message: string): AckResult<never> => ({ ok: false, code: 'INTERNAL', message });

function request<T extends object = object>(event: keyof ClientToServerEvents, payload: unknown): Promise<AckResult<T>> {
  const s = getSocket();
  // Never queue actions while offline: they would be replayed against a stale view (and an unauthenticated socket).
  if (!s.connected) return Promise.resolve(failure('You are offline. Reconnecting…') as AckResult<T>);
  return new Promise((resolve) => {
    (s as unknown as { timeout(ms: number): { emit(e: string, p: unknown, cb: (err: Error | null, res: AckResult<T>) => void): void } })
      .timeout(8000)
      .emit(event, payload, (err, res) => resolve(err ? (failure('The server did not respond. Check your connection.') as AckResult<T>) : res));
  });
}

export const roomCodeFromUrl = (): string => new URLSearchParams(window.location.search).get('join') ?? '';

export function useRoom() {
  const credsRef = useRef<Creds | null>(readCreds());
  const [state, dispatch] = useReducer(reducer, undefined, (): RoomState => ({
    conn: 'connecting', phase: credsRef.current ? 'resuming' : 'idle', session: null, snapshot: null, ended: null,
  }));
  const hadSession = useRef(false);
  const authing = useRef(false);

  useEffect(() => { hadSession.current = state.phase === 'active'; }, [state.phase]);

  const clearCreds = useCallback(() => { credsRef.current = null; writeCreds(null); }, []);

  /** (Re-)authenticate this socket with stored credentials and load a fresh snapshot. */
  const authenticate = useCallback(async () => {
    const creds = credsRef.current;
    if (!creds || authing.current) return;
    authing.current = true;
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        const res = creds.role === 'host'
          ? await request<JoinResult>('host:resume', { roomCode: creds.roomCode, hostToken: creds.secret })
          : await request<JoinResult>('room:join', { roomCode: creds.roomCode, displayName: creds.displayName ?? '', participantToken: creds.secret });
        if (res.ok) {
          if (creds.role === 'student' && res.participantToken) {
            // Our seat had expired; the server gave us a fresh one.
            creds.secret = res.participantToken;
            creds.displayName = res.you.displayName;
            writeCreds(creds);
          }
          dispatch({ type: 'joined', session: { role: creds.role, roomCode: creds.roomCode, you: res.you }, snapshot: res.snapshot });
          return;
        }
        if (res.code === 'ROOM_NOT_FOUND' || res.code === 'UNAUTHORIZED' || res.code === 'BAD_REQUEST') {
          clearCreds();
          dispatch({ type: 'ended', reason: 'lost' });
          return;
        }
        if (!getSocket().connected) return; // the next 'connect' will try again
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      }
    } finally {
      authing.current = false;
    }
  }, [clearCreds]);

  useEffect(() => {
    const s = getSocket();
    const onConnect = () => { dispatch({ type: 'conn', conn: 'online' }); void authenticate(); };
    const onDisconnect = (reason: string) => {
      dispatch({ type: 'conn', conn: 'reconnecting' });
      if (reason === 'io server disconnect') s.connect(); // the server dropped us; socket.io will not retry by itself
    };
    const onConnectError = () => dispatch({ type: 'conn', conn: 'reconnecting' });
    const onAttempt = () => dispatch({ type: 'conn', conn: 'reconnecting' });
    const onSnapshot = (snapshot: RoomSnapshot) => dispatch({ type: 'snapshot', snapshot });
    const onBoard = (board: BoardView) => dispatch({ type: 'board', board });
    const onLocks = (locks: LockMap) => dispatch({ type: 'locks', locks });
    const onPerms = (permissions: Permissions) => dispatch({ type: 'permissions', permissions });
    const onPresence = (presence: Presence) => dispatch({ type: 'presence', presence });
    const onEnded = ({ reason }: { reason: EndReason }) => { clearCreds(); dispatch({ type: 'ended', reason }); };
    const onReplaced = () => { clearCreds(); dispatch({ type: 'ended', reason: 'replaced' }); };

    s.on('connect', onConnect);
    s.on('disconnect', onDisconnect);
    s.on('connect_error', onConnectError);
    s.io.on('reconnect_attempt', onAttempt);
    s.on('room:snapshot', onSnapshot);
    s.on('board:update', onBoard);
    s.on('board:locks', onLocks);
    s.on('room:permissions', onPerms);
    s.on('room:presence', onPresence);
    s.on('room:ended', onEnded);
    s.on('session:replaced', onReplaced);
    const onPracticeStart = (info: PracticeStartInfo) => practiceHandlers.onStart?.(info);
    const onPracticePoints = (info: PracticePointsInfo) => practiceHandlers.onPoints?.(info);
    const onPracticeEnd = (info: PracticeEndInfo) => practiceHandlers.onEnd?.(info);
    const onPracticeUpdate = (practice: PracticeState) => dispatch({ type: 'practice', practice });
    s.on('practice:student-start', onPracticeStart);
    s.on('practice:student-points', onPracticePoints);
    s.on('practice:student-end', onPracticeEnd);
    s.on('practice:update', onPracticeUpdate);
    if (s.connected) onConnect(); // listeners attached after the socket was already up (React StrictMode remount)
    else dispatch({ type: 'conn', conn: 'connecting' });
    return () => {
      s.off('connect', onConnect);
      s.off('disconnect', onDisconnect);
      s.off('connect_error', onConnectError);
      s.io.off('reconnect_attempt', onAttempt);
      s.off('room:snapshot', onSnapshot);
      s.off('board:update', onBoard);
      s.off('board:locks', onLocks);
      s.off('room:permissions', onPerms);
      s.off('room:presence', onPresence);
      s.off('room:ended', onEnded);
      s.off('session:replaced', onReplaced);
      s.off('practice:student-start', onPracticeStart);
      s.off('practice:student-points', onPracticePoints);
      s.off('practice:student-end', onPracticeEnd);
      s.off('practice:update', onPracticeUpdate);
    };
  }, [authenticate, clearCreds]);

  // ------------------------------------------------------------------ commands
  const createRoom = useCallback(async (payload: CreateRoomPayload) => {
    const res = await request<CreateRoomResult>('room:create', payload);
    if (res.ok) {
      credsRef.current = { role: 'host', roomCode: res.roomCode, secret: res.hostToken };
      writeCreds(credsRef.current);
      dispatch({ type: 'joined', session: { role: 'host', roomCode: res.roomCode, you: res.you }, snapshot: res.snapshot });
    }
    return res;
  }, []);

  const joinRoom = useCallback(async (roomCode: string, displayName: string) => {
    const res = await request<JoinResult>('room:join', { roomCode, ...(displayName.trim() ? { displayName } : {}) });
    if (res.ok && res.participantToken) {
      credsRef.current = { role: 'student', roomCode: res.snapshot.roomCode, secret: res.participantToken, displayName: res.you.displayName };
      writeCreds(credsRef.current);
      dispatch({ type: 'joined', session: { role: 'student', roomCode: res.snapshot.roomCode, you: res.you }, snapshot: res.snapshot });
    }
    return res;
  }, []);

  /** Leave the room locally (students) and return to the start screen. The socket stays open for the next game. */
  const leave = useCallback(() => {
    clearCreds();
    // A fresh connection is the simplest way to unbind this socket from its room.
    const s = getSocket();
    s.disconnect();
    s.connect();
    dispatch({ type: 'reset' });
  }, [clearCreds]);

  const endGame = useCallback(async () => {
    const res = await request('host:end', {});
    if (res.ok) { clearCreds(); dispatch({ type: 'reset' }); }
    return res;
  }, [clearCreds]);

  const dismissEnded = useCallback(() => dispatch({ type: 'reset' }), []);

  const actions = {
    lock: (cardId: string) => request('card:lock', { cardId }),
    unlock: (cardId: string) => request('card:unlock', { cardId }),
    move: (p: { cardId: string; toPileId: string; toIndex: number; baseVersion: number }) => request('board:move', p),
    flip: (cardId: string, baseVersion: number) => request('board:flip', { cardId, baseVersion }),
    shufflePile: (pileId: string) => request('board:shuffle', { scope: 'pile', pileId }),
    shuffleAll: () => request('board:shuffle', { scope: 'all' }),
    draw: (pileId: string, expectedCardId: string) => request('pile:draw', { pileId, expectedCardId }),
    undo: (pileId: string) => request('pile:undo', { pileId }),
    recycle: (pileId: string) => request('pile:recycle', { pileId }),
    reset: () => request('board:reset', {}),
    setPermissions: (mode: ControlMode, activeStudentId: string | null) => request('host:set-permissions', { mode, activeStudentId }),
    loadDeck: (payload: CreateRoomPayload) => request('host:load-deck', payload),
    practiceStart: (card: { text: string; cat?: string; count?: string; lesson?: number }) =>
      request('practice:start', card),
    practicePoints: (points: number[]) => request('practice:points', { points }),
    practiceEnd: () => request('practice:end', {}),
    practiceMark: (participantId: string, card: { id: string; text: string; cat?: string; count?: string; lesson?: number; sourceDeckId?: string }) =>
      request('practice:mark', { participantId, card }),
    practiceUnmark: (participantId: string, cardId: string) =>
      request('practice:unmark', { participantId, cardId }),
    practiceAllowSelf: (enabled: boolean) => request('practice:allow-self', { enabled }),
    practiceImport: (participantId: string, cards: { id: string; text: string; cat?: string; count?: string; lesson?: number; sourceDeckId?: string; addedAt?: number }[]) =>
      request('practice:import', { participantId, cards }),
  };

  return { state, createRoom, joinRoom, leave, endGame, dismissEnded, actions, hasSavedHost: credsRef.current?.role === 'host' };
}
