import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handler, stripFunctionPrefix } from '../../src/serverless/api';
import { authorized } from '../../src/serverless/worker';
import { testConfig } from '../support/app';
import { signSessionToken } from '../support/tokens';

const ctx = { callbackWaitsForEmptyEventLoop: true } as never;
const event = (path: string, headers: Record<string, string> = {}) => ({
  path,
  httpMethod: 'GET',
  headers: { host: 'touchline.netlify.app', ...headers },
  multiValueHeaders: {},
  queryStringParameters: null,
  multiValueQueryStringParameters: null,
  body: null,
  isBase64Encoded: false,
  requestContext: {},
});

describe('Netlify function handlers', () => {
  const saved = { ...process.env };
  beforeAll(() => {
    // The serverless handler reads process.env like it would on Netlify.
    const c = testConfig();
    Object.assign(process.env, {
      NODE_ENV: 'test',
      DATABASE_URL: c.DATABASE_URL,
      REDIS_URL: c.REDIS_URL,
      STORAGE_DRIVER: 'fs',
      STORAGE_FS_ROOT: c.STORAGE_FS_ROOT,
      CLERK_JWT_KEY: c.CLERK_JWT_KEY,
      CLERK_SECRET_KEY: '',
      CLERK_AUTHORIZED_PARTIES: c.CLERK_AUTHORIZED_PARTIES,
    });
  });
  afterAll(() => {
    process.env = saved;
  });

  it('strips the function prefix from either path form', () => {
    expect(stripFunctionPrefix('/.netlify/functions/api/v1/me')).toBe('/v1/me');
    expect(stripFunctionPrefix('/.netlify/functions/api')).toBe('/');
    expect(stripFunctionPrefix('/.netlify/functions/api?x=1')).toBe('/?x=1');
    expect(stripFunctionPrefix('/v1/matches')).toBe('/v1/matches');
  });

  it('serves public and authenticated routes through the Lambda-style handler', async () => {
    const health = (await handler(event('/healthz'), ctx, () => undefined)) as { statusCode: number; body: string };
    expect(health.statusCode).toBe(200);
    expect(JSON.parse(health.body).status).toBe('ok');

    const viaFunctionPath = (await handler(event('/.netlify/functions/api/v1/competitions'), ctx, () => undefined)) as { statusCode: number; body: string };
    expect(viaFunctionPath.statusCode).toBe(200);

    const anon = (await handler(event('/v1/me'), ctx, () => undefined)) as { statusCode: number; body: string };
    expect(anon.statusCode).toBe(401);
    expect(JSON.parse(anon.body).error.code).toBe('UNAUTHENTICATED');

    const me = (await handler(event('/v1/me', { authorization: `Bearer ${signSessionToken('user_lambda')}` }), ctx, () => undefined)) as { statusCode: number; body: string };
    expect(me.statusCode).toBe(200);
    expect(JSON.parse(me.body).plan.key).toBe('free');
  });

  it('guards the worker trigger with the shared secret', () => {
    expect(authorized({}, undefined)).toBe(true);
    expect(authorized({}, 's3cret')).toBe(false);
    expect(authorized({ 'x-worker-secret': 's3cret' }, 's3cret')).toBe(true);
  });
});
