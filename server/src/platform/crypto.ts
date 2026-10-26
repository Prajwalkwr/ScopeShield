import crypto from 'node:crypto';

/**
 * Password hashing: scrypt (RFC 7914) via node:crypto.
 * Chosen over bcrypt/argon2 to avoid native build dependencies in constrained
 * deploy environments. Parameters are stored per-hash so they can be raised later
 * without invalidating existing passwords.
 *
 * Format: scrypt$N$r$p$keylen$saltB64$hashB64
 */
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keylen: 64, saltBytes: 16 };

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(SCRYPT.saltBytes);
  const hash = crypto.scryptSync(password.normalize('NFKC'), salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: 256 * 1024 * 1024,
  });
  return [
    'scrypt',
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    SCRYPT.keylen,
    salt.toString('base64'),
    hash.toString('base64'),
  ].join('$');
}

export function verifyPassword(password: string, stored: string): { ok: boolean; needsRehash: boolean } {
  try {
    const parts = stored.split('$');
    if (parts.length !== 7 || parts[0] !== 'scrypt') return { ok: false, needsRehash: false };
    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    const keylen = Number(parts[4]);
    const salt = Buffer.from(parts[5] ?? '', 'base64');
    const expected = Buffer.from(parts[6] ?? '', 'base64');
    if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p) || !Number.isFinite(keylen)) {
      return { ok: false, needsRehash: false };
    }
    const actual = crypto.scryptSync(password.normalize('NFKC'), salt, keylen, {
      N,
      r,
      p,
      maxmem: 256 * 1024 * 1024,
    });
    const ok = actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
    const needsRehash = ok && (N !== SCRYPT.N || r !== SCRYPT.r || p !== SCRYPT.p || keylen !== SCRYPT.keylen);
    return { ok, needsRehash };
  } catch {
    return { ok: false, needsRehash: false };
  }
}

/** Opaque, URL-safe random token. Returned to the caller once; only its hash is stored. */
export function generateOpaqueToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** SHA-256 hex digest — used for token-at-rest hashing, document hashing and snapshot hashing. */
export function sha256(input: string | Buffer): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/** Constant-time comparison for secrets of equal length. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Deterministic JSON serialisation (sorted keys, recursive) so a snapshot can be
 * hashed reproducibly regardless of property insertion order.
 */
export function canonicalJson(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(walk);
    if (v instanceof Date) return v.toISOString();
    const obj = v as Record<string, unknown>;
    if (seen.has(obj)) return '[cycle]';
    seen.add(obj);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) {
      const val = obj[k];
      if (val === undefined) continue;
      out[k] = walk(val);
    }
    return out;
  };
  return JSON.stringify(walk(value));
}

/** Short human-shareable id fragment (project codes, request refs). */
export function shortId(len = 6): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i += 1) out += alphabet[(bytes[i] ?? 0) % alphabet.length];
  return out;
}
