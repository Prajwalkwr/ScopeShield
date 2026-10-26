import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { env } from '../config/env';
import { internal } from './errors';

/**
 * Private document storage behind an interface, so a deployment can swap local disk for
 * S3-compatible object storage without touching business logic.
 *
 * Security properties enforced here (not by callers):
 *  - storage keys are generated, never derived from user input (no path traversal);
 *  - files are written outside any static-serving directory;
 *  - downloads always go through an authorising controller.
 */
export interface StoredObject {
  key: string;
  sizeBytes: number;
  sha256: string;
}

export interface StorageDriver {
  /** Driver label, surfaced on /health and in boot logs. */
  readonly name: string;
  put(buffer: Buffer, opts: { extension: string }): Promise<StoredObject>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
  /** Sanity check used at boot to fail fast on a misconfigured directory. */
  ensureReady(): Promise<void>;
}

class LocalStorage implements StorageDriver {
  readonly name = 'local';
  constructor(private readonly root: string) {}

  async ensureReady(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
  }

  private resolveKey(key: string): string {
    // Defence in depth: only keys this driver could have generated are accepted, so no stored
    // value (or leaked one) can ever be turned into a path traversal or an absolute path.
    // Shape: YYYY/MM/<32 hex chars><optional extension>.
    if (!/^\d{4}\/\d{2}\/[a-f0-9]{32}(\.[a-z0-9]{1,5})?$/.test(key)) {
      throw internal('Invalid storage key');
    }
    const resolved = path.resolve(this.root, key);
    if (!resolved.startsWith(path.resolve(this.root))) throw internal('Invalid storage key');
    return resolved;
  }

  async put(buffer: Buffer, opts: { extension: string }): Promise<StoredObject> {
    const now = new Date();
    const year = String(now.getUTCFullYear());
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    await fs.mkdir(path.join(this.root, year, month), { recursive: true });
    const key = `${year}/${month}/${crypto.randomBytes(16).toString('hex')}${opts.extension}`;
    await fs.writeFile(this.resolveKey(key), buffer, { mode: 0o600 });
    return { key, sizeBytes: buffer.byteLength, sha256: crypto.createHash('sha256').update(buffer).digest('hex') };
  }

  async get(key: string): Promise<Buffer> {
    return fs.readFile(this.resolveKey(key));
  }

  async remove(key: string): Promise<void> {
    await fs.rm(this.resolveKey(key), { force: true });
  }
}

/**
 * S3-compatible driver placeholder. It is NOT implemented: enabling STORAGE_DRIVER=s3
 * fails loudly at boot rather than pretending to work. See docs/ARCHITECTURE.md for what
 * a production implementation must do (private bucket, signed short-lived URLs, SSE).
 */
class S3Storage implements StorageDriver {
  readonly name = 's3';
  async ensureReady(): Promise<void> {
    throw internal(
      'STORAGE_DRIVER=s3 is not implemented in this build. Use STORAGE_DRIVER=local, or implement the StorageDriver interface with your S3 SDK.',
    );
  }
  async put(): Promise<StoredObject> {
    throw internal('S3 storage driver is not implemented.');
  }
  async get(): Promise<Buffer> {
    throw internal('S3 storage driver is not implemented.');
  }
  async remove(): Promise<void> {
    throw internal('S3 storage driver is not implemented.');
  }
}

export const storage: StorageDriver =
  env.storageDriver === 's3' ? new S3Storage() : new LocalStorage(env.storageLocalDir);
