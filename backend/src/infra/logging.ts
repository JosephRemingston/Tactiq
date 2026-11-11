import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Params } from 'nestjs-pino';
import type { AppConfig } from '../config/env';

/** pino-http config: request ids double as trace ids in the error envelope; auth headers are redacted. */
export function loggerParams(config: AppConfig): Params {
  return {
    pinoHttp: {
      level: config.NODE_ENV === 'test' ? 'silent' : config.LOG_LEVEL,
      // pino-pretty is a dev dependency: only in an interactive terminal, never inside Lambda/Netlify Functions.
      transport:
        config.NODE_ENV === 'development' && process.stdout.isTTY && !process.env.AWS_LAMBDA_FUNCTION_NAME ? { target: 'pino-pretty', options: { singleLine: true } } : undefined,
      genReqId: (req: IncomingMessage, res: ServerResponse) => {
        const incoming = req.headers['x-request-id'];
        const id = typeof incoming === 'string' && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
      redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["svix-signature"]'],
      autoLogging: { ignore: (req: IncomingMessage) => req.url === '/healthz' || req.url === '/readyz' },
    },
  };
}
