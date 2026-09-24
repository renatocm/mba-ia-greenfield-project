import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppWorkerModule } from './app.worker';

async function bootstrap() {
  process.env.SERVICE_NAME = 'video-worker';

  const app = await NestFactory.create(AppWorkerModule);
  app.enableShutdownHooks();

  const port = 3001;
  await app.listen(port);

  Logger.log(`Video worker listening on port ${port}`, 'VideoWorkerBootstrap');
}

void bootstrap();
