/**
 * Session JWT verification.
 *
 * HS256 only, signature checked before any claim is trusted. Every failure is
 * an `AuthError`; the token and the secret never end up in a message.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import type { AuthResult } from './types.js';

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

type JwtOptions = {
  issuer?: string;
  audience?: string;
  now?: number;
};

/** JSON object parse that tolerates anything: returns `undefined` instead of throwing. */
function parseJsonObject(text: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  return parsed as Record<string, unknown>;
}

function decodeSegment(segment: string): string {
  return Buffer.from(segment, 'base64url').toString('utf8');
}

function audienceMatches(aud: unknown, expected: string): boolean {
  if (typeof aud === 'string') return aud === expected;
  if (Array.isArray(aud)) return aud.some((entry: unknown) => entry === expected);
  return false;
}

export function verifyJwt(token: string, secret: string, opts: JwtOptions = {}): AuthResult {
  const parts = token.split('.');
  if (parts.length !== 3) throw new AuthError('malformed token');

  const encodedHeader = parts[0];
  const encodedPayload = parts[1];
  const encodedSignature = parts[2];
  if (!encodedHeader || !encodedPayload || !encodedSignature) {
    throw new AuthError('malformed token');
  }

  const header = parseJsonObject(decodeSegment(encodedHeader));
  if (header === undefined) throw new AuthError('malformed token');
  if (header.alg !== 'HS256') throw new AuthError('unsupported alg');

  const expected = createHmac('sha256', secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest();
  const actual = Buffer.from(encodedSignature, 'base64url');
  if (actual.length !== expected.length) throw new AuthError('bad signature');
  if (!timingSafeEqual(actual, expected)) throw new AuthError('bad signature');

  const claims = parseJsonObject(decodeSegment(encodedPayload));
  if (claims === undefined) throw new AuthError('malformed token');

  const now = opts.now ?? Date.now() / 1000;
  const exp = claims.exp;
  if (typeof exp !== 'number' || !Number.isFinite(exp) || exp < now) {
    throw new AuthError('token expired');
  }

  const sub = claims.sub;
  if (typeof sub !== 'string' || sub === '') throw new AuthError('missing subject');

  if (opts.issuer !== undefined && claims.iss !== opts.issuer) {
    throw new AuthError('wrong issuer');
  }
  if (opts.audience !== undefined && !audienceMatches(claims.aud, opts.audience)) {
    throw new AuthError('wrong audience');
  }

  return { userId: sub };
}
