import { randomUUID } from 'node:crypto';
import { checkRedis, createLogger, createRedisClient, loadEnvironment } from '@hmn/shared';
import { describe, expect, it } from 'vitest';
import { buildRedisConnectionOptions } from './connection.js';
import {
  NOOP_JOB_NAME,
  createSystemQueue,
  createSystemWorker,
  processSystemJob,
  type SystemJobResult,
} from './queues.js';

const environment = loadEnvironment();

const logger = createLogger({
  name: 'hmn-worker-test',
  level: 'silent',
  environment: 'test',
});

describe('processSystemJob', () => {
  it('reports the job name it handled', () => {
    const result = processSystemJob({ id: 'job-1', name: NOOP_JOB_NAME }, logger);

    expect(result.jobName).toBe(NOOP_JOB_NAME);
  });

  it('stamps a parseable completion time', () => {
    const result = processSystemJob({ name: NOOP_JOB_NAME }, logger);

    expect(Number.isNaN(Date.parse(result.handledAt))).toBe(false);
  });

  it('does not require a job id', () => {
    expect(processSystemJob({ name: NOOP_JOB_NAME }, logger)).toBeDefined();
  });
});

describe('system queue round trip', () => {
  it('carries a job from enqueue to completion through the real Redis', async ({ skip }) => {
    // Created here rather than at module scope so a skipped run never leaves a
    // half-open client behind.
    const probeClient = createRedisClient({ url: environment.REDIS_URL });
    const probe = await checkRedis(probeClient, 3_000);

    if (probe.status !== 'ok') {
      probeClient.disconnect();
      skip(`Redis unreachable (${probe.error ?? 'unknown'}). Run \`npm run infra:up\`.`);
      return;
    }

    // A queue name unique to this run. Using the production queue name would let a
    // concurrently running worker consume the job, so the assertion below would time
    // out even though the queue itself is healthy.
    const queueName = `system-test-${randomUUID()}`;

    const connection = buildRedisConnectionOptions(environment.REDIS_URL);
    const queue = createSystemQueue(connection, queueName);
    const worker = createSystemWorker(connection, logger, queueName);

    try {
      await worker.waitUntilReady();

      const processed = new Promise<SystemJobResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('job was not processed within 10s'));
        }, 10_000);

        worker.once('completed', (job) => {
          clearTimeout(timer);
          resolve(job.returnvalue);
        });

        worker.once('failed', (_job, error) => {
          clearTimeout(timer);
          reject(error);
        });
      });

      const job = await queue.add(NOOP_JOB_NAME, {});
      const result = await processed;

      expect(result.jobName).toBe(NOOP_JOB_NAME);
      expect(job.id).toBeDefined();
    } finally {
      await worker.close();
      // Safe to wipe: this queue name exists only for this test run.
      await queue.obliterate({ force: true });
      await queue.close();
      probeClient.disconnect();
    }
  }, 30_000);
});
