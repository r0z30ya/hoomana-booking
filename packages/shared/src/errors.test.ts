import { describe, expect, it } from 'vitest';
import {
  AppError,
  ConfigurationError,
  ConflictError,
  DependencyUnavailableError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  RateLimitedError,
  UnauthorizedError,
  ValidationError,
  isAppError,
} from './errors.js';

describe('error taxonomy', () => {
  it.each([
    [ValidationError, 400],
    [UnauthorizedError, 401],
    [ForbiddenError, 403],
    [NotFoundError, 404],
    [ConflictError, 409],
    [RateLimitedError, 429],
    [DependencyUnavailableError, 503],
    [ConfigurationError, 500],
    [InternalError, 500],
  ])('%s carries the expected status code', (ErrorType, expectedStatus) => {
    const error = new ErrorType('message');

    expect(error).toBeInstanceOf(AppError);
    expect(error).toBeInstanceOf(Error);
    expect(error.statusCode).toBe(expectedStatus);
    expect(error.message).toBe('message');
  });

  it('hides 5xx messages from clients by default', () => {
    expect(new InternalError('stack detail').expose).toBe(false);
    expect(new ConfigurationError('env detail').expose).toBe(false);
  });

  it('exposes 4xx messages by default', () => {
    expect(new ValidationError('bad input').expose).toBe(true);
    expect(new NotFoundError('no such patient').expose).toBe(true);
    expect(new ForbiddenError('cross-tenant access denied').expose).toBe(true);
  });

  it('allows exposure to be overridden explicitly', () => {
    expect(new InternalError('safe summary', { expose: true }).expose).toBe(true);
    expect(new ForbiddenError('hidden', { expose: false }).expose).toBe(false);
  });

  it('names subclasses after themselves for readable logs', () => {
    expect(new NotFoundError().name).toBe('NotFoundError');
    expect(new ValidationError().name).toBe('ValidationError');
  });

  it('preserves the original cause for internal diagnosis', () => {
    const rootCause = new Error('connection reset');
    const wrapped = new DependencyUnavailableError('database unavailable', { cause: rootCause });

    expect(wrapped.cause).toBe(rootCause);
  });

  it('carries structured details when supplied', () => {
    const error = new ValidationError('invalid body', {
      details: { field: 'email' },
      code: 'INVALID_BODY',
    });

    expect(error.code).toBe('INVALID_BODY');
    expect(error.details).toEqual({ field: 'email' });
  });

  it('identifies AppError instances and rejects everything else', () => {
    expect(isAppError(new ConflictError())).toBe(true);
    expect(isAppError(new Error('plain'))).toBe(false);
    expect(isAppError('not an error')).toBe(false);
    expect(isAppError(undefined)).toBe(false);
  });
});
