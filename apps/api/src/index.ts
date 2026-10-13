import { checkDatabase, createDatabaseClient, validateRuntimeDatabaseRole } from '@hmn/db';
import { createSmsProviderFromEnvironment, isSmsConfigured } from '@hmn/integrations';
import { checkRedis, createLogger, createRedisClient, loadEnvironment } from '@hmn/shared';
import { buildServer } from './server.js';

async function main(): Promise<void> {
  const environment = loadEnvironment();

  const logger = createLogger({
    name: 'hmn-api',
    level: environment.LOG_LEVEL,
    environment: environment.NODE_ENV,
  });

  // ADR-0003 D7: refuse to boot on migration credentials or a role that can
  // bypass tenant isolation. Must run BEFORE the client is constructed.
  await validateRuntimeDatabaseRole({ connectionString: environment.DATABASE_APP_URL });

  const database = createDatabaseClient({ connectionString: environment.DATABASE_APP_URL });
  const smsProvider = isSmsConfigured(environment)
    ? createSmsProviderFromEnvironment(environment)
    : undefined;
  const redis = createRedisClient({
    url: environment.REDIS_URL,
    onError: (error) => {
      logger.warn({ err: error }, 'redis connection error');
    },
  });

  const server = buildServer({
    logger,
    exposeDependencyErrors: environment.NODE_ENV !== 'production',
    health: {
      database: () => checkDatabase(database),
      redis: () => checkRedis(redis),
    },
    auth: {
      client: database,
      cookieSecure: environment.NODE_ENV !== 'development',
      // Without a wired SMS provider the code is only revealed outside production, so
      // local runs stay testable and a production deployment fails loudly instead.
      exposeOtpInResponse: environment.NODE_ENV !== 'production',
      ...(smsProvider === undefined
        ? {}
        : {
            otpSender: async (mobile: string, code: string) => {
              await smsProvider.sendOtp({ to: mobile, code });
            },
          }),
    },
  });

  let shuttingDown = false;

  async function shutdown(signal: NodeJS.Signals): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, 'shutting down api');

    try {
      await server.close();
      await database.$disconnect();
      redis.disconnect();
      logger.info('api stopped');
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

  await server.listen({ host: environment.API_HOST, port: environment.API_PORT });

  logger.info(
    { host: environment.API_HOST, port: environment.API_PORT, environment: environment.NODE_ENV },
    'api listening',
  );
}

try {
  await main();
} catch (error) {
  // The logger may not exist yet if configuration failed, so report to stderr directly.
  // Writing to stderr rather than console keeps this consistent with the logging rule.
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Fatal startup error: ${message}\n`);
  process.exit(1);
}
