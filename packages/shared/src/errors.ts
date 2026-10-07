/**
 * Application error hierarchy.
 *
 * `statusCode` lives here deliberately: it lets every layer (HTTP handler, queue
 * worker, CLI script) translate one error taxonomy consistently instead of
 * re-deriving categories. Domain and service code should throw these errors but must
 * never build HTTP responses from them — that remains the adapter's job.
 *
 * `expose` decides whether the message may be shown to a client. Anything that fails
 * a 5xx check defaults to hidden, so internal failure detail cannot leak by accident.
 */

export interface AppErrorOptions {
  readonly message: string;
  readonly code: string;
  readonly statusCode: number;
  readonly cause?: unknown;
  readonly details?: Readonly<Record<string, unknown>>;
  /** Override whether `message` may be returned to a client. */
  readonly expose?: boolean;
}

export type ErrorSubclassOptions = {
  readonly code?: string;
  readonly cause?: unknown;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly expose?: boolean;
};

export class AppError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly expose: boolean;

  constructor(options: AppErrorOptions) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code;
    this.statusCode = options.statusCode;
    this.details = options.details;
    this.expose = options.expose ?? options.statusCode < 500;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/** Malformed input that reached the application layer. */
export class ValidationError extends AppError {
  constructor(message = 'Validation failed', options: ErrorSubclassOptions = {}) {
    super({
      message,
      code: options.code ?? 'VALIDATION_ERROR',
      statusCode: 400,
      cause: options.cause,
      details: options.details,
      expose: options.expose ?? true,
    });
  }
}

/** No valid authentication was presented. */
export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required', options: ErrorSubclassOptions = {}) {
    super({
      message,
      code: options.code ?? 'UNAUTHORIZED',
      statusCode: 401,
      cause: options.cause,
      details: options.details,
      expose: options.expose ?? true,
    });
  }
}

/** Authenticated but not permitted, including cross-tenant access attempts. */
export class ForbiddenError extends AppError {
  constructor(message = 'Not permitted', options: ErrorSubclassOptions = {}) {
    super({
      message,
      code: options.code ?? 'FORBIDDEN',
      statusCode: 403,
      cause: options.cause,
      details: options.details,
      expose: options.expose ?? true,
    });
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found', options: ErrorSubclassOptions = {}) {
    super({
      message,
      code: options.code ?? 'NOT_FOUND',
      statusCode: 404,
      cause: options.cause,
      details: options.details,
      expose: options.expose ?? true,
    });
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Conflict', options: ErrorSubclassOptions = {}) {
    super({
      message,
      code: options.code ?? 'CONFLICT',
      statusCode: 409,
      cause: options.cause,
      details: options.details,
      expose: options.expose ?? true,
    });
  }
}

export class RateLimitedError extends AppError {
  constructor(message = 'Too many requests', options: ErrorSubclassOptions = {}) {
    super({
      message,
      code: options.code ?? 'RATE_LIMITED',
      statusCode: 429,
      cause: options.cause,
      details: options.details,
      expose: options.expose ?? true,
    });
  }
}

/** A required dependency (database, Redis, provider) is unavailable. */
export class DependencyUnavailableError extends AppError {
  constructor(message = 'Dependency unavailable', options: ErrorSubclassOptions = {}) {
    super({
      message,
      code: options.code ?? 'DEPENDENCY_UNAVAILABLE',
      statusCode: 503,
      cause: options.cause,
      details: options.details,
      expose: options.expose ?? true,
    });
  }
}

/** Invalid or missing configuration. Never exposes detail; always a deploy-time bug. */
export class ConfigurationError extends AppError {
  constructor(message = 'Invalid configuration', options: ErrorSubclassOptions = {}) {
    super({
      message,
      code: options.code ?? 'CONFIGURATION_ERROR',
      statusCode: 500,
      cause: options.cause,
      details: options.details,
      expose: options.expose ?? false,
    });
  }
}

/** Unexpected internal failure. Detail stays server-side. */
export class InternalError extends AppError {
  constructor(message = 'Internal error', options: ErrorSubclassOptions = {}) {
    super({
      message,
      code: options.code ?? 'INTERNAL_ERROR',
      statusCode: 500,
      cause: options.cause,
      details: options.details,
      expose: options.expose ?? false,
    });
  }
}
