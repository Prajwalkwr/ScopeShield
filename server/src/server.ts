import { createApp } from './app';
import { env } from './config/env';
import { connectDatabase, disconnectDatabase } from './config/db';
import { storage } from './platform/storage';
import { logger } from './platform/logger';

/**
 * Entrypoint. Boot order matters: the database and the storage driver must both be ready
 * before the port opens, otherwise the first requests would fail in confusing ways.
 * If either cannot start, we exit non-zero rather than serving a broken API.
 */
async function main(): Promise<void> {
  logger.info('boot.start', {
    nodeEnv: env.nodeEnv,
    storageDriver: env.storageDriver,
    mailDriver: env.mailDriver,
    aiProvider: env.aiProvider,
  });

  try {
    const dbLabel = await connectDatabase();
    logger.info('boot.database_connected', { target: dbLabel });

    await storage.ensureReady();
    logger.info('boot.storage_ready', { driver: storage.name });
  } catch (err) {
    logger.error('boot.failed', { error: err instanceof Error ? err.message : String(err) });
    process.exitCode = 1;
    return;
  }

  const app = createApp();
  const server = app.listen(env.port, '0.0.0.0', () => {
    logger.info('boot.listening', { port: env.port, apiPrefix: '/api/v1' });
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('shutdown.begin', { signal });
    server.close(() => logger.info('shutdown.http_closed', {}));
    try {
      await disconnectDatabase();
      logger.info('shutdown.database_closed', {});
    } catch (err) {
      logger.error('shutdown.database_error', { error: String(err) });
    }
    setTimeout(() => process.exit(process.exitCode ?? 0), 250).unref();
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    // Log loudly; do not kill the process for a single rejected promise in a request path.
    logger.error('process.unhandled_rejection', { reason: reason instanceof Error ? reason.message : String(reason) });
  });
  process.on('uncaughtException', (err) => {
    logger.error('process.uncaught_exception', { error: err.message, stack: err.stack });
    process.exitCode = 1;
    void shutdown('uncaughtException');
  });
}

void main();
