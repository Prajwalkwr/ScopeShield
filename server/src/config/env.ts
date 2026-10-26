import path from 'node:path';
import dotenv from 'dotenv';

// Load the repo-root .env first (shared by server + web), then server/.env if present.
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

function str(key: string, fallback = ''): string {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}
function num(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function bool(key: string, fallback = false): boolean {
  const v = str(key).toLowerCase();
  if (v === '') return fallback;
  return v === 'true' || v === '1' || v === 'yes';
}

const NODE_ENV = str('NODE_ENV', 'development') as 'development' | 'test' | 'production';

/** Guard: a production boot with a default secret is a critical misconfiguration. */
const rawSecret = str('SESSION_SECRET');
const isDefaultSecret = rawSecret === '' || rawSecret.startsWith('replace-me');
if (NODE_ENV === 'production' && isDefaultSecret) {
  // Fail closed rather than silently running production with a known key.
  throw new Error(
    'FATAL: SESSION_SECRET must be set to a unique random value in production. ' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"',
  );
}

export const env = {
  nodeEnv: NODE_ENV,
  isProd: NODE_ENV === 'production',
  isTest: NODE_ENV === 'test',
  port: num('PORT', 4000),
  apiPublicUrl: str('API_PUBLIC_URL', 'http://localhost:4000'),
  webPublicUrl: str('WEB_PUBLIC_URL', 'http://localhost:5173'),
  corsOrigins: str('CORS_ORIGINS', 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  sessionSecret: isDefaultSecret
    ? 'dev-only-insecure-secret-do-not-use-in-production'
    : rawSecret,
  cookieSecure: bool('COOKIE_SECURE', NODE_ENV === 'production'),
  mongoUri: str('MONGODB_URI'),
  useEmbeddedDb: bool('USE_EMBEDDED_DB', false),
  storageDriver: str('STORAGE_DRIVER', 'local') as 'local' | 's3',
  storageLocalDir: path.resolve(__dirname, '../../../', str('STORAGE_LOCAL_DIR', './data/uploads')),
  maxUploadMb: num('MAX_UPLOAD_MB', 15),
  mailDriver: str('MAIL_DRIVER', 'file') as 'file' | 'console' | 'smtp' | 'resend',
  mailFrom: str('MAIL_FROM', 'ScopeShield <no-reply@example.com>'),
  mailDir: path.resolve(__dirname, '../../../data/mail'),
  aiProvider: str('AI_PROVIDER', 'heuristic') as 'heuristic' | 'openai' | 'anthropic',
  aiMonthlyBudgetUsd: num('AI_MONTHLY_BUDGET_USD', 25),
  aiMaxInputChars: num('AI_MAX_INPUT_CHARS', 24000),
  openaiApiKey: str('OPENAI_API_KEY'),
  openaiModel: str('OPENAI_MODEL', 'gpt-4o-mini'),
  openaiBaseUrl: str('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
  anthropicApiKey: str('ANTHROPIC_API_KEY'),
  anthropicModel: str('ANTHROPIC_MODEL', 'claude-3-5-sonnet-latest'),
  approvalTokenTtlDays: num('APPROVAL_TOKEN_TTL_DAYS', 14),
  defaultCurrency: str('DEFAULT_CURRENCY', 'USD'),
} as const;

export type Env = typeof env;
