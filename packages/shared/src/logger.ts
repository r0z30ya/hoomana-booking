import type { LogLevel, NodeEnvironment } from '@hmn/validation';
import { pino, type Logger, type LoggerOptions } from 'pino';

export interface LoggerConfig {
  /** Service name included on every line, e.g. `hmn-api`. */
  readonly name: string;
  readonly level: LogLevel;
  readonly environment: NodeEnvironment;
}

/**
 * Values that must never reach a log sink.
 *
 * Payment, session and SMS provider credentials will be added here as those
 * integrations land; the redaction list existing from the start means logging a whole
 * request object is safe by default rather than by reviewer diligence.
 */
const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.token',
  '*.secret',
  '*.apiKey',
];

export function createLogger(config: LoggerConfig): Logger {
  const baseOptions: LoggerOptions = {
    name: config.name,
    level: config.level,
    redact: { paths: [...REDACTED_PATHS], remove: true },
  };

  if (config.environment === 'development') {
    // Human-readable output locally. `pino-pretty` is a devDependency and is resolved
    // lazily by the transport, so a production install never loads it.
    return pino({
      ...baseOptions,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss.l',
          ignore: 'pid,hostname',
        },
      },
    });
  }

  return pino(baseOptions);
}
