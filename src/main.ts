
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import AppModule from './AppModule';
import LinearTrackerBot from './services/LinearBotService';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    rawBody: true,
  });

  app.enableShutdownHooks();

  // Start HTTP server first
  await app.listen(process.env.PORT ?? 4000, '0.0.0.0');
  console.log(`Application is running on: ${await app.getUrl()}`);

  

  // Launch Telegram bot asynchronously (polling)
  const botService = app.get(LinearTrackerBot); // get DI instance
  setImmediate(async () => {
    try {
      await botService.launchBot(); // this calls bot.launch() inside
      console.log('Telegram bot launched successfully.');
    } catch (err) {
      console.error('Failed to launch Telegram bot', err);
    }
  });
  // Graceful shutdown
  const gracefulShutdown = (signal: string) => {
    console.log(`Received ${signal}, shutting down gracefully...`);
    app
      .close()
      .then(() => {
        console.log('Application closed successfully');
        process.exit(0);
      })
      .catch((error) => {
        console.error('Error during shutdown:', error);
        process.exit(1);
      });
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

bootstrap().catch((error) => {
  console.error('Failed to start application:', error);
  console.error('Bootstrap failed', error);
  process.exit(1);
});
// force redeploy Thu Jan  8 18:24:16 CET 2026
