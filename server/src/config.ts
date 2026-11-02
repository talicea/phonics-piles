import path from 'node:path';
import { DECK_LIMITS } from '@shared/index';

export interface ServerConfig {
  port: number;
  host: string;
  isProduction: boolean;
  trustProxy: boolean;
  corsOrigins: string[];
  clientDistDir: string;
  decksDir: string;
  maxDeckBytes: number;
  maxRooms: number;
  maxParticipantsPerRoom: number;
  roomCodeLength: number;
  roomIdleTtlMs: number;
  roomMaxAgeMs: number;
  participantGraceMs: number;
  lockTtlMs: number;
  sweepIntervalMs: number;
  /** Per-socket token bucket for state-changing events. */
  actionBurst: number;
  actionRefillPerSec: number;
  /** Per-IP limits (per minute) for room creation and join / resume attempts. */
  createPerMinute: number;
  joinPerMinute: number;
}

function int(env: NodeJS.ProcessEnv, key: string, def: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
    throw new Error(`Invalid ${key}="${raw}": expected an integer between ${min} and ${max}.`);
  }
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<ServerConfig> = {}): ServerConfig {
  const cwd = process.cwd();
  const config: ServerConfig = {
    port: int(env, 'PORT', 3001, 0, 65535),
    host: env.HOST || '0.0.0.0',
    isProduction: env.NODE_ENV === 'production',
    trustProxy: env.TRUST_PROXY === 'true',
    corsOrigins: (env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    clientDistDir: path.resolve(cwd, env.CLIENT_DIST_DIR || 'dist/client'),
    decksDir: path.resolve(cwd, env.DECKS_DIR || 'decks'),
    maxDeckBytes: int(env, 'MAX_DECK_BYTES', DECK_LIMITS.defaultMaxBytes, 1024, 5 * 1024 * 1024),
    maxRooms: int(env, 'MAX_ROOMS', 500, 1, 100_000),
    maxParticipantsPerRoom: int(env, 'MAX_PARTICIPANTS_PER_ROOM', 100, 1, 1000),
    roomCodeLength: int(env, 'ROOM_CODE_LENGTH', 5, 4, 8),
    roomIdleTtlMs: int(env, 'ROOM_IDLE_TTL_MS', 30 * 60_000, 1000, 7 * 24 * 3_600_000),
    roomMaxAgeMs: int(env, 'ROOM_MAX_AGE_MS', 12 * 3_600_000, 1000, 7 * 24 * 3_600_000),
    participantGraceMs: int(env, 'PARTICIPANT_GRACE_MS', 5 * 60_000, 0, 24 * 3_600_000),
    lockTtlMs: int(env, 'LOCK_TTL_MS', 8000, 100, 120_000),
    sweepIntervalMs: int(env, 'SWEEP_INTERVAL_MS', 15_000, 50, 600_000),
    actionBurst: int(env, 'ACTION_BURST', 30, 1, 10_000),
    actionRefillPerSec: int(env, 'ACTION_REFILL_PER_SEC', 15, 1, 10_000),
    createPerMinute: int(env, 'CREATE_PER_MINUTE', 10, 1, 10_000),
    joinPerMinute: int(env, 'JOIN_PER_MINUTE', 30, 1, 10_000),
  };
  return { ...config, ...overrides };
}
