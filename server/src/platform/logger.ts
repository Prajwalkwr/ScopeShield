import { env } from '../config/env';

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN: Level = env.isTest ? 'warn' : env.isProd ? 'info' : 'debug';

/**
 * Structured single-line JSON logs. Deliberately dependency-free.
 * REDACTION: keys listed here are never printed, whatever a caller passes in.
 */
const REDACT_KEYS = [
  'password',
  'passwordhash',
  'newpassword',
  'currentpassword',
  'token',
  'tokenhash',
  'accesstoken',
  'refreshtoken',
  'authorization',
  'cookie',
  'apikey',
  'secret',
  'sessionsecret',
  'csrf',
];

function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth > 6) return '[deep]';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value instanceof Error) {
    return { name: value.name, message: value.message, code: (value as { code?: string }).code };
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT_KEYS.includes(k.toLowerCase()) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

function write(level: Level, msg: string, meta?: Record<string, unknown>) {
  if (ORDER[level] < ORDER[MIN]) return;
  const line = JSON.stringify({
    t: new Date().toISOString(),
    level,
    msg,
    ...(meta ? { meta: redact(meta) as Record<string, unknown> } : {}),
  });
  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => write('debug', msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => write('info', msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => write('warn', msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => write('error', msg, meta),
  child(bindings: Record<string, unknown>) {
    return {
      debug: (m: string, meta?: Record<string, unknown>) => write('debug', m, { ...bindings, ...meta }),
      info: (m: string, meta?: Record<string, unknown>) => write('info', m, { ...bindings, ...meta }),
      warn: (m: string, meta?: Record<string, unknown>) => write('warn', m, { ...bindings, ...meta }),
      error: (m: string, meta?: Record<string, unknown>) => write('error', m, { ...bindings, ...meta }),
    };
  },
};
export type Logger = typeof logger;
