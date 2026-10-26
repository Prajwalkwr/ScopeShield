import type { Server } from 'node:http';
import mongoose from 'mongoose';
import { createApp } from '../../src/app';
import { connectDatabase, disconnectDatabase } from '../../src/config/db';
import { resetRateLimits } from '../../src/middleware/rateLimit';

/**
 * Minimal cookie-aware HTTP client.
 *
 * We deliberately exercise the app through real HTTP rather than calling services directly:
 * cookies, CSRF, status codes and error envelopes are part of what must be verified, and a
 * service-level test would skip every one of them.
 */
export class TestClient {
  private cookies = new Map<string, string>();
  private csrfToken = '';
  private orgId = '';
  constructor(private readonly baseUrl: string) {}

  /** Sets the active organization, sent as X-Org-Id exactly as the web app does. */
  setOrg(orgId: string): void {
    this.orgId = orgId;
  }

  private cookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  private capture(res: Response): void {
    const raw = res.headers.getSetCookie?.() ?? [];
    for (const cookie of raw) {
      const [pair] = cookie.split(';');
      const eq = pair.indexOf('=');
      if (eq < 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === '' || /expires=thu, 01 jan 1970/i.test(cookie)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const csrf = this.cookies.get('ss_csrf');
    if (csrf) this.csrfToken = decodeURIComponent(csrf);
  }

  async request(
    method: string,
    path: string,
    opts: {
      body?: unknown;
      headers?: Record<string, string>;
      raw?: Buffer;
      contentType?: string;
      /** Deliberately omit the CSRF header, to prove the server refuses the request. */
      omitCsrf?: boolean;
    } = {},
  ): Promise<{ status: number; body: any; headers: Headers }> {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (this.orgId) headers['x-org-id'] = this.orgId;
    const cookie = this.cookieHeader();
    if (cookie) headers.cookie = cookie;
    if (method !== 'GET' && this.csrfToken && !opts.omitCsrf) headers['x-csrf-token'] = this.csrfToken;

    let body: BodyInit | undefined;
    if (opts.raw) {
      body = new Uint8Array(opts.raw);
      headers['content-type'] = opts.contentType ?? 'application/octet-stream';
    } else if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      headers['content-type'] = 'application/json';
    }

    const res = await fetch(`${this.baseUrl}${path}`, { method, headers, body, redirect: 'manual' });
    this.capture(res);
    const text = await res.text();
    let parsed: any = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed, headers: res.headers };
  }

  get = (p: string, headers?: Record<string, string>) => this.request('GET', p, { headers });
  post = (p: string, body?: unknown, headers?: Record<string, string>) => this.request('POST', p, { body: body ?? {}, headers });
  patch = (p: string, body?: unknown) => this.request('PATCH', p, { body: body ?? {} });
  del = (p: string) => this.request('DELETE', p);
  upload = (p: string, file: Buffer, filename: string, contentType: string, fields: Record<string, string> = {}) => {
    const boundary = `----scopeshield${Date.now()}`;
    const parts: Buffer[] = [];
    for (const [name, value] of Object.entries(fields)) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
    }
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
      ),
    );
    parts.push(file);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    return this.request('POST', p, { raw: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` });
  };
}

export interface Harness {
  baseUrl: string;
  client: () => TestClient;
  close: () => Promise<void>;
}

export async function startHarness(): Promise<Harness> {
  await connectDatabase();
  const app = createApp();
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not determine test server port.');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    client: () => new TestClient(baseUrl),
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await disconnectDatabase();
    },
  };
}

/**
 * Clears the in-process rate limiter and the database between tests.
 *
 * Without this, suites would interfere: the sign-up limiter is per-IP and every test runs from
 * 127.0.0.1, so five registrations would exhaust it for the rest of the file.
 */
export async function resetBetweenTests(): Promise<void> {
  resetRateLimits();
  await resetDatabase();
}

export async function resetDatabase(): Promise<void> {
  const collections = await mongoose.connection.db?.collections();
  for (const collection of collections ?? []) {
    await collection.deleteMany({});
  }
}

/**
 * Registers a user, then signs in.
 *
 * Registration deliberately does not create a session — a new account has no organization and
 * nothing to look at yet — so the journey always passes through the real login flow, which is
 * also where the CSRF cookie is issued.
 */
export async function signUp(client: TestClient, email: string, name: string, password = 'CorrectHorseBattery9!') {
  const registered = await client.post('/api/v1/auth/register', { email, name, password });
  if (registered.status !== 201) throw new Error(`register failed: ${registered.status} ${JSON.stringify(registered.body)}`);
  const loggedIn = await client.post('/api/v1/auth/login', { email, password });
  if (loggedIn.status !== 200) throw new Error(`login failed: ${loggedIn.status} ${JSON.stringify(loggedIn.body)}`);
  return { ...registered.body, csrfToken: loggedIn.body.csrfToken };
}
