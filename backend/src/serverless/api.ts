/**
 * Netlify Functions (AWS Lambda compatible) entry for the HTTP API.
 * The Nest app is created once per warm instance and reused across invocations.
 */
import 'reflect-metadata';
import type { Context, Handler } from 'aws-lambda';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import serverless from 'serverless-http';
import { AppModule } from '../app.module';
import { loadConfig } from '../config/env';
import { configureApp } from '../main';

type ServerlessHandler = ReturnType<typeof serverless>;
let ready: Promise<ServerlessHandler> | null = null;

/** Netlify may pass either the public path (/v1/...) or the function path (/.netlify/functions/api/v1/...). */
export function stripFunctionPrefix(url: string): string {
  const stripped = url.replace(/^\/\.netlify\/functions\/api(?=\/|$|\?)/, '');
  return stripped === '' || stripped.startsWith('?') ? `/${stripped}` : stripped;
}

async function bootstrap(): Promise<ServerlessHandler> {
  const config = loadConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(config), { rawBody: true, bufferLogs: true });
  configureApp(app, config);
  await app.init();
  return serverless(app.getHttpAdapter().getInstance(), {
    request: (req: { url?: string }) => {
      req.url = stripFunctionPrefix(req.url ?? '/');
    },
  });
}

export const handler: Handler = async (event: unknown, context: Context) => {
  context.callbackWaitsForEmptyEventLoop = false;
  ready ??= bootstrap().catch((err) => {
    ready = null; // let the next invocation retry a failed cold start
    throw err;
  });
  return (await ready)(event as never, context as never);
};
