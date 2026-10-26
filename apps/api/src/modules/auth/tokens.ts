import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';

export interface AccessClaims {
  sub: string; // user id
  sid: string; // session id
}

export function signAccessToken(claims: AccessClaims, secret: string, ttlMinutes: number): string {
  return jwt.sign(claims, secret, { algorithm: 'HS256', expiresIn: ttlMinutes * 60 });
}

export function verifyAccessToken(
  token: string,
  secret: string,
  opts: { ignoreExpiration?: boolean } = {},
): AccessClaims | null {
  try {
    const payload = jwt.verify(token, secret, { algorithms: ['HS256'], ...opts });
    if (typeof payload === 'string' || typeof payload.sub !== 'string' || typeof payload.sid !== 'string') {
      return null;
    }
    return { sub: payload.sub, sid: payload.sid as string };
  } catch {
    return null;
  }
}

/** Opaque, high-entropy refresh token. Only its SHA-256 digest is stored. */
export function newRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
