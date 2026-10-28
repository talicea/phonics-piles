import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { ROOM_CODE_ALPHABET } from '@shared/index';

/** Cryptographically secure room code, retried until `isTaken` says it is free. */
export function generateRoomCode(length: number, isTaken: (code: string) => boolean, maxAttempts = 50): string {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let code = '';
    for (let i = 0; i < length; i++) code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
    if (!isTaken(code)) return code;
  }
  throw new Error('Could not allocate a unique room code');
}

/** 256-bit URL-safe secret (host tokens, participant tokens). */
export const generateToken = (): string => randomBytes(32).toString('base64url');

export const generateParticipantId = (): string => `p_${randomBytes(6).toString('hex')}`;

/** Secrets are stored only as SHA-256 digests so a memory dump or accidental log never exposes a usable token. */
export const hashToken = (token: string): Buffer => createHash('sha256').update(token).digest();

export function tokenMatches(token: string, storedHash: Buffer): boolean {
  const candidate = hashToken(token);
  return candidate.length === storedHash.length && timingSafeEqual(candidate, storedHash);
}
