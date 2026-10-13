import cookie from '@fastify/cookie';
import type { PrismaClient } from '@hmn/db';
import { InternalError, isAppError, type HealthProbeResult, type HealthStatus } from '@hmn/shared';
import Fastify, { type FastifyError, type FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { authRoutes } from './auth/auth-routes.js';

export interface HealthChecks {
  readonly database: () => Promise<HealthProbeResult>;
  readonly redis: () => Promise<HealthProbeResult>;
}

/** Auth wiring (ADR-0005). When omitted, the API exposes no auth routes. */
export interface AuthOptions {
  readonly client: PrismaClient;
  /** Development servers may drop the cookie's Secure flag so plain HTTP works. */
  readonly cookieSecure: boolean;
  /** Defaults to `request.ip`; production supplies a proxy-aware implementation. */
  readonly clientIp?: (request: FastifyRequest) => string;
  /** Injected SMS sender; without it a code is only revealed outside production. */
  readonly otpSender?: ((mobile: string, code: string) => Promise<void>) | undefined;
  /** True outside production: the OTP comes back in the response for local testing. */
  readonly exposeOtpInResponse?: boolean | undefined;
}

export interface ServerOptions {
  /** Injected so tests can silence logs and production can tune levels. */
  readonly logger: Logger;
  readonly health: HealthChecks;
  readonly auth?: AuthOptions;
  /**
   * Whether dependency error text may appear in health responses. Enabled outside
   * production because the message ("connection refused", "password authentication
   * failed") is what makes local debugging possible; suppressed in production because
   * it describes internal topology.
   */
  readonly exposeDependencyErrors: boolean;
}

interface HealthResponseBody {
  readonly status: HealthStatus;
  readonly dependency: string;
  readonly latencyMs: number;
  readonly error?: string;
}

interface ErrorResponseBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: Readonly<Record<string, unknown>>;
  };
}

function hiddenMessage(statusCode: number): string {
  return statusCode >= 500 ? 'Internal server error' : 'Request failed';
}

function toHealthBody(result: HealthProbeResult, options: ServerOptions): HealthResponseBody {
  const body: HealthResponseBody = {
    status: result.status,
    dependency: result.dependency,
    latencyMs: result.latencyMs,
  };

  if (result.status === 'error' && options.exposeDependencyErrors && result.error !== undefined) {
    return { ...body, error: result.error };
  }

  return body;
}

/**
 * Build the API server.
 *
 * A factory rather than a module-level instance so tests can inject dependencies and
 * build isolated servers, and so the process entry point owns startup and shutdown.
 *
 * The return type is deliberately inferred: passing a pino logger makes Fastify carry
 * that concrete logger type through the instance, so an explicit `FastifyInstance`
 * annotation would widen it incorrectly and lose `request.log` typing.
 */
export function buildServer(options: ServerOptions) {
  const app = Fastify({ loggerInstance: options.logger });

  if (options.auth !== undefined) {
    // Registered synchronously on purpose: Fastify loads plugins on ready(), which
    // `inject()` and `listen()` trigger, so buildServer stays a plain factory.
    void app.register(cookie);
    void app.register(authRoutes, {
      client: options.auth.client,
      cookieSecure: options.auth.cookieSecure,
      clientIp: options.auth.clientIp ?? ((request) => request.ip),
      ...(options.auth.otpSender === undefined ? {} : { otpSender: options.auth.otpSender }),
      ...(options.auth.exposeOtpInResponse === undefined
        ? {}
        : { exposeOtpInResponse: options.auth.exposeOtpInResponse }),
    });
  }

  // Liveness: proves the process is up. Deliberately touches no dependency, so a
  // database outage must not cause an orchestrator to restart a healthy API process.
  app.get('/health', (): { status: 'ok' } => ({ status: 'ok' }));

  // Readiness: each dependency reports its own state so a failure is attributable.
  app.get('/health/db', async (_request, reply) => {
    const result = await options.health.database();

    return reply.code(result.status === 'ok' ? 200 : 503).send(toHealthBody(result, options));
  });

  app.get('/health/redis', async (_request, reply) => {
    const result = await options.health.redis();

    return reply.code(result.status === 'ok' ? 200 : 503).send(toHealthBody(result, options));
  });

  app.setNotFoundHandler((request, reply) => {
    const body: ErrorResponseBody = {
      error: { code: 'NOT_FOUND', message: `Cannot ${request.method} ${request.url}` },
    };

    return reply.code(404).send(body);
  });

  // Annotated explicitly: Fastify's generic error handler cannot infer the error type
  // from an untyped callback parameter, and `unknown` would block the narrowing below.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (isAppError(error)) {
      request.log.warn({ err: error, code: error.code }, 'request failed');

      const body: ErrorResponseBody = {
        error: {
          code: error.code,
          message: error.expose ? error.message : hiddenMessage(error.statusCode),
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      };

      return reply.code(error.statusCode).send(body);
    }

    if (error.validation !== undefined) {
      request.log.warn({ err: error }, 'request validation failed');

      const body: ErrorResponseBody = {
        error: { code: 'VALIDATION_ERROR', message: error.message },
      };

      return reply.code(400).send(body);
    }

    // Fastify's own client errors (unsupported media type, malformed JSON, …) carry a
    // 4xx status. Surface that status instead of collapsing every unknown error into a
    // 500 — a client mistake must not look like a server outage.
    if (typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500) {
      request.log.warn({ err: error }, 'request rejected');

      const body: ErrorResponseBody = {
        error: { code: error.code ?? 'BAD_REQUEST', message: error.message },
      };

      return reply.code(error.statusCode).send(body);
    }

    // Unknown failure: log the real error, return nothing that could leak internals.
    request.log.error({ err: error }, 'unhandled request error');

    const fallback = new InternalError();
    const body: ErrorResponseBody = {
      error: { code: fallback.code, message: fallback.message },
    };

    return reply.code(500).send(body);
  });

  return app;
}
