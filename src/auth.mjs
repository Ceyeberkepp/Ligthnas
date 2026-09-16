import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, 64);
  return `scrypt:${salt}:${Buffer.from(derived).toString('hex')}`;
}

export async function verifyPassword(password, encoded) {
  const [algorithm, salt, expectedHex] = String(encoded).split(':');
  if (algorithm !== 'scrypt' || !salt || !expectedHex) return false;
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = Buffer.from(await scrypt(password, salt, expected.length));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export class Sessions {
  constructor() {
    this.sessions = new Map();
  }

  create(username) {
    const token = randomBytes(32).toString('base64url');
    this.sessions.set(token, { username, expiresAt: Date.now() + 12 * 60 * 60 * 1000 });
    return token;
  }

  get(token) {
    const session = this.sessions.get(token);
    if (!session || session.expiresAt < Date.now()) {
      if (token) this.sessions.delete(token);
      return null;
    }
    return session;
  }

  delete(token) {
    this.sessions.delete(token);
  }
}
