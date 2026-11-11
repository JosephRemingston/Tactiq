/**
 * Writes openapi.json from the running Nest app definition (no database or Redis connections are used).
 *   pnpm openapi:export
 * The Android client can generate its API layer from this file.
 */
import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { loadConfig } from '../src/config/env';
import { buildOpenApi, configureApp } from '../src/main';

async function main() {
  const config = loadConfig({ NODE_ENV: 'test', STORAGE_DRIVER: 'fs', LOG_LEVEL: 'silent' });
  const app = await NestFactory.create(AppModule.register(config), { logger: false, abortOnError: false });
  configureApp(app as never, { ...config, ENABLE_SWAGGER: false });
  await app.init();
  const doc = buildOpenApi(app);
  writeFileSync(join(__dirname, '..', 'openapi.json'), `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`openapi.json written: ${Object.keys(doc.paths).length} paths`);
  await app.close();
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
