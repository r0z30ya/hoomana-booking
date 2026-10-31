import { Redis } from 'ioredis';
import { probeDependency, type HealthProbeResult } from './health.js';

export interface RedisClientConfig {
  readonly url: string;
  /** Namespaces this application's keys when multiple apps share one Redis instance. */
  readonly keyPrefix?: string;
  /** Called for connection-level errors so they are logged rather than swallowed. */
  readonly onError?: (error: Error) => void;
}

export function createRedisClient(config: RedisClientConfig): Redis {
  const client = new Redis(config.url, {
    // Connect on first command so that process startup never blocks on Redis, while
    // health probes still exercise a real connection.
    lazyConnect: true,
    // Bounded retries: a request path must fail fast rather than queue indefinitely.
    maxRetriesPerRequest: 2,
    enableReadyCheck: true,
    connectionName: 'hmn',
    ...(config.keyPrefix === undefined ? {} : { keyPrefix: config.keyPrefix }),
  });

  // ioredis emits 'error' on reconnect attempts. Without a listener an EventEmitter
  // 'error' event would crash the process, so the caller must decide how to surface it.
  if (config.onError !== undefined) {
    client.on('error', config.onError);
  }

  return client;
}

export async function checkRedis(client: Redis, timeoutMs = 2_000): Promise<HealthProbeResult> {
  return probeDependency('redis', () => client.ping(), timeoutMs);
}
