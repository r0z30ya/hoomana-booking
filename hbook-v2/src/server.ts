/**
 * hbook — server bootstrap with graceful shutdown.
 * Also runs the persistent webhook delivery worker (outbox consumer).
 */
import { buildApp } from './app';
import { config } from './config';
import { prisma } from './lib/prisma';
import { startWebhookWorker, stopWebhookWorker } from './lib/webhooks';

async function main(): Promise<void> {
  const app = await buildApp();

  startWebhookWorker();
  app.log.info('webhook delivery worker started');

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
      await stopWebhookWorker(); // drain in-flight deliveries (bounded)
      await prisma.$disconnect();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: config.port, host: config.host });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[hbook] fatal:', err);
  process.exit(1);
});
