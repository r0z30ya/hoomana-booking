import { Queue, Worker } from 'bullmq';
import type { Logger } from 'pino';
import type { RedisConnectionConfig } from './connection.js';

/**
 * The system queue exists to prove that the Redis + BullMQ path works end to end.
 *
 * It carries no business meaning: SMS campaigns, accounting sync and scheduling
 * reconciliation each get their own queue in the phase that introduces them, with
 * their own retry, concurrency and idempotency requirements.
 */
export const SYSTEM_QUEUE_NAME = 'system';
export const NOOP_JOB_NAME = 'noop';

/** Namespaces queue keys so this deployment can share a Redis instance safely. */
export const QUEUE_KEY_PREFIX = 'hmn';

export interface SystemJobResult {
  readonly jobName: string;
  readonly handledAt: string;
}

/**
 * The minimal description a processor needs.
 *
 * Taking a narrow shape rather than a BullMQ `Job` keeps processing logic testable
 * without a Redis connection and prevents queue internals from spreading through the
 * codebase.
 */
export interface JobDescriptor {
  readonly id?: string | undefined;
  readonly name: string;
}

/**
 * Synchronous on purpose: it performs no I/O, and a synchronous function is testable
 * without awaiting anything. The queue adapter lifts the value into a promise below.
 */
export function processSystemJob(job: JobDescriptor, logger: Logger): SystemJobResult {
  logger.debug({ jobId: job.id, jobName: job.name }, 'system job processed');

  return { jobName: job.name, handledAt: new Date().toISOString() };
}

/**
 * The queue name is overridable so tests can run against a queue of their own.
 *
 * This matters: a live worker consumes from the production queue name, so a test that
 * used the same name would have its job taken by that worker and never observe the
 * completion. Tests must never share a queue with a running consumer.
 */
export function createSystemQueue(
  connection: RedisConnectionConfig,
  queueName: string = SYSTEM_QUEUE_NAME,
): Queue {
  return new Queue(queueName, { connection, prefix: QUEUE_KEY_PREFIX });
}

export function createSystemWorker(
  connection: RedisConnectionConfig,
  logger: Logger,
  queueName: string = SYSTEM_QUEUE_NAME,
): Worker<unknown, SystemJobResult> {
  return new Worker<unknown, SystemJobResult>(
    queueName,
    // BullMQ's Processor contract is Promise-returning. Wrapping the value here keeps
    // the processing logic synchronous rather than making it async for no reason.
    (job) => Promise.resolve(processSystemJob({ id: job.id, name: job.name }, logger)),
    { connection, prefix: QUEUE_KEY_PREFIX, concurrency: 1 },
  );
}
