import path from 'node:path';
import fs from 'node:fs';
import mongoose from 'mongoose';
import { env } from './env';
import { logger } from '../platform/logger';

let embeddedServer: { stop: () => Promise<boolean>; getUri: () => string } | null = null;

/**
 * Connection strategy:
 *  1. MONGODB_URI set              → use it (production / external dev server).
 *  2. otherwise, embedded MongoDB  → mongodb-memory-server, persisting to ./data/mongo
 *     so local development needs no install. The binary is cached under
 *     MONGOMS_DOWNLOAD_DIR (default ./.cache which is gitignored).
 */
export async function connectDatabase(): Promise<string> {
  let uri = env.mongoUri;

  if (!uri) {
    if (env.isProd) {
      throw new Error('MONGODB_URI must be set in production; the embedded development database is not allowed there.');
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { MongoMemoryServer } = require('mongodb-memory-server') as typeof import('mongodb-memory-server');
    const dataDir = path.resolve(__dirname, '../../../data/mongo');
    fs.mkdirSync(dataDir, { recursive: true });
    if (!process.env.MONGOMS_DOWNLOAD_DIR) {
      process.env.MONGOMS_DOWNLOAD_DIR = path.resolve(__dirname, '../../../.cache/mongodb-binaries');
    }
    logger.info('Starting embedded MongoDB for development', { dataDir });
    /**
     * A stable dbPath means the embedded database survives a restart, so seeded demo data and
     * anything you created locally are still there tomorrow. Without it, every `npm run dev`
     * starts from an empty database, which makes the app impossible to evaluate.
     *
     * This is a DEVELOPMENT convenience only: production requires MONGODB_URI, and the check
     * above refuses to start the embedded server when NODE_ENV=production.
     */
    /**
     * Test runs deliberately get an ephemeral instance: the integration suites create and drop
     * organizations, and pointing them at the same directory the developer's demo data lives in
     * would either wipe that data or make the seed refuse to run because it sees "real" records.
     */
    const persist = env.nodeEnv !== 'test';
    const server = await MongoMemoryServer.create({
      instance: {
        dbName: 'scopeshield',
        storageEngine: 'wiredTiger',
        ...(persist ? { dbPath: dataDir } : {}),
      },
    });
    embeddedServer = server;
    uri = server.getUri('scopeshield');
    logger.info('Embedded MongoDB ready');
  }

  mongoose.set('strictQuery', true);
  // A missing index in production is a correctness problem, not a performance tweak.
  mongoose.set('autoIndex', !env.isProd);

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 15000,
    maxPoolSize: env.isProd ? 20 : 5,
    // Compound indexes on optional fields must not silently skip documents.
    autoIndex: !env.isProd,
  });

  logger.info('MongoDB connected', { host: mongoose.connection.host, db: mongoose.connection.name });

  mongoose.connection.on('error', (err) => logger.error('MongoDB connection error', { error: err }));
  mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected'));

  return uri;
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.connection.close();
  if (embeddedServer) {
    await embeddedServer.stop();
    embeddedServer = null;
  }
}

export function isDbConnected(): boolean {
  return mongoose.connection.readyState === 1;
}

/**
 * Multi-document transactions. Standalone deployments (and the embedded dev database)
 * often do not support them, so callers must be able to degrade to sequential writes and
 * say so. `withTransaction` reports which path it took.
 */
export async function withTransaction<T>(
  fn: (session: mongoose.ClientSession | null) => Promise<T>,
): Promise<{ result: T; transactional: boolean }> {
  let session: mongoose.ClientSession | null = null;
  try {
    session = await mongoose.startSession();
    let result: T | undefined;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return { result: result as T, transactional: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Standalone mongod: "Transaction numbers are only allowed on a replica set member or mongos"
    const unsupported =
      message.includes('Transaction numbers are only allowed') ||
      message.includes('replica set') ||
      message.includes('does not support transactions');
    if (unsupported) {
      logger.warn('Transactions unavailable on this deployment; running sequentially', { reason: message });
      const result = await fn(null);
      return { result, transactional: false };
    }
    throw err;
  } finally {
    if (session) await session.endSession();
  }
}
