import { validateRuntimeDatabaseRole } from '@hmn/db';
import {
  checkRedis,
  createLogger,
  createRedisClient,
  loadEnvironment,
  withTimeout,
} from '@hmn/shared';
import { buildRedisConnectionOptions } from './connection.js';
import { SYSTEM_QUEUE_NAME, createSystemQueue, createSystemWorker } from './queues.js';

async function main(): Promise<void> {
  const environment = loadEnvironment();

  // ADR-0003 D7: refuse to boot on migration credentials or a role that can
  // bypass tenant isolation, even though this process does not query the
  // database yet — configuration must never silently carry privileged roles.
  await validateRuntimeDatabaseRole({ connectionString: environment.DATABASE_APP_URL });

  const logger = createLogger({
    name: 'hmn-worker',
    level: environment.LOG_LEVEL,
    environment: environment.NODE_ENV,
  });

  const redis = createRedisClient({
    url: environment.REDIS_URL,
    onError: (error) => {
      logger.warn({ err: error }, 'redis connection error');
    },
  });

  // BullMQ manages its own connections from these options rather than sharing the
  // probe client above, because it needs `maxRetriesPerRequest: null`.
  const connection = buildRedisConnectionOptions(environment.REDIS_URL);

  const queue = createSystemQueue(connection);
  const worker = createSystemWorker(connection, logger);

  worker.on('failed', (job, error) => {
    logger.error({ err: error, jobId: job?.id, jobName: job?.name }, 'system job failed');
  });

  worker.on('error', (error) => {
    logger.error({ err: error }, 'worker error');
  });

  const probe = await checkRedis(redis, 3_000);

  if (probe.status === 'ok') {
    logger.info({ latencyMs: probe.latencyMs }, 'redis connection verified');
  } else {
    // Not fatal: BullMQ retries in the background, so the worker stays up and recovers
    // when Redis returns. Reported at warn so it is visible rather than silent.
    logger.warn(
      { error: probe.error },
      'redis not reachable at startup; the worker will keep retrying',
    );
  }

  try {
    await withTimeout(worker.waitUntilReady(), 10_000, 'bullmq-worker');
    logger.info({ queue: SYSTEM_QUEUE_NAME }, 'worker ready');
  } catch (error) {
    logger.warn(
      { err: error },
      'worker did not become ready within 10s; it will keep retrying in the background',
    );
  }

  let shuttingDown = false;

  async function shutdown(signal: NodeJS.Signals): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, 'shutting down worker');

    try {
      // Stop accepting jobs first, then release the queue and the probe connection.
      await worker.close();
      await queue.close();
      redis.disconnect();
      logger.info('worker stopped');
    } catch (error) {
      logger.error({ err: error }, 'error during shutdown');
      process.exitCode = 1;
    }
  }

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Fatal startup error: ${message}\n`);
  process.exit(1);
}
