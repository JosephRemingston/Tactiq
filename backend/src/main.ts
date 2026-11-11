import 'reflect-metadata';
import { type INestApplication, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { type AppConfig, loadConfig } from './config/env';

export function buildOpenApi(app: INestApplication) {
  const doc = new DocumentBuilder()
    .setTitle('Touchline API')
    .setDescription('Fan-first football tactical intelligence. Shared football data is public; /v1/me/* is private to the authenticated user.')
    .setVersion('1')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'Clerk session JWT' })
    .build();
  return SwaggerModule.createDocument(app, doc);
}

/** Shared by main() and the e2e tests so both run the same HTTP pipeline. */
export function configureApp(app: NestExpressApplication, config: AppConfig): void {
  app.useLogger(app.get(Logger));
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.useBodyParser('json', { limit: '256kb' });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.enableShutdownHooks();
  const origins = config.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
  if (origins.length) app.enableCors({ origin: origins, credentials: false, allowedHeaders: ['authorization', 'content-type', 'x-request-id'], exposedHeaders: ['x-request-id', 'x-entitlement-remaining', 'retry-after'] });
  if (config.ENABLE_SWAGGER && config.NODE_ENV !== 'production') {
    SwaggerModule.setup('docs', app, () => buildOpenApi(app), { jsonDocumentUrl: 'docs/openapi.json' });
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(config), { bufferLogs: true, rawBody: true });
  configureApp(app, config);
  await app.listen(config.API_PORT);
  app.get(Logger).log(`Touchline API listening on :${config.API_PORT}`);
}

if (require.main === module) void main();
