const DEFAULT_REDIS_PORT = 6379;

/**
 * Build BullMQ connection options from a Redis URL.
 *
 * BullMQ is given connection *options* rather than a client instance because it
 * manages its own connections: it opens separate clients for producing, consuming and
 * blocking reads, and requires `maxRetriesPerRequest: null` on all of them so that
 * queued work is never abandoned when a command hits a retry ceiling.
 *
 * This lives in the worker rather than `@hmn/shared` on purpose. BullMQ's option
 * contract is a queue concern, and `@hmn/shared` must not depend on the queue library —
 * that keeps the generic Redis client factory reusable and keeps this app free to
 * change its queue technology.
 *
 * The return type is intentionally inferred rather than annotated: BullMQ declares its
 * own structurally-permissive connection options type, and annotating here with a
 * library type would either force a queue dependency into shared code or a
 * hand-maintained duplicate of BullMQ's contract.
 */
export function buildRedisConnectionOptions(redisUrl: string) {
  const parsed = new URL(redisUrl);
  const database = parsed.pathname.replace(/^\//, '');

  return {
    host: parsed.hostname,
    port: parsed.port === '' ? DEFAULT_REDIS_PORT : Number(parsed.port),
    maxRetriesPerRequest: null,
    ...(parsed.username === '' ? {} : { username: decodeURIComponent(parsed.username) }),
    ...(parsed.password === '' ? {} : { password: decodeURIComponent(parsed.password) }),
    ...(database === '' ? {} : { db: Number(database) }),
    ...(parsed.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}

export type RedisConnectionConfig = ReturnType<typeof buildRedisConnectionOptions>;
